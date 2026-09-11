package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/crypto/ssh"
)

func showMappings(c Config) error {
	accounts, err := localAccounts()
	if err != nil {
		return err
	}
	printScope(c)
	for _, a := range accounts {
		selected, err := selectAccount(c, a)
		if err != nil {
			fmt.Printf("%s: %s\n", a.Name, err)
		} else if selected.Excluded {
			if explicitlyExcluded(c, a.Name) {
				fmt.Printf("%s -> EXCLUDED (original SSH policy)\n", a.Name)
			}
		} else if selected.Managed {
			if selected.Employee == "" {
				fmt.Printf("%s -> NO EMPLOYEE MAPPING (empty keys)\n", a.Name)
			} else {
				fmt.Printf("%s -> %s\n", a.Name, selected.Employee)
			}
		}
	}
	return nil
}

type SyncUser struct {
	Employee string `json:"employeeNumber"`
	Status   string `json:"status"`
	Keys     *[]struct {
		PublicKey string `json:"publicKey"`
	} `json:"keys"`
}
type SyncResponse struct {
	TerminalID string     `json:"terminalId"`
	Users      []SyncUser `json:"users"`
}

// Validate the response envelope before accepting any per-user data. Bad key
// content retains only that user's files; other users' revocations must proceed.
func normalizeSyncResponse(terminalID string, employees []string, response SyncResponse) (map[string][]byte, []error, error) {
	if response.TerminalID != terminalID || len(response.Users) != len(employees) {
		return nil, nil, errors.New("incomplete or cross-machine key response; files retained")
	}
	wanted := map[string]bool{}
	for _, employee := range employees {
		wanted[employee] = true
	}
	for _, user := range response.Users {
		if !wanted[user.Employee] {
			return nil, nil, errors.New("unexpected or duplicate employee in key response; files retained")
		}
		delete(wanted, user.Employee)
	}
	normalized := map[string][]byte{}
	var problems []error
	for _, user := range response.Users {
		keys, err := normalizeSyncUser(user)
		if err != nil {
			problems = append(problems, fmt.Errorf("employee %s: %w; this employee's files retained", user.Employee, err))
			continue
		}
		normalized[user.Employee] = keys
	}
	return normalized, problems, nil
}

func normalizeSyncUser(user SyncUser) ([]byte, error) {
	if user.Status != "OK" {
		if user.Status != "DENIED" && user.Status != "NOT_FOUND" {
			return nil, errors.New("unknown key response status")
		}
		if user.Keys != nil && len(*user.Keys) != 0 {
			return nil, errors.New("denied or missing employee response contains keys")
		}
		return []byte{}, nil
	}
	if user.Keys == nil || len(*user.Keys) > 10 {
		return nil, errors.New("missing or oversized public key list")
	}
	var lines []string
	for _, key := range *user.Keys {
		if len(key.PublicKey) > 4096 {
			return nil, errors.New("oversized public key")
		}
		if _, err := validateNewKey(key.PublicKey); err != nil {
			return nil, err
		}
		lines = append(lines, key.PublicKey)
	}
	return canonicalKeys(strings.Join(lines, "\n"))
}

type SyncBinding struct {
	UID       int    `json:"uid"`
	Employee  string `json:"employeeNumber"`
	UpdatedAt string `json:"updatedAt"`
}
type SyncState struct {
	Accounts map[string]SyncBinding `json:"accounts"`
}

