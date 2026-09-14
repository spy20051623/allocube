package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSSHPasswordLoginConfigDefault(t *testing.T) {
	for _, tc := range []struct {
		field string
		want  bool
	}{{"", false}, {`,"allowSSHPasswordLogin":false`, false}, {`,"allowSSHPasswordLogin":true`, true}} {
		p := filepath.Join(t.TempDir(), "config.json")
		body := []byte(`{"platform":"https://example.test","terminalId":"test"` + tc.field + `}`)
		if err := os.WriteFile(p, body, 0600); err != nil {
			t.Fatal(err)
		}
		c, err := loadConfig(p)
		if err != nil || c.AllowSSHPasswordLogin != tc.want {
			t.Fatalf("%s: %v %+v", tc.field, err, c)
		}
	}
}

func TestSSHPasswordLoginPolicyAndBlockRoundTrip(t *testing.T) {
	for _, allow := range []bool{false, true} {
		c := defaults()
		c.AllowSSHPasswordLogin = allow
		methods, password := sshAuthenticationPolicy(allow)
		settings := map[string]string{"pubkeyauthentication": "yes", "passwordauthentication": password, "kbdinteractiveauthentication": "no", "authenticationmethods": methods, "authorizedkeyscommand": "none", "authorizedkeysfile": filepath.Join(c.KeyDir, "%u")}
		if err := checkSSHPolicy(c, settings); err != nil {
			t.Fatal(err)
		}
		block, err := sshAccountBlock(Account{Name: "a12345678", UID: 1001}, settings, c.KeyDir, allow)
		if err != nil {
			t.Fatal(err)
		}
		base := []byte("PasswordAuthentication no\n")
		candidate := sshCandidate(base, []string{block})
		stripped, err := originalSSH(candidate)
		if err != nil || !bytes.Equal(stripped, base) {
			t.Fatal("base changed", err)
		}
		blocks, _, err := priorSSHBlocks(candidate, stripped)
		if err != nil || len(blocks) != 1 || blocks[0] != block {
			t.Fatal("managed block cannot be read back", err)
		}
		for _, field := range []string{"authenticationmethods", "kbdinteractiveauthentication", "authorizedkeyscommand", "authorizedkeysfile", "pubkeyauthentication", "passwordauthentication"} {
			old := settings[field]
			settings[field] = "unexpected"
			if checkSSHPolicy(c, settings) == nil {
				t.Fatal("unsafe setting accepted", field)
			}
			settings[field] = old
		}
		for _, account := range []Account{{Name: "root", UID: 1001}, {Name: "alias", UID: 0}} {
			if _, err = sshAccountBlock(account, settings, c.KeyDir, allow); err == nil {
				t.Fatal("protected account accepted")
			}
		}
		settings["authenticationmethods"] = "publickey,password"
		if _, err = sshAccountBlock(Account{Name: "a12345678", UID: 1001}, settings, c.KeyDir, allow); err == nil {
			t.Fatal("custom MFA policy overwritten")
		}
	}
}

func applyPasswordFixture(t *testing.T, c Config) {
	t.Helper()
	plan, err := prepareSSHPlan(c)
	if err != nil {
		t.Fatal(err)
	}
	defer plan.close()
	keys, err := fetchPlanKeys(c, plan.Targets)
	if err != nil {
		t.Fatal(err)
	}
	if err = executeSSHPlan(c, plan, keys); err != nil {
		t.Fatal(err)
	}
}

