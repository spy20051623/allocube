package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

type SSHFilePlan struct {
	Path      string            `json:"path"`
	Before    []byte            `json:"before"`
	After     []byte            `json:"after"`
	Mode      os.FileMode       `json:"mode"`
	Candidate string            `json:"-"`
	Base      []byte            `json:"-"`
	Snapshot  map[string][]byte `json:"-"`
}
type SSHPlan struct {
	Services  []SSHService
	Files     []SSHFilePlan
	Accounts  []Account
	Targets   []Account
	Restoring []Account
}

func (p *SSHPlan) close() {
	for _, f := range p.Files {
		if f.Candidate != "" && f.Candidate != f.Path {
			os.Remove(f.Candidate)
		}
	}
}

func snapshotSSHFiles(path string) (map[string][]byte, error) {
	seen := map[string]bool{}
	if err := inspectSyncSSH(path, seen, 0); err != nil {
		return nil, err
	}
	result := map[string][]byte{}
	for path := range seen {
		data, err := safeRead(path)
		if err != nil {
			return nil, err
		}
		result[path] = data
	}
	return result, nil
}
func selectedTargets(c Config, accounts []Account) ([]Account, error) {
	var targets []Account
	for _, a := range accounts {
		s, err := selectAccount(c, a)
		if err != nil {
			return nil, err
		}
		if s.Managed {
			targets = append(targets, a)
		}
	}
	return targets, nil
}
func prepareSSHPlan(c Config) (*SSHPlan, error) { return prepareSSHPlanFor(c, nil) }