func canonicalKeys(value string) ([]byte, error) {
	lines, _, err := keyLines(value)
	if err != nil {
		return nil, err
	}
	keys := map[string]string{}
	for _, line := range lines {
		if _, err = validateNewKey(line); err != nil {
			return nil, err
		}
		key, comment, _, _, err := ssh.ParseAuthorizedKey([]byte(line))
		if err != nil {
			return nil, err
		}
		normalized := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(key)))
		if comment != "" {
			normalized += " " + comment
		}
		fingerprint := ssh.FingerprintSHA256(key)
		if old, ok := keys[fingerprint]; !ok || normalized < old {
			keys[fingerprint] = normalized
		}
	}
	sorted := make([]string, 0, len(keys))
	for _, line := range keys {
		sorted = append(sorted, line)
	}
	sort.Strings(sorted)
	if len(sorted) == 0 {
		return []byte{}, nil
	}
	return []byte(strings.Join(sorted, "\n") + "\n"), nil
}
func replaceKeys(path string, desired []byte) (bool, error) {
	label, labelErr := managedKeyLabel(path)
	old, err := safeRead(path)
	if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	if labelErr != nil && (err != nil || label == "") {
		return false, labelErr
	}
	if err == nil {
		st, e := os.Lstat(path)
		if e != nil {
			return false, e
		}
		if st.Sys().(*syscall.Stat_t).Uid != 0 || st.Mode().Perm()&0022 != 0 {
			return false, errors.New("unsafe managed file ownership")
		}
		normalized, e := canonicalKeys(string(old))
		if e != nil {
			return false, e
		}
		if labelErr != nil {
			// A policy drift must withhold new grants, but must not indefinitely
			// retain revoked keys. Keep the existing full inode label and apply
			// only removals; never relabel the old file to repair the policy.
			desired, e = removalOnly(old, desired)
			if e != nil {
				return false, e
			}
		}
		if bytes.Equal(normalized, desired) {
			return false, labelErr
		}
	}
	if err = atomicWriteLabeled(path, desired, 0644, label); err != nil {
		return false, err
	}
	return true, labelErr
}

// Address, group and executable Match conditions could produce different policies at login.
func inspectSyncSSH(path string, seen map[string]bool, depth int) error {
	if depth > 12 {
		return errors.New("SSH include nesting too deep")
	}
	if seen[path] {
		return nil
	}
	seen[path] = true
	if err := trustedPath(path); err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Fields(strings.SplitN(line, "#", 2)[0])
		if len(parts) == 0 {
			continue
		}
		if strings.Contains(parts[0], "=") {
			return errors.New("SSH option=value syntax is not supported by the configuration inspector; use standard option value syntax after administrator review")
		}
		switch strings.ToLower(parts[0]) {
		case "match":
			if !(len(parts) == 2 && strings.EqualFold(parts[1], "all")) && !(len(parts) == 3 && strings.EqualFold(parts[1], "user")) {
				return errors.New("only Match User and Match all are supported; review custom SSH configuration")
			}
		case "include":
			for _, pattern := range parts[1:] {
				if !filepath.IsAbs(pattern) {
					pattern = filepath.Join("/etc/ssh", pattern)
				}
				paths, e := filepath.Glob(pattern)
				if e != nil {
					return e
				}
				for _, next := range paths {
					if e = inspectSyncSSH(next, seen, depth+1); e != nil {
						return e
					}
				}
			}
		}
	}
	return nil
}
func checkSyncSSH(c Config, a Account, desired []byte) error {
	services := c.SSHServices
	if len(services) == 0 {
		services = []SSHService{{ID: "configured SSH", Executable: "/usr/sbin/sshd", Config: c.SSHConfig}}
	}
	for _, svc := range services {
		settings, err := serviceSettings(svc, svc.Config, a)
		if err != nil {
			return err
		}
		if err = checkSSHPolicy(c, settings); err != nil {
			return fmt.Errorf("%s: %w", svc.ID, err)
		}
	}
	return nil
}