// Real sshd validates both alternatives and transitions. Accounts and reloads
// are fixture seams; host accounts and SSH listeners are never modified.
func TestSSHPasswordLoginToggleAndSynchronization(t *testing.T) {
	keyList := []any{}
	c, accounts, reloads, _ := automaticFixture(t, func() []any { return keyList })
	*accounts = append(*accounts, Account{Name: "b12345678", UID: 1002}, Account{Name: "c12345678", UID: 1003})
	c.UserMapping["c12345678"] = nil
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	rootBefore, _ := sshSettings(c, Account{Name: "root"})
	excludedBefore, _ := sshSettings(c, Account{Name: "c12345678"})
	for _, allow := range []bool{true, false, true} {
		c.AllowSSHPasswordLogin = allow
		services, _ := discoverSSHServices()
		if checkSSHInventory(c, services) == nil {
			t.Fatal("policy change accepted without configuration")
		}
		applyPasswordFixture(t, c)
		for _, name := range []string{"a12345678", "b12345678"} {
			settings, err := sshSettings(c, Account{Name: name})
			if err != nil || checkSSHPolicy(c, settings) != nil {
				t.Fatal("effective policy", err, settings)
			}
		}
		before, _ := os.Stat(c.SSHConfig)
		count := *reloads
		newKey := testKey(t, "platform")
		keyList = []any{map[string]any{"publicKey": newKey}}
		if err := synchronizeKeys(c); err != nil {
			t.Fatal(err)
		}
		added, err := safeRead(filepath.Join(c.KeyDir, "a12345678"))
		if err != nil || strings.TrimSpace(string(added)) != strings.TrimSpace(newKey) {
			t.Fatal("platform key was not added", err)
		}
		keyList = []any{}
		// The mock platform returns an empty list: removals must still work
		// while password authentication is permitted.
		if _, err := replaceKeys(filepath.Join(c.KeyDir, "a12345678"), []byte(testKey(t, "old"))); err != nil {
			t.Fatal(err)
		}
		if err := synchronizeKeys(c); err != nil {
			t.Fatal(err)
		}
		keys, err := safeRead(filepath.Join(c.KeyDir, "a12345678"))
		if err != nil || len(keys) != 0 {
			t.Fatal("empty key sync failed", err)
		}
		if err = autoManageAccounts(c); err != nil {
			t.Fatal(err)
		}
		after, _ := os.Stat(c.SSHConfig)
		if !os.SameFile(before, after) || *reloads != count {
			t.Fatal("unchanged sync rewrote SSH")
		}
	}
	*accounts = append(*accounts, Account{Name: "d12345678", UID: 1004})
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	settings, err := sshSettings(c, Account{Name: "d12345678"})
	if err != nil || checkSSHPolicy(c, settings) != nil {
		t.Fatal("new account did not inherit password option", err)
	}
	for _, tc := range []struct {
		name   string
		before map[string]string
	}{{"root", rootBefore}, {"c12345678", excludedBefore}} {
		after, _ := sshSettings(c, Account{Name: tc.name})
		if fmt.Sprint(after) != fmt.Sprint(tc.before) {
			t.Fatal("unmanaged policy changed", tc.name)
		}
	}
	// Exclusion must also remove the new password-enabled managed block.
	c.UserMapping["a12345678"] = nil
	applyPasswordFixture(t, c)
	body, _ := safeRead(c.SSHConfig)
	if strings.Contains(string(body), "Match User a12345678\n") {
		t.Fatal("excluded rule retained")
	}
}

func TestSSHPasswordLoginReloadFailureRestoresPolicy(t *testing.T) {
	c, _, _, _ := automaticFixture(t)
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	before, _ := safeRead(c.SSHConfig)
	c.AllowSSHPasswordLogin = true
	plan, err := prepareSSHPlan(c)
	if err != nil {
		t.Fatal(err)
	}
	defer plan.close()
	keys, err := fetchPlanKeys(c, plan.Targets)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	reloadSSHService = func(SSHService) error {
		calls++
		if calls == 1 {
			return errors.New("fixture reload failure")
		}
		return nil
	}
	if err = executeSSHPlan(c, plan, keys); err == nil {
		t.Fatal("failed reload accepted")
	}
	after, _ := safeRead(c.SSHConfig)
	if !bytes.Equal(before, after) {
		t.Fatal("previous SSH policy not restored")
	}
	settings, _ := sshSettings(c, Account{Name: "a12345678"})
	if settings["passwordauthentication"] != "no" {
		t.Fatal("password login left enabled after failure")
	}
}
