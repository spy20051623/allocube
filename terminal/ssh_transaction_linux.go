package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

type SSHJournal struct {
	Version      int               `json:"version"`
	ID           string            `json:"id"`
	Phase        string            `json:"phase"`
	Services     []SSHService      `json:"services"`
	Files        []SSHFilePlan     `json:"files"`
	Dependencies map[string][]byte `json:"dependencies"`
	Error        string            `json:"error,omitempty"`
}

func sshJournalPath(c Config) string { return filepath.Join(c.StateDir, "ssh-operation.json") }
func readSSHJournal(c Config) (*SSHJournal, error) {
	data, err := safeRead(sshJournalPath(c))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if err = trustedPath(sshJournalPath(c)); err != nil {
		return nil, err
	}
	var j SSHJournal
	if err = json.Unmarshal(data, &j); err != nil {
		return nil, err
	}
	if j.Version != 1 || j.ID == "" || len(j.Files) == 0 || len(j.Services) == 0 {
		return nil, errors.New("invalid SSH operation journal; inspect ssh-operation.json before proceeding")
	}
	return &j, nil
}
func unfinishedSSH(j *SSHJournal) bool {
	return j != nil && j.Phase != "complete" && j.Phase != "restored"
}
func sshLock(c Config) (func(), error) {
	f, err := os.OpenFile(filepath.Join(c.StateDir, "sync.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another sync or SSH change is running; retry after it finishes")
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}
func recoveryCommand(c Config) string {
	path := c.ConfigPath
	if path == "" {
		path = "/etc/allocube-terminal/config.json"
	}
	return terminalCommand(path, "recover-ssh")
}

func configureSSH(c Config) error {
	if _, err := os.Stat(filepath.Join(c.StateDir, "sync-paused")); err == nil {
		fmt.Println("[SKIP] Synchronization is paused; files unchanged.")
		return nil
	}
	unlock, err := sshLock(c)
	if err != nil {
		return err
	}
	j, err := readSSHJournal(c)
	unlock()
	if err != nil {
		return err
	}
	if unfinishedSSH(j) {
		return fmt.Errorf("unfinished SSH operation %s; next: %s", j.ID, recoveryCommand(c))
	}
	plan, err := prepareSSHPlan(c)
	if err != nil {
		return err
	}
	defer plan.close()
	ready := checkSSHInventory(c, plan.Services) == nil
	for _, f := range plan.Files {
		if !bytes.Equal(f.Before, f.After) {
			ready = false
		}
	}
	if ready {
		fmt.Println("[OK] All SSH services are already configured.")
		return nil
	}
	if len(plan.Targets) == 0 && len(plan.Restoring) == 0 {
		fmt.Println("[SKIP] No eligible accounts; SSH files unchanged.")
		return nil
	}
	preview, err := fetchPlanKeys(c, plan.Targets)
	if err != nil {
		return fmt.Errorf("key preview failed; SSH and key files unchanged: %w", err)
	}
	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		return errors.New("open an interactive SSH session and rerun configure-ssh to confirm; files unchanged")
	}
	defer tty.Close()
	fmt.Fprintf(tty, "[CONFIRM] Configure %d SSH services (%d files):\n", len(plan.Services), len(plan.Files))
	for _, s := range plan.Services {
		fmt.Fprintf(tty, "  %s | %s | %s\n", s.ID, s.Config, s.Listeners)
	}
	fmt.Fprintln(tty, "Managed accounts: Allocube keys only; SSH passwords disabled.")
	for _, a := range plan.Targets {
		note := ""
		if len(preview[a.Name]) == 0 {
			note = " [NO KEYS: SSH LOGIN DENIED]"
		}
		fmt.Fprintf(tty, "  %s%s\n", a.Name, note)
	}
	for _, a := range plan.Restoring {
		fmt.Fprintf(tty, "  %s [EXCLUDED: RESTORE ORIGINAL SSH POLICY]\n", a.Name)
	}
	fmt.Fprint(tty, "Root and other unmanaged accounts stay unchanged. Keep your recovery session open.\nType yes to apply: ")
	answer, e := bufio.NewReader(tty).ReadString('\n')
	if e != nil || strings.TrimSpace(answer) != "yes" {
		return errors.New("cancelled; SSH and key files unchanged")
	}
	// No lock is held while waiting for the administrator.
	unlock, err = sshLock(c)
	if err != nil {
		return err
	}
	defer unlock()
	j, err = readSSHJournal(c)
	if err != nil {
		return err
	}
	if unfinishedSSH(j) {
		return fmt.Errorf("unfinished SSH operation; next: %s", recoveryCommand(c))
	}
	if err = plan.unchanged(c); err != nil {
		return err
	}
	latest, err := fetchPlanKeys(c, plan.Targets)
	if err != nil {
		return fmt.Errorf("key recheck failed; files unchanged: %w", err)
	}
	for name, keys := range latest {
		if len(keys) == 0 && len(preview[name]) > 0 {
			return fmt.Errorf("%s now has no keys; files unchanged. Rerun configure-ssh to confirm the updated warning", name)
		}
	}
	if err = plan.unchanged(c); err != nil {
		return err
	}
	if err = validatePlanBindings(c, plan.Targets); err != nil {
		return err
	}
	j = &SSHJournal{Version: 1, ID: time.Now().UTC().Format("20060102T150405.000000000"), Phase: "prepared", Services: plan.Services, Files: plan.Files, Dependencies: map[string][]byte{}}
	for _, f := range plan.Files {
		for path, data := range f.Snapshot {
			j.Dependencies[path] = data
		}
	}
	encoded, err := json.Marshal(j)
	if err != nil {
		return err
	}
	if len(encoded) > 800*1024 {
		return errors.New("SSH recovery snapshot exceeds the safe journal limit; reduce the include graph before retrying; files unchanged")
	}
	// Keep completed historical records; exactly one unfinished operation is allowed.
	if previous, e := safeRead(sshJournalPath(c)); e == nil {
		if e = atomicWrite(filepath.Join(c.StateDir, "ssh-history-"+j.ID+".json"), previous, 0600); e != nil {
			return e
		}
	}
	if err = writeJSON(sshJournalPath(c), j, 0600); err != nil {
		return err
	}
	fail := func(cause error) error {
		j.Error = cause.Error()
		_ = writeJSON(sshJournalPath(c), j, 0600)
		if e := restoreSSHJournal(c, j); e != nil {
			return fmt.Errorf("%v\nState: recovery needed (%v). Next: %s", cause, e, recoveryCommand(c))
		}
		return fmt.Errorf("%v\nState: original SSH configurations restored; latest key changes retained. Fix the cause and rerun configure-ssh", cause)
	}
	j.Phase = "writing-keys"
	if err = writeJSON(sshJournalPath(c), j, 0600); err != nil {
		return fail(err)
	}
	if err = applyPlanKeys(c, plan.Targets, latest); err != nil {
		return fail(err)
	}
	if err = plan.unchanged(c); err != nil {
		return fail(err)
	}
	j.Phase = "writing-configs"
	if err = writeJSON(sshJournalPath(c), j, 0600); err != nil {
		return fail(err)
	}
	for _, f := range plan.Files {
		if bytes.Equal(f.Before, f.After) {
			continue
		}
		if err = compareSSHFile(f.Path, f.Before); err != nil {
			return fail(err)
		}
		if err = atomicWrite(f.Path, f.After, f.Mode); err != nil {
			return fail(err)
		}
	}
	j.Phase = "reloading"
	if err = writeJSON(sshJournalPath(c), j, 0600); err != nil {
		return fail(err)
	}
	for _, s := range plan.Services {
		if _, err = serviceCommand(s, s.Config, "-t"); err != nil {
			return fail(err)
		}
		if err = reloadSSHService(s); err != nil {
			return fail(err)
		}
	}
	current, err := discoverSSHServices()
	if err != nil {
		return fail(err)
	}
	if !sameServices(plan.Services, current) {
		return fail(errors.New("SSH service topology changed while applying configuration"))
	}
	for _, s := range current {
		for _, a := range plan.Targets {
			settings, e := serviceSettings(s, s.Config, a)
			if e != nil {
				return fail(e)
			}
			if e = checkSSHPolicy(c, settings); e != nil {
				return fail(fmt.Errorf("%s / %s: %w", s.ID, a.Name, e))
			}
		}
	}
	if err = saveSSHInventory(c, current); err != nil {
		return fail(err)
	}
	j.Phase = "complete"
	if err = writeJSON(sshJournalPath(c), j, 0600); err != nil {
		return fail(err)
	}
	fmt.Fprintf(tty, "[OK] %d SSH services configured and reloaded.\n", len(current))
	return nil
}

