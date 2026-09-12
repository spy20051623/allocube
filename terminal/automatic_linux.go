package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type AutomaticFailure struct {
	Signature string `json:"signature"`
	Outcome   string `json:"outcome"`
}

func readSyncState(c Config) (SyncState, error) {
	state := SyncState{Accounts: map[string]SyncBinding{}}
	data, err := safeRead(filepath.Join(c.StateDir, "sync-state.json"))
	if os.IsNotExist(err) {
		return state, nil
	}
	if err != nil {
		return state, err
	}
	if err = trustedPath(filepath.Join(c.StateDir, "sync-state.json")); err != nil {
		return state, err
	}
	if err = json.Unmarshal(data, &state); err != nil {
		return state, err
	}
	if state.Accounts == nil {
		return state, errors.New("invalid sync bindings")
	}
	return state, nil
}

// Discard only Allocube's old grants, before any network request. A failed write
// retains the old binding so no later path can treat the replacement as enrolled.
func discardRecreatedKeys(c Config, accounts []Account, state *SyncState) error {
	for _, a := range accounts {
		selected, err := selectAccount(c, a)
		if err != nil {
			continue
		}
		old, exists := state.Accounts[a.Name]
		if !selected.Managed || !exists || old.UID == a.UID {
			continue
		}
		if err = trustedPath(c.KeyDir); err != nil {
			return err
		}
		current, err := localAccounts()
		if err != nil {
			return err
		}
		valid := false
		for _, now := range current {
			if now.Name == a.Name && now.UID == a.UID && now.Home == a.Home && now.UID != 0 {
				valid = true
			}
		}
		if !valid {
			return &RetryError{errors.New("account changed while discarding stale keys; retry next cycle")}
		}
		if _, err = replaceKeys(filepath.Join(c.KeyDir, a.Name), nil); err != nil {
			return needsHelp("KEY_WRITE", a.Name, "UNCHANGED", err)
		}
		delete(state.Accounts, a.Name)
		if err = writeJSON(filepath.Join(c.StateDir, "sync-state.json"), state, 0600); err != nil {
			return err
		}
	}
	return nil
}

func automaticSignature(plan *SSHPlan) string {
	type file struct {
		Path     string
		Before   []byte
		After    []byte
		Snapshot map[string][]byte
	}
	files := []file{}
	for _, f := range plan.Files {
		files = append(files, file{f.Path, f.Before, f.After, f.Snapshot})
	}
	data, _ := json.Marshal(struct {
		Files    []file
		Services []SSHService
		Accounts []Account
	}{files, plan.Services, plan.Accounts})
	return digest(string(data))
}

