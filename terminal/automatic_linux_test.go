package main

import (
	"bytes"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Real sshd -t/-T and atomic filesystem operations, but never edit/reload host
// SSH or create host accounts. Discovery/account seams are restored per test.
func automaticFixture(t *testing.T) (Config, *[]Account, *int, *bool) {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("root-owned fixture required")
	}
	testRoot := os.Getenv("ALLOCUBE_TEST_ROOT")
	if testRoot == "" {
		testRoot = "/root"
	}
	dir, err := os.MkdirTemp(testRoot, "allocube-auto-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	c := defaults()
	c.TerminalID = "test"
	c.StateDir = filepath.Join(dir, "state")
	c.KeyDir = filepath.Join(dir, "keys")
	c.IdentityKey = filepath.Join(dir, "identity.key")
	c.CAFile = filepath.Join(dir, "ca.pem")
	c.SSHConfig = filepath.Join(dir, "ssh", "sshd_config")
	c.AutoManageNewAccounts = true
	for _, p := range []string{c.StateDir, c.KeyDir, filepath.Dir(c.SSHConfig)} {
		if err = os.MkdirAll(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = newKey(c.IdentityKey); err != nil {
		t.Fatal(err)
	}
	accounts := []Account{{Name: "root", UID: 0, Home: "/root"}, {Name: "a12345678", UID: 1001, Home: "/home/a12345678"}}
	originalAccounts, originalDiscovery, originalReload := localAccounts, discoverSSHServices, reloadSSHService
	oldSELinux := selinux
	selinux.enabled = func() (bool, error) { return false, nil }
	t.Cleanup(func() {
		localAccounts = originalAccounts
		discoverSSHServices = originalDiscovery
		reloadSSHService = originalReload
		selinux = oldSELinux
	})
	localAccounts = func() ([]Account, error) { return append([]Account{}, accounts...), nil }
	services := []SSHService{{ID: "allocube-fixture.service", Executable: "/usr/sbin/sshd", Config: c.SSHConfig}}
	discoverSSHServices = func() ([]SSHService, error) { return services, nil }
	reloads := 0
	reloadSSHService = func(SSHService) error { reloads++; return nil }
	base := []byte("PasswordAuthentication yes\nKbdInteractiveAuthentication yes\nUsePAM no\n")
	if err = atomicWrite(c.SSHConfig, base, 0600); err != nil {
		t.Fatal(err)
	}
	if err = saveSSHInventory(c, services); err != nil {
		t.Fatal(err)
	}
	unavailable := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if unavailable {
			w.WriteHeader(503)
			fmt.Fprint(w, `{}`)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/token") {
			fmt.Fprint(w, `{"access_token":"fixture"}`)
			return
		}
		var request struct {
			Employees []string `json:"employees"`
		}
		json.NewDecoder(r.Body).Decode(&request)
		users := []map[string]any{}
		for _, employee := range request.Employees {
			users = append(users, map[string]any{"employeeNumber": employee, "status": "OK", "keys": []any{}})
		}
		json.NewEncoder(w).Encode(map[string]any{"terminalId": "test", "users": users})
	}))
	t.Cleanup(server.Close)
	c.Platform = server.URL
	if err = os.WriteFile(c.CAFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	return c, &accounts, &reloads, &unavailable
}

func TestAutomaticEmptyEnrollmentAndNoRepeatedReload(t *testing.T) {
	c, accounts, reloads, _ := automaticFixture(t)
	(*accounts) = append(*accounts, Account{Name: "b12345678", UID: 1002, Home: "/home/b12345678"}, Account{Name: "c12345678", UID: 1003})
	c.UserMapping["c12345678"] = nil
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	if *reloads != 1 {
		t.Fatal("batch must reload once", *reloads)
	}
	for _, name := range []string{"a12345678", "b12345678"} {
		data, err := safeRead(filepath.Join(c.KeyDir, name))
		if err != nil || len(data) != 0 {
			t.Fatal("empty grant not installed", err)
		}
		policy, err := sshSettings(c, Account{Name: name})
		if err != nil || checkSSHPolicy(c, policy) != nil {
			t.Fatal("policy not applied", err, policy)
		}
	}
	if _, err := os.Stat(filepath.Join(c.KeyDir, "c12345678")); !os.IsNotExist(err) {
		t.Fatal("excluded user touched")
	}
	before, _ := os.Stat(c.SSHConfig)
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(c.SSHConfig)
	if *reloads != 1 || !os.SameFile(before, after) {
		t.Fatal("unchanged cycle rewrote configuration")
	}
	root, _ := sshSettings(c, Account{Name: "root"})
	if root["passwordauthentication"] != "yes" {
		t.Fatal("root policy changed")
	}
}

func TestRecreatedAccountDiscardsOldKeysBeforeOfflineRetry(t *testing.T) {
	c, accounts, _, unavailable := automaticFixture(t)
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	if _, err := replaceKeys(filepath.Join(c.KeyDir, "a12345678"), []byte(testKey(t, "old"))); err != nil {
		t.Fatal(err)
	}
	(*accounts)[1].UID = 2001
	*unavailable = true
	err := autoManageAccounts(c)
	var retry *RetryError
	if !errors.As(err, &retry) {
		t.Fatal("expected retry", err)
	}
	data, e := safeRead(filepath.Join(c.KeyDir, "a12345678"))
	if e != nil || len(data) != 0 {
		t.Fatal("stale keys survived UID replacement", e)
	}
	state, e := readSyncState(c)
	if e != nil {
		t.Fatal(e)
	}
	if _, ok := state.Accounts["a12345678"]; ok {
		t.Fatal("replacement bound before successful authorization")
	}
	*unavailable = false
	if err = autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	state, _ = readSyncState(c)
	if state.Accounts["a12345678"].UID != 2001 {
		t.Fatal("replacement not enrolled")
	}
}

func TestAutomaticReloadFailureRestoresAndDoesNotRetryUnchangedPlan(t *testing.T) {
	c, _, reloads, _ := automaticFixture(t)
	before, _ := safeRead(c.SSHConfig)
	reloadSSHService = func(SSHService) error {
		*reloads++
		if *reloads == 1 {
			return errors.New("fixture reload failure")
		}
		return nil
	}
	if err := autoManageAccounts(c); err == nil {
		t.Fatal("failed reload succeeded")
	}
	after, _ := safeRead(c.SSHConfig)
	if !bytes.Equal(before, after) {
		t.Fatal("configuration not restored")
	}
	count := *reloads
	if err := autoManageAccounts(c); err == nil {
		t.Fatal("blocked plan not reported")
	}
	if count != *reloads {
		t.Fatal("same failed plan reloaded again")
	}
}

func TestAutomaticCoverageChangeAndDisabledOptionDoNotWrite(t *testing.T) {
	c, _, reloads, _ := automaticFixture(t)
	c.AutoManageNewAccounts = false
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	if *reloads != 0 {
		t.Fatal("disabled auto wrote SSH")
	}
	c.AutoManageNewAccounts = true
	os.WriteFile(c.SSHConfig, []byte("PasswordAuthentication no\n"), 0600)
	if err := autoManageAccounts(c); err == nil {
		t.Fatal("external configuration change accepted")
	}
	if *reloads != 0 {
		t.Fatal("unapproved configuration reloaded")
	}
}

func TestAutomaticTwoConfigurationsRestoreTogether(t *testing.T) {
	c, _, reloads, _ := automaticFixture(t)
	second := filepath.Join(filepath.Dir(c.SSHConfig), "second.conf")
	before, _ := safeRead(c.SSHConfig)
	if err := atomicWrite(second, before, 0600); err != nil {
		t.Fatal(err)
	}
	services := []SSHService{{ID: "one.service", Executable: "/usr/sbin/sshd", Config: c.SSHConfig}, {ID: "two.service", Executable: "/usr/sbin/sshd", Config: second}}
	discoverSSHServices = func() ([]SSHService, error) { return services, nil }
	if err := saveSSHInventory(c, services); err != nil {
		t.Fatal(err)
	}
	reloadSSHService = func(SSHService) error {
		*reloads++
		if *reloads == 2 {
			return errors.New("second listener failed")
		}
		return nil
	}
	if err := autoManageAccounts(c); err == nil {
		t.Fatal("second service failure not reported")
	}
	for _, path := range []string{c.SSHConfig, second} {
		after, _ := safeRead(path)
		if !bytes.Equal(before, after) {
			t.Fatal("partial restore", path)
		}
	}
	count := *reloads
	if count != 4 {
		t.Fatal("both services must be restored", count)
	}
	if err := autoManageAccounts(c); err == nil {
		t.Fatal("failed attempt should remain blocked")
	}
	if count != *reloads {
		t.Fatal("failed pair retried without changed conditions")
	}
}

func TestAutomaticFollowingCyclePreservesExistingManagedAccount(t *testing.T) {
	c, accounts, reloads, _ := automaticFixture(t)
	if err := synchronize(c); err != nil {
		t.Fatal(err)
	}
	*accounts = append(*accounts, Account{Name: "b87654321", UID: 1002, Home: "/home/b87654321"})
	if err := synchronize(c); err != nil {
		t.Fatal(err)
	}
	if *reloads != 2 {
		t.Fatal("expected one reload per changed cycle", *reloads)
	}
	for _, name := range []string{"a12345678", "b87654321"} {
		policy, err := sshSettings(c, Account{Name: name})
		if err != nil || checkSSHPolicy(c, policy) != nil {
			t.Fatal("lost managed policy", name, err)
		}
	}
	if _, err := os.Stat(filepath.Join(c.StateDir, "help-requests.json")); !os.IsNotExist(err) {
		t.Fatal("normal synchronization wrote a help queue")
	}
}

func TestAutomaticRecoveryAttemptIsBounded(t *testing.T) {
	c, _, reloads, _ := automaticFixture(t)
	before, _ := safeRead(c.SSHConfig)
	j := &SSHJournal{Version: 1, ID: "interrupted", Phase: "writing-configs", Services: []SSHService{{ID: "allocube-fixture.service", Executable: "/usr/sbin/sshd", Config: c.SSHConfig}}, Files: []SSHFilePlan{{Path: c.SSHConfig, Before: before, After: before, Mode: 0600}}}
	if err := writeJSON(sshJournalPath(c), j, 0600); err != nil {
		t.Fatal(err)
	}
	reloadSSHService = func(SSHService) error { *reloads++; return errors.New("recovery reload failed") }
	if err := autoManageAccounts(c); err == nil {
		t.Fatal("failed recovery not reported")
	}
	count := *reloads
	if count != 1 {
		t.Fatal(count)
	}
	if err := autoManageAccounts(c); err == nil {
		t.Fatal("unfinished recovery not reported")
	}
	if *reloads != count {
		t.Fatal("recovery retried indefinitely")
	}
}
