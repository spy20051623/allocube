package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestManagedBlockPrecedesExistingUserRules(t *testing.T) {
	base := []byte("Port 22\nMatch User a12345678\n    AuthorizedKeysFile .ssh/legacy\nMatch all\n")
	block, _ := sshAccountBlock(Account{Name: "a12345678", UID: 1001}, map[string]string{"pubkeyauthentication": "yes"}, "/keys")
	candidate := sshCandidate(base, []string{block})
	if strings.Index(string(candidate), managedSSHBegin) > strings.Index(string(candidate), "AuthorizedKeysFile .ssh/legacy") {
		t.Fatal("old user rule wins")
	}
	restored, err := originalSSH(candidate)
	if err != nil || !bytes.Equal(restored, base) {
		t.Fatal("original rules not preserved", string(restored), err)
	}
	blocks, names, err := priorSSHBlocks(candidate, restored)
	if err != nil || len(blocks) != 1 || !names["a12345678"] {
		t.Fatal(err)
	}
	if !bytes.Equal(sshCandidate(restored, blocks), candidate) {
		t.Fatal("repeated configuration rewrites unchanged rules")
	}
}
func TestManagedBlockPrecedesIncludedUserRules(t *testing.T) {
	dir := t.TempDir()
	include := filepath.Join(dir, "users.conf")
	body := []byte("Match User a12345678\n AuthorizedKeysFile .ssh/legacy\n")
	if err := os.WriteFile(include, body, 0600); err != nil {
		t.Fatal(err)
	}
	base := []byte("Port 22\nInclude " + include + "\n")
	block, _ := sshAccountBlock(Account{Name: "a12345678", UID: 1001}, map[string]string{"pubkeyauthentication": "yes"}, "/keys")
	candidate := sshCandidate(base, []string{block}, map[string][]byte{include: body})
	if strings.Index(string(candidate), managedSSHBegin) > strings.Index(string(candidate), "Include ") {
		t.Fatal("included user rule wins")
	}
	restored, err := originalSSH(candidate)
	if err != nil || !bytes.Equal(restored, base) {
		t.Fatal("include not preserved", err)
	}
}

func TestManagedSSHBlocksPreservePriorAccounts(t *testing.T) {
	base := []byte("Port 22\nPasswordAuthentication yes\n")
	settings := map[string]string{"pubkeyauthentication": "yes", "authenticationmethods": "any", "authorizedkeysfile": ".ssh/authorized_keys .ssh/authorized_keys2"}
	block, err := sshAccountBlock(Account{Name: "a12345678", UID: 1001}, settings, "/etc/allocube-terminal/synced_keys")
	if err != nil {
		t.Fatal(err)
	}
	original := sshCandidate(base, []string{block})
	stripped, err := originalSSH(original)
	if err != nil {
		t.Fatal(err)
	}
	blocks, names, err := priorSSHBlocks(original, stripped)
	if err != nil || len(blocks) != 1 || !names["a12345678"] || blocks[0] != block {
		t.Fatal(blocks, names, err)
	}
	if strings.Contains(block, ".ssh/authorized_keys") || !strings.Contains(block, "AuthorizedKeysCommand none") || !strings.Contains(block, "AuthenticationMethods publickey") {
		t.Fatal("non-platform SSH source accepted")
	}
	newBlock, _ := sshAccountBlock(Account{Name: "b12345678", UID: 1002}, settings, "/etc/allocube-terminal/synced_keys")
	next := string(sshCandidate(stripped, append(blocks, newBlock)))
	if !strings.Contains(next, block) || !strings.Contains(next, newBlock) {
		t.Fatal("old accounts lost")
	}
	for _, body := range []string{string(original) + "Port 2222\n", string(original) + managedSSHBegin, strings.Replace(string(original), "    PasswordAuthentication no", "    PasswordAuthentication yes", 1)} {
		b, e := originalSSH([]byte(body))
		if e == nil {
			_, _, e = priorSSHBlocks([]byte(body), b)
		}
		if e == nil {
			t.Fatal("edited block accepted")
		}
	}
}

func TestSSHAutomationRejectsRootAndCustomAuthentication(t *testing.T) {
	s := map[string]string{"pubkeyauthentication": "yes", "authorizedkeysfile": ".ssh/authorized_keys"}
	for _, a := range []Account{{Name: "root", UID: 1001}, {Name: "alias", UID: 0}, {Name: "bad\nMatch all", UID: 1001}} {
		if _, e := sshAccountBlock(a, s, "/keys"); e == nil {
			t.Fatal("unsafe account accepted")
		}
	}
	for _, field := range []string{"trustedusercakeys", "authorizedprincipalsfile", "authenticationmethods"} {
		copy := map[string]string{}
		for k, v := range s {
			copy[k] = v
		}
		copy[field] = "custom"
		if _, e := sshAccountBlock(Account{Name: "a12345678", UID: 1001}, copy, "/keys"); e == nil {
			t.Fatal(field)
		}
	}
}