// Called under sync.lock. Automatic work is restricted to already approved SSH
// service/configuration coverage. Changes to that coverage require local review.
func autoManageAccounts(c Config) error {
	if !c.AutoManageNewAccounts {
		return nil
	}
	accounts, err := localAccounts()
	if err != nil {
		return err
	}
	state, err := readSyncState(c)
	if err != nil {
		return err
	}
	if err = discardRecreatedKeys(c, accounts, &state); err != nil {
		return err
	}
	j, err := readSSHJournal(c)
	if err != nil {
		return needsHelp("SSH_RECOVERY", "", "RECOVERY_REQUIRED", err)
	}
	if unfinishedSSH(j) {
		if !j.AutomaticRecoveryAttempted {
			j.AutomaticRecoveryAttempted = true
			if err = writeJSON(sshJournalPath(c), j, 0600); err != nil {
				return err
			}
			if err = restoreSSHJournal(c, j); err != nil {
				return needsHelp("SSH_RECOVERY", "", "RECOVERY_REQUIRED", err)
			}
		} else {
			return needsHelp("SSH_RECOVERY", "", "RECOVERY_REQUIRED", errors.New("unfinished SSH operation; run allocube-terminal recover-ssh"))
		}
		return needsHelp("SSH_CONFIGURATION", "", "RESTORED", errors.New("interrupted SSH operation restored; run configure-ssh before retrying"))
	}
	pending := []Account{}
	for _, a := range accounts {
		selected, e := selectAccount(c, a)
		if e != nil {
			continue
		}
		if selected.Managed {
			if _, exists := state.Accounts[a.Name]; !exists {
				pending = append(pending, a)
			}
		}
	}
	if len(pending) == 0 {
		return nil
	}
	services, err := discoverSSHServices()
	if err != nil {
		return needsHelp("SSH_CONFIGURATION", "", "KEYS_WITHHELD", err)
	}
	if err = checkSSHInventory(c, services); err != nil {
		return needsHelp("SSH_CONFIGURATION", "", "KEYS_WITHHELD", err)
	}
	plan, err := prepareSSHPlanFor(c, pending)
	if err != nil {
		return needsHelp("SSH_CONFIGURATION", "", "UNCHANGED", err)
	}
	defer plan.close()
	if len(plan.Restoring) > 0 {
		return needsHelp("ACCOUNT_POLICY", "", "UNCHANGED", errors.New("exclusions need local configure-ssh confirmation before automatic enrollment"))
	}
	if err = validatePlanBindings(c, pending); err != nil {
		return needsHelp("ACCOUNT_POLICY", "", "UNCHANGED", err)
	}
	signature := automaticSignature(plan)
	failurePath := filepath.Join(c.StateDir, "automatic-failure.json")
	var previous AutomaticFailure
	if data, e := safeRead(failurePath); e == nil {
		if e = json.Unmarshal(data, &previous); e != nil {
			return e
		}
		if previous.Signature == signature {
			return needsHelp("SSH_CONFIGURATION", "", previous.Outcome, errors.New("automatic enrollment already failed under the same conditions; review help.log and run configure-ssh"))
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	keys, err := fetchPlanKeys(c, pending)
	if err != nil {
		var retry *RetryError
		if errors.As(err, &retry) {
			return err
		}
		return needsHelp("PLATFORM_RESPONSE", "", "UNCHANGED", err)
	}
	// Save the attempt before writing anything. A killed process must not blindly
	// repeat the same operation on the next timer tick.
	if err = writeJSON(failurePath, AutomaticFailure{signature, "UNCHANGED"}, 0600); err != nil {
		return err
	}
	if err = executeSSHPlan(c, plan, keys); err != nil {
		outcome := "UNCHANGED"
		var help *HelpError
		if errors.As(err, &help) {
			outcome = help.Outcome
		}
		_ = writeJSON(failurePath, AutomaticFailure{signature, outcome}, 0600)
		if help != nil {
			return err
		}
		return needsHelp("SSH_CONFIGURATION", "", outcome, err)
	}
	if err = os.Remove(failurePath); err != nil && !os.IsNotExist(err) {
		return err
	}
	fmt.Printf("[OK] Automatically enrolled %d local accounts.\n", len(pending))
	return nil
}

// Atomic replacement needs the parent directory to be writable. Never grant a
// broad filesystem root just because a custom service uses an unsafe location.
func automaticSSHWritePaths(c Config) ([]string, error) {
	if !c.AutoManageNewAccounts {
		return nil, nil
	}
	services, err := discoverSSHServices()
	if err != nil {
		return nil, err
	}
	if err = checkSSHInventory(c, services); err != nil {
		return nil, err
	}
	paths := []string{}
	seen := map[string]bool{}
	for _, s := range services {
		dir := filepath.Dir(s.Config)
		if dir == "/" || dir == "/etc" || dir == "/usr" || dir == "/var" || dir == "/root" || dir == "/home" || dir == "/tmp" {
			return nil, fmt.Errorf("automatic enrollment requires a dedicated SSH configuration directory: %s", s.Config)
		}
		if err = trustedPath(dir); err != nil {
			return nil, err
		}
		if !seen[dir] {
			paths = append(paths, dir)
			seen[dir] = true
		}
	}
	return paths, nil
}