func synchronize(c Config) error {
	if _, err := os.Stat(filepath.Join(c.StateDir, "sync-paused")); err == nil {
		fmt.Println("[SKIP] Synchronization is paused. Run allocube-terminal resume when ready.")
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	lock, err := os.OpenFile(filepath.Join(c.StateDir, "sync.lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("another sync is running")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	if err = trustedPath(c.KeyDir); err != nil {
		return err
	}
	services, coverageErr := discoverSSHServices()
	c.SSHServices = services
	if coverageErr == nil {
		coverageErr = checkSSHInventory(c, services)
	}
	accounts, err := localAccounts()
	if err != nil {
		return err
	}
	state := SyncState{Accounts: map[string]SyncBinding{}}
	statePath := filepath.Join(c.StateDir, "sync-state.json")
	data, err := safeRead(statePath)
	if err == nil {
		if err = json.Unmarshal(data, &state); err != nil {
			return err
		}
		if state.Accounts == nil {
			return errors.New("invalid sync state")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	// Respect revocations made by the retired executor; an administrator must explicitly resolve them.
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
	targets := map[string][]Account{}
	var problems []error
	for _, svc := range services {
		cfg := c
		cfg.SSHConfig = svc.Config
		restoring, e := exclusionsToRestore(cfg, accounts)
		if e != nil {
			problems = append(problems, e)
			continue
		}
		for _, a := range restoring {
			problems = append(problems, fmt.Errorf("%s / %s: excluded account still has Allocube rules; run allocube-terminal configure-ssh", svc.ID, a.Name))
		}
	}
	for _, a := range accounts {
		selection, e := selectAccount(c, a)
		employee := selection.Employee
		if e != nil {
			problems = append(problems, fmt.Errorf("%s: %w", a.Name, e))
			continue
		}
		if !selection.Managed {
			continue
		}
		if legacy.Managed[a.Name].Revoked {
			problems = append(problems, fmt.Errorf("%s: legacy SSH revocation requires administrator review", a.Name))
			continue
		}
		if old, ok := state.Accounts[a.Name]; ok && old.UID != a.UID {
			problems = append(problems, fmt.Errorf("%s: local UID changed; remove stale keys and resolve sync binding manually", a.Name))
			continue
		}
		targets[employee] = append(targets[employee], a)
	}
	if len(targets) == 0 {
		return errors.Join(problems...)
	}
	if coverageErr != nil {
		problems = append(problems, fmt.Errorf("SSH coverage incomplete: %w; only safe removals will be applied", coverageErr))
	}
	p, err := newPlatform(c)
	if err != nil {
		return err
	}
	apply := func(employee string, desired []byte) error {
		for _, a := range targets[employee] {
			if _, paused := os.Stat(filepath.Join(c.StateDir, "sync-paused")); paused == nil {
				return errors.New("synchronization paused before writing keys")
			}
			// The local password database can change while the network request is in flight.
			current, e := localAccounts()
			if e != nil {
				return e
			}
			valid := false
			for _, now := range current {
				if now.Name == a.Name && now.UID == a.UID && now.UID != 0 && now.Home == a.Home {
					valid = true
				}
			}
			if !valid {
				problems = append(problems, fmt.Errorf("%s: local account changed; skipped", a.Name))
				continue
			}
			accountKeys := desired
			policyErr := coverageErr
			if policyErr == nil {
				policyErr = checkSyncSSH(c, a, desired)
			}
			binding, exists := state.Accounts[a.Name]
			if policyErr != nil {
				if !exists {
					continue
				}
				old, e := safeRead(filepath.Join(c.KeyDir, a.Name))
				if os.IsNotExist(e) {
					continue
				}
				if e != nil {
					problems = append(problems, e)
					continue
				}
				accountKeys, e = removalOnly(old, desired)
				if e != nil {
					problems = append(problems, e)
					continue
				}
				if coverageErr == nil {
					problems = append(problems, fmt.Errorf("%s: %w; new keys withheld", a.Name, policyErr))
				}
			}
			if !exists || binding.Employee != employee {
				state.Accounts[a.Name] = SyncBinding{a.UID, employee, time.Now().UTC().Format(time.RFC3339)}
				if e = writeJSON(statePath, state, 0600); e != nil {
					return e
				}
			}
			changed, e := replaceKeys(filepath.Join(c.KeyDir, a.Name), accountKeys)
			if e != nil {
				problems = append(problems, fmt.Errorf("%s: %w", a.Name, e))
				continue
			}
			if changed {
				if employee == "" {
					fmt.Printf("%s -> NO EMPLOYEE MAPPING: empty public key list applied\n", a.Name)
				} else {
					fmt.Printf("%s -> %s: public keys updated\n", a.Name, employee)
				}
			}
		}
		return nil
	}
	employees := make([]string, 0, len(targets))
	for e := range targets {
		if e == "" {
			continue
		}
		employees = append(employees, e)
	}
	sort.Strings(employees)
	for start := 0; start < len(employees); start += 32 {
		end := min(start+32, len(employees))
		batch := employees[start:end]
		var response SyncResponse
		if err = p.call("keys", map[string]any{"employees": batch}, &response); err != nil {
			return errors.Join(append(problems, err)...)
		}
		normalized, keyProblems, responseErr := normalizeSyncResponse(c.TerminalID, batch, response)
		if responseErr != nil {
			return errors.Join(append(problems, responseErr)...)
		}
		problems = append(problems, keyProblems...)
		for _, employee := range batch {
			desired, ok := normalized[employee]
			if !ok {
				continue
			}
			if e := apply(employee, desired); e != nil {
				return e
			}
		}
	}
	if len(targets[""]) > 0 {
		// A valid machine credential is still required before applying local empty mappings.
		if _, err = p.token(); err != nil {
			return errors.Join(append(problems, err)...)
		}
		if err = apply("", []byte{}); err != nil {
			return err
		}
	}
	return errors.Join(problems...)
}

func installSync(c Config, path string) error {
	binary, err := os.Executable()
	if err != nil {
		return err
	}
	binary, err = filepath.EvalSymlinks(binary)
	if err != nil {
		return err
	}
	if err = trustedPath(binary); err != nil {
		return err
	}
	for _, v := range []string{binary, path, c.StateDir, c.KeyDir} {
		if strings.ContainsAny(v, "\r\n\t \"%'\\") {
			return errors.New("installation paths contain unsupported systemd characters")
		}
	}
	if err = trustedPath(filepath.Dir(c.KeyDir)); err != nil {
		return err
	}
	if err = os.MkdirAll(c.KeyDir, 0755); err != nil {
		return err
	}
	if err = trustedPath(c.KeyDir); err != nil {
		return err
	}
	service := fmt.Sprintf("[Unit]\nDescription=Allocube public key synchronization\nWants=network-online.target\nAfter=network-online.target\n[Service]\nType=oneshot\nExecStart=%s --config %s sync\nUser=root\nUMask=0077\nNoNewPrivileges=true\nProtectSystem=strict\nReadWritePaths=%s %s\nPrivateTmp=true\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nNice=19\nCPUSchedulingPolicy=idle\nIOSchedulingClass=idle\nTimeoutStartSec=120\n", binary, path, c.StateDir, c.KeyDir)
	timer := fmt.Sprintf("[Unit]\nDescription=Periodically synchronize Allocube public keys\n[Timer]\nOnBootSec=60\nOnUnitInactiveSec=%d\nRandomizedDelaySec=30\nAccuracySec=30\nUnit=allocube-terminal-sync.service\n[Install]\nWantedBy=timers.target\n", c.IntervalSeconds)
	for name, body := range map[string]string{"allocube-terminal-sync.service": service, "allocube-terminal-sync.timer": timer} {
		if err = atomicWrite(filepath.Join("/etc/systemd/system", name), []byte(body), 0644); err != nil {
			return err
		}
	}
	if _, err = command("/usr/bin/systemctl", "daemon-reload"); err != nil {
		return err
	}
	for _, unit := range []string{"allocube-terminal-web.socket", "allocube-terminal-broker.socket", "allocube-terminal-web.service", "allocube-terminal-broker.service"} {
		if state, e := command("/usr/bin/systemctl", "show", "--property=LoadState", "--value", unit); e == nil && strings.TrimSpace(state) == "loaded" {
			if _, e = command("/usr/bin/systemctl", "stop", unit); e != nil {
				return e
			}
			if strings.HasSuffix(unit, ".socket") {
				if _, e = command("/usr/bin/systemctl", "disable", unit); e != nil {
					return e
				}
			}
		}
	}
	if _, err = os.Stat(filepath.Join(c.StateDir, "sync-paused")); err == nil {
		fmt.Println("[SKIP] Timer files installed, but synchronization remains paused.")
		return nil
	}
	_, err = command("/usr/bin/systemctl", "enable", "--now", "allocube-terminal-sync.timer")
	return err
}
