package main

import (
	"strings"
	"testing"
)

func TestSSHRuntimeCommandLine(t *testing.T) {
	for _, raw := range []string{"/usr/sbin/sshd\x00-D\x00", "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups\x00\x00"} {
		args, err := sshRuntimeArgs([]byte(raw))
		if err != nil || checkSSHRuntimeArgs(args) != nil {
			t.Fatalf("valid listener rejected: %q %v", raw, err)
		}
	}
	for _, raw := range []string{"/usr/sbin/sshd\x00-D\x00$OPTIONS\x00", "sshd: root@pts/0", "/other/wrapper\x00-D\x00"} {
		args, err := sshRuntimeArgs([]byte(raw))
		if err == nil && checkSSHRuntimeArgs(args) == nil {
			t.Fatalf("unsafe listener accepted: %q", raw)
		}
	}
}

func TestManagedSSHDisablesOtherKeySources(t *testing.T) {
	settings := map[string]string{"pubkeyauthentication": "yes", "authorizedkeysfile": ".ssh/authorized_keys", "authorizedkeyscommand": "/usr/bin/cloud-provider --user %u", "authorizedkeyscommanduser": "nobody"}
	block, err := sshAccountBlock(Account{Name: "a12345678", UID: 1001}, settings, "/etc/allocube-terminal/synced_keys")
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"AuthorizedKeysFile /etc/allocube-terminal/synced_keys/%u", "AuthorizedKeysCommand none", "AuthenticationMethods publickey", "PasswordAuthentication no", "KbdInteractiveAuthentication no"} {
		if !strings.Contains(block, required) {
			t.Fatal("missing exclusive SSH rule", required)
		}
	}
	if strings.Contains(block, ".ssh/authorized_keys") || strings.Contains(block, "cloud-provider") {
		t.Fatal("extra source still enabled")
	}
	settings["trustedusercakeys"] = "/etc/ssh/ca.pub"
	if checkAdditionalSSHAuth(settings) == nil {
		t.Fatal("certificate policy accepted without review")
	}
}

func TestPreviousCoexistingSSHBlockCanBeUpgraded(t *testing.T) {
	base := []byte("PasswordAuthentication yes\n")
	old := "Match User a12345678\n    AuthorizedKeysFile .ssh/authorized_keys /etc/allocube-terminal/synced_keys/%u\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n"
	config := sshCandidate(base, []string{old})
	stripped, err := originalSSH(config)
	if err != nil {
		t.Fatal(err)
	}
	blocks, names, err := priorSSHBlocks(config, stripped)
	if err != nil || len(blocks) != 1 || !names["a12345678"] {
		t.Fatal("legacy block not recognized", err)
	}
}
