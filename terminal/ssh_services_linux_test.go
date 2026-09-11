package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestSSHArgumentPreservation(t *testing.T) {
	for _, args := range [][]string{
		{"/usr/sbin/sshd", "-D", "-f", "/etc/ssh/other.conf", "-p", "2222", "-o", "PasswordAuthentication=yes"},
		{"/usr/sbin/sshd", "-D", "-f/etc/ssh/other.conf", "-p2222", "-oPasswordAuthentication=yes"},
	} {
		path, flags, err := parseSSHArgs(args)
		if err != nil || path != "/etc/ssh/other.conf" || !reflect.DeepEqual(flags, []string{"-p", "2222", "-o", "PasswordAuthentication=yes"}) {
			t.Fatal(path, flags, err)
		}
	}
	for _, args := range [][]string{
		{"/usr/sbin/sshd", "-f", "relative"}, {"/usr/sbin/sshd", "-f", "/one", "-f", "/two"},
		{"/usr/sbin/sshd", "-p"}, {"/usr/sbin/sshd", "-i"}, {"/bin/sh", "-c", "sshd"},
		{"/usr/sbin/sshd", "-o", "Banner=hello", "world"},
		{"/usr/sbin/sshd", "-o", "Include=/etc/ssh/hidden.conf"},
	} {
		if _, _, err := parseSSHArgs(args); err == nil {
			t.Fatal("unsafe argv accepted", args)
		}
	}
}

// Opt-in integration against two disposable host systemd services. The exact
// unit names are fixed so this test can never reload the host's recovery SSH.
func TestDisposableSystemdSSHServices(t *testing.T) {
	if os.Getenv("ALLOCUBE_TEST_SYSTEMD") != "1" {
		t.Skip("requires disposable allocube-multi-test-{one,two}.service units")
	}
	services, err := discoverSSHServices()
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]bool{}
	for _, s := range services {
		if s.ID != "allocube-multi-test-one.service" && s.ID != "allocube-multi-test-two.service" {
			continue
		}
		if found[s.ID] {
			t.Fatal("duplicate canonical service", s.ID)
		}
		found[s.ID] = true
		if err = reloadSSHService(s); err != nil {
			t.Fatal(err)
		}
	}
	if len(found) != 2 {
		t.Fatal("disposable services not discovered", found)
	}
}
func TestSSHInventoryIdentity(t *testing.T) {
	records := systemdRecords("Id=ssh.service\nNames=ssh.service sshd.service\nMainPID=10\n\nId=custom.service\nMainPID=20\n")
	if len(records) != 2 || records[0]["Names"] != "ssh.service sshd.service" {
		t.Fatal(records)
	}
	a := []SSHService{{ID: "ssh.service", PID: 10, Config: "/etc/ssh/sshd_config"}}
	b := append([]SSHService{}, a...)
	b[0].PID = 20
	if !sameServices(a, b) {
		t.Fatal("normal reload PID change invalidates inventory")
	}
	b[0].Config = "/other"
	if sameServices(a, b) {
		t.Fatal("configuration change ignored")
	}
}
func TestCoverageDriftOnlyRemovesKeys(t *testing.T) {
	one, two, three := testKey(t, "one"), testKey(t, "two"), testKey(t, "three")
	old, _ := canonicalKeys(one + "\n" + two)
	desired, _ := canonicalKeys(two + "\n" + three)
	result, err := removalOnly(old, desired)
	expected, _ := canonicalKeys(two)
	if err != nil || !bytes.Equal(result, expected) {
		t.Fatal("new grant or lost removal", err)
	}
	result, err = removalOnly(old, nil)
	if err != nil || len(result) != 0 {
		t.Fatal("empty list did not revoke", err)
	}
	if _, err = removalOnly([]byte("invalid"), nil); err == nil {
		t.Fatal("corrupt old file accepted")
	}
}
func TestSSHRecoveryRejectsExternalEdits(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root ownership required")
	}
	dir, err := os.MkdirTemp("/root", "allocube-journal-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	file := filepath.Join(dir, "sshd_config")
	if err = atomicWrite(file, []byte("administrator change"), 0600); err != nil {
		t.Fatal(err)
	}
	c := Config{StateDir: dir}
	j := &SSHJournal{Version: 1, ID: "test", Phase: "writing-configs", Services: []SSHService{{ID: "test.service"}}, Files: []SSHFilePlan{{Path: file, Before: []byte("before"), After: []byte("after"), Mode: 0600}}}
	if err = writeJSON(sshJournalPath(c), j, 0600); err != nil {
		t.Fatal(err)
	}
	loaded, err := readSSHJournal(c)
	if err != nil || !unfinishedSSH(loaded) {
		t.Fatal(err)
	}
	if err = restoreSSHJournal(c, loaded); err == nil {
		t.Fatal("external edit overwritten")
	}
	data, _ := os.ReadFile(file)
	if string(data) != "administrator change" {
		t.Fatal("external edit lost")
	}
	unlock, err := sshLock(c)
	if err != nil {
		t.Fatal(err)
	}
	if release, err := sshLock(c); err == nil {
		release()
		t.Fatal("concurrent writer allowed")
	}
	unlock()
	j.Phase = "complete"
	if unfinishedSSH(j) {
		t.Fatal("completed operation marked unfinished")
	}
}