func compareSSHFile(path string, expected []byte) error {
	if err := trustedPath(path); err != nil {
		return err
	}
	current, err := safeRead(path)
	if err != nil {
		return err
	}
	if !bytes.Equal(current, expected) {
		return fmt.Errorf("%s changed outside Allocube; it was not overwritten", path)
	}
	return nil
}
func restoreSSHJournal(c Config, j *SSHJournal) error {
	// Validate all paths and dependencies before restoring any file. Never restore
	// keys: doing so could bring back a key already revoked on the platform.
	roots := map[string]bool{}
	for _, f := range j.Files {
		roots[f.Path] = true
	}
	for path, data := range j.Dependencies {
		if !roots[path] {
			if err := compareSSHFile(path, data); err != nil {
				return err
			}
		}
	}
	for _, f := range j.Files {
		if err := trustedPath(f.Path); err != nil {
			return err
		}
		now, err := safeRead(f.Path)
		if err != nil {
			return err
		}
		if !bytes.Equal(now, f.Before) && !bytes.Equal(now, f.After) {
			return fmt.Errorf("%s was edited externally; retained. Compare with before/after in %s, restore the intended content, then retry recover-ssh", f.Path, sshJournalPath(c))
		}
	}
	current, err := discoverSSHServices()
	if err != nil {
		return err
	}
	if !sameServices(current, j.Services) {
		return errors.New("service topology differs from the operation; restore the recorded service ExecStart/config paths before retrying recover-ssh")
	}
	j.Services = current // PIDs are deliberately not persisted across invocations.
	for _, f := range j.Files {
		temp, err := os.CreateTemp(c.StateDir, ".sshd-recovery-")
		if err != nil {
			return err
		}
		path := temp.Name()
		temp.Close()
		err = atomicWrite(path, f.Before, 0600)
		if err == nil {
			for _, s := range j.Services {
				if s.Config == f.Path {
					if _, err = serviceCommand(s, path, "-t"); err != nil {
						break
					}
				}
			}
		}
		os.Remove(path)
		if err != nil {
			return err
		}
	}
	j.Phase = "restoring"
	if err = writeJSON(sshJournalPath(c), j, 0600); err != nil {
		return err
	}
	for _, f := range j.Files {
		now, err := safeRead(f.Path)
		if err != nil {
			return err
		}
		if bytes.Equal(now, f.Before) {
			continue
		}
		if err = compareSSHFile(f.Path, f.After); err != nil {
			return err
		}
		if err = atomicWrite(f.Path, f.Before, f.Mode); err != nil {
			return err
		}
	}
	var failures []error
	for _, s := range j.Services {
		if e := reloadSSHService(s); e != nil {
			failures = append(failures, fmt.Errorf("%s: original config restored but reload failed: %w", s.ID, e))
		}
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	j.Phase = "restored"
	return writeJSON(sshJournalPath(c), j, 0600)
}
func recoverSSH(c Config) error {
	unlock, err := sshLock(c)
	if err != nil {
		return err
	}
	defer unlock()
	j, err := readSSHJournal(c)
	if err != nil {
		return err
	}
	if !unfinishedSSH(j) {
		fmt.Println("[OK] No unfinished SSH operation.")
		return nil
	}
	if err = restoreSSHJournal(c, j); err != nil {
		return fmt.Errorf("operation %s: %w\nNext: %s", j.ID, err, recoveryCommand(c))
	}
	fmt.Println("[OK] Original SSH configuration restored and services reloaded. Revoked keys were not restored. Next: allocube-terminal configure-ssh")
	return nil
}
func validatePlanBindings(c Config, targets []Account) error {
	var state SyncState
	if data, e := safeRead(filepath.Join(c.StateDir, "sync-state.json")); e == nil {
		if e = json.Unmarshal(data, &state); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	legacy := struct {
		Managed map[string]struct {
			Revoked bool `json:"revoked"`
		} `json:"managed"`
	}{}
	if data, e := safeRead(filepath.Join(c.StateDir, "state.json")); e == nil {
		if e = json.Unmarshal(data, &legacy); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	for _, a := range targets {
		if old, ok := state.Accounts[a.Name]; ok && old.UID != a.UID {
			return fmt.Errorf("%s UID changed; resolve its sync binding before configuring SSH", a.Name)
		}
		if legacy.Managed[a.Name].Revoked {
			return fmt.Errorf("%s has a legacy revocation; resolve it before configuring SSH", a.Name)
		}
	}
	return nil
}
func applyPlanKeys(c Config, targets []Account, keys map[string][]byte) error {
	state := SyncState{Accounts: map[string]SyncBinding{}}
	path := filepath.Join(c.StateDir, "sync-state.json")
	if data, e := safeRead(path); e == nil {
		if e = json.Unmarshal(data, &state); e != nil {
			return e
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	if state.Accounts == nil {
		return errors.New("invalid sync bindings")
	}
	for _, a := range targets {
		s, e := selectAccount(c, a)
		if e != nil {
			return e
		}
		state.Accounts[a.Name] = SyncBinding{a.UID, s.Employee, time.Now().UTC().Format(time.RFC3339)}
	}
	if err := writeJSON(path, state, 0600); err != nil {
		return err
	}
	for _, a := range targets {
		if err := trustedPath(c.KeyDir); err != nil {
			return err
		}
		accounts, err := localAccounts()
		if err != nil {
			return err
		}
		valid := false
		for _, now := range accounts {
			if now.Name == a.Name && now.UID == a.UID && now.UID != 0 && now.Home == a.Home {
				valid = true
			}
		}
		if !valid {
			return fmt.Errorf("%s changed before writing keys; key file retained", a.Name)
		}
		if _, err := replaceKeys(filepath.Join(c.KeyDir, a.Name), keys[a.Name]); err != nil {
			return err
		}
	}
	return nil
}