func prepareSSHPlanFor(c Config, only []Account) (plan *SSHPlan, err error) {
	services, err := discoverSSHServices()
	if err != nil {
		return nil, err
	}
	plan = &SSHPlan{Services: services}
	defer func(prepared *SSHPlan) {
		if err != nil {
			prepared.close()
		}
	}(plan)
	if plan.Accounts, err = localAccounts(); err != nil {
		return nil, err
	}
	if plan.Targets, err = selectedTargets(c, plan.Accounts); err != nil {
		return nil, err
	}
	if only != nil {
		plan.Targets = only
	}
	targets := map[string]bool{}
	for _, a := range plan.Targets {
		targets[a.Name] = true
	}
	seen := map[string]bool{}
	restoring := map[string]bool{}
	for _, svc := range services {
		if seen[svc.Config] {
			continue
		}
		seen[svc.Config] = true
		if err = trustedPath(svc.Config); err != nil {
			return nil, err
		}
		before, e := safeRead(svc.Config)
		if e != nil {
			return nil, e
		}
		base, e := originalSSH(before)
		if e != nil {
			return nil, e
		}
		blocks, names, e := priorSSHBlocks(before, base)
		if e != nil {
			return nil, e
		}
		cfg := c
		cfg.SSHConfig = svc.Config
		restore, e := exclusionsToRestore(cfg, plan.Accounts)
		if e != nil {
			return nil, e
		}
		for _, a := range restore {
			if !restoring[a.Name] {
				plan.Restoring = append(plan.Restoring, a)
				restoring[a.Name] = true
			}
		}
		// Already-compliant manually maintained Match User rules can be enrolled
		// without rewriting them. Their complete include graph is still checked.
		already := len(restore) == 0
		for _, instance := range services {
			if instance.Config != svc.Config {
				continue
			}
			for _, a := range plan.Targets {
				settings, e := serviceSettings(instance, instance.Config, a)
				if e != nil {
					return nil, e
				}
				if checkSSHPolicy(c, settings) != nil {
					already = false
				}
			}
		}
		if already {
			snapshot, e := snapshotSSHFiles(svc.Config)
			if e != nil {
				return nil, e
			}
			st, e := os.Stat(svc.Config)
			if e != nil {
				return nil, e
			}
			plan.Files = append(plan.Files, SSHFilePlan{Path: svc.Config, Before: before, After: before, Mode: st.Mode().Perm(), Candidate: svc.Config, Base: base, Snapshot: snapshot})
			continue
		}
		snapshot := map[string][]byte{}
		if e = automaticSSHFiles(svc.Config, base, snapshot, 0); e != nil {
			return nil, fmt.Errorf("%s (%s): %w", svc.ID, svc.Config, e)
		}
		var desired []string
		for _, block := range blocks {
			name := strings.Fields(block)[2]
			if !targets[name] && !restoring[name] {
				desired = append(desired, block)
			}
		}
		for _, a := range plan.Accounts {
			if a.UID == 0 && names[a.Name] {
				return nil, errors.New("existing managed block targets UID 0; remove that block manually before continuing")
			}
		}
		for _, a := range plan.Targets {
			settings, e := serviceSettings(svc, svc.Config, a)
			if e != nil {
				return nil, e
			}
			block, e := sshAccountBlock(a, settings, c.KeyDir)
			if e != nil {
				return nil, fmt.Errorf("%s / %s: %w", svc.ID, a.Name, e)
			}
			desired = append(desired, block)
		}
		st, e := os.Stat(svc.Config)
		if e != nil {
			return nil, e
		}
		file := SSHFilePlan{Path: svc.Config, Before: before, After: sshCandidate(base, desired, snapshot), Mode: st.Mode().Perm(), Base: base, Snapshot: snapshot}
		tmp, e := os.CreateTemp(c.StateDir, ".sshd-candidate-")
		if e != nil {
			return nil, e
		}
		file.Candidate = tmp.Name()
		tmp.Close()
		plan.Files = append(plan.Files, file)
		if e = atomicWrite(file.Candidate, file.After, 0600); e != nil {
			return nil, e
		}
	}
	// Config roots included by other service roots require a combined include
	// graph rewrite; never validate one candidate against another live root.
	for _, f := range plan.Files {
		for _, other := range plan.Files {
			if other.Path != f.Path && (!bytes.Equal(f.Before, f.After) || !bytes.Equal(other.Before, other.After)) {
				if _, ok := f.Snapshot[other.Path]; ok {
					return nil, fmt.Errorf("SSH config %s includes service root %s. Move shared global settings to a separate include and rerun configure-ssh; files unchanged", f.Path, other.Path)
				}
			}
		}
	}
	if err = checkSELinuxKeys(c, plan.Targets); err != nil {
		return nil, err
	}
	for _, svc := range services {
		f := plan.file(svc.Config)
		if _, err = serviceCommand(svc, f.Candidate, "-t"); err != nil {
			return nil, err
		}
		for _, a := range plan.Accounts {
			after, e := serviceSettings(svc, f.Candidate, a)
			if e != nil {
				return nil, e
			}
			if targets[a.Name] {
				if e = checkSSHPolicy(c, after); e != nil {
					return nil, fmt.Errorf("%s / %s: candidate policy rejected: %w (check command-line -o overrides)", svc.ID, a.Name, e)
				}
			} else {
				source := svc.Config
				if restoring[a.Name] { // Exclusions restore the policy without Allocube's block.
					tmp, e := os.CreateTemp(c.StateDir, ".sshd-base-")
					if e != nil {
						return nil, e
					}
					source = tmp.Name()
					tmp.Close()
					e = atomicWrite(source, f.Base, 0600)
					if e != nil {
						os.Remove(source)
						return nil, e
					}
				}
				before, e := serviceSettings(svc, source, a)
				if restoring[a.Name] {
					os.Remove(source)
				}
				if e != nil {
					return nil, e
				}
				if !reflect.DeepEqual(before, after) {
					var changed []string
					for k, v := range before {
						if after[k] != v {
							changed = append(changed, k)
						}
					}
					sort.Strings(changed)
					return nil, fmt.Errorf("%s: candidate changes protected account %s (%s); files unchanged", svc.ID, a.Name, strings.Join(changed, ", "))
				}
			}
		}
	}
	return plan, nil
}
func (p *SSHPlan) file(path string) *SSHFilePlan {
	for i := range p.Files {
		if p.Files[i].Path == path {
			return &p.Files[i]
		}
	}
	panic("missing SSH plan file")
}
func (p *SSHPlan) unchanged(c Config) error {
	if err := checkSELinuxKeys(c, p.Targets); err != nil {
		return err
	}
	current, err := discoverSSHServices()
	if err != nil {
		return err
	}
	if !sameServices(p.Services, current) {
		return errors.New("SSH services changed; rerun configure-ssh for a new confirmation")
	}
	accounts, err := localAccounts()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(p.Accounts, accounts) {
		return errors.New("local accounts changed; rerun configure-ssh for a new confirmation")
	}
	if c.ConfigPath != "" {
		now, e := loadConfig(c.ConfigPath)
		if e != nil {
			return e
		}
		now.ConfigPath = c.ConfigPath
		if !reflect.DeepEqual(c, now) {
			return errors.New("Allocube configuration changed; rerun configure-ssh")
		}
	}
	for _, f := range p.Files {
		current, e := snapshotSSHFiles(f.Path)
		if e != nil {
			return e
		}
		if !reflect.DeepEqual(current, f.Snapshot) {
			err = errors.New("SSH configuration or includes changed; rerun configure-ssh")
		}
		if err != nil {
			return fmt.Errorf("%s: %w", f.Path, err)
		}
	}
	if _, e := os.Stat(filepath.Join(c.StateDir, "sync-paused")); !os.IsNotExist(e) {
		return errors.New("synchronization paused or pause state unreadable; files unchanged")
	}
	return nil
}

// Fetch once per employee, regardless of the number of accounts or SSH services.
// Nothing from this function is written to a live managed file.
func fetchPlanKeys(c Config, targets []Account) (map[string][]byte, error) {
	p, err := newPlatform(c)
	if err != nil {
		return nil, err
	}
	wanted := map[string]bool{}
	for _, a := range targets {
		s, e := selectAccount(c, a)
		if e != nil {
			return nil, e
		}
		wanted[s.Employee] = true
	}
	employees := []string{}
	for e := range wanted {
		if e != "" {
			employees = append(employees, e)
		}
	}
	sort.Strings(employees)
	result := map[string][]byte{}
	for start := 0; start < len(employees); start += 32 {
		batch := employees[start:min(start+32, len(employees))]
		var response SyncResponse
		if err = p.call("keys", map[string]any{"employees": batch}, &response); err != nil {
			return nil, err
		}
		normalized, problems, e := normalizeSyncResponse(c.TerminalID, batch, response)
		if e != nil {
			return nil, e
		}
		if len(problems) > 0 {
			return nil, errors.Join(problems...)
		}
		for e, keys := range normalized {
			result[e] = keys
		}
	}
	if wanted[""] {
		if _, err = p.token(); err != nil {
			return nil, err
		}
		result[""] = []byte{}
	}
	byAccount := map[string][]byte{}
	for _, a := range targets {
		s, _ := selectAccount(c, a)
		byAccount[a.Name] = result[s.Employee]
	}
	return byAccount, nil
}
