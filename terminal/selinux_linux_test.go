package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

const testSSHLabel = "system_u:object_r:ssh_home_t:s0"

// Exercise real filesystem inode replacement and xattrs without enabling or
// changing the test host's SELinux policy. Actual enforcing SSH login still
// requires an SELinux-enabled machine.
func mockSELinux(t *testing.T) {
	t.Helper()
	old := selinux
	t.Cleanup(func() { selinux = old })
	selinux.enabled = func() (bool, error) { return true, nil }
	selinux.expected = func(string) (string, error) { return testSSHLabel, nil }
	selinux.actual = func(path string) (string, error) {
		buf := make([]byte, 4096)
		n, err := unix.Lgetxattr(path, "user.allocube_test_label", buf)
		return string(buf[:max(0, n)]), err
	}
	selinux.set = func(f *os.File, label string) error {
		return unix.Fsetxattr(int(f.Fd()), "user.allocube_test_label", []byte(label), 0)
	}
}

func putTestLabel(t *testing.T, path, label string) {
	t.Helper()
	if err := unix.Setxattr(path, "user.allocube_test_label", []byte(label), 0); err != nil {
		t.Fatal(err)
	}
}

func TestSELinuxKeyCreationNoOpAndRevocation(t *testing.T) {
	mockSELinux(t)
	dir := t.TempDir()
	putTestLabel(t, dir, testSSHLabel)
	p := filepath.Join(dir, "a12345678")
	desired, err := canonicalKeys(testKey(t, "new"))
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := replaceKeys(p, desired); err != nil || !changed {
		t.Fatal(changed, err)
	}
	if label, err := selinux.actual(p); err != nil || label != testSSHLabel {
		t.Fatal(label, err)
	}
	before, _ := os.Stat(p)
	set := selinux.set
	selinux.set = func(*os.File, string) error { t.Fatal("unchanged keys must not be relabeled"); return nil }
	if changed, err := replaceKeys(p, desired); err != nil || changed {
		t.Fatal(changed, err)
	}
	after, _ := os.Stat(p)
	if !os.SameFile(before, after) || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("unchanged file rewritten")
	}
	selinux.set = set
	if changed, err := replaceKeys(p, []byte{}); err != nil || !changed {
		t.Fatal(changed, err)
	}
	if label, _ := selinux.actual(p); label != testSSHLabel {
		t.Fatal("revocation lost label", label)
	}
	if data, _ := os.ReadFile(p); len(data) != 0 {
		t.Fatal("revocation did not clear keys")
	}
}

func TestSELinuxAtomicFailureRetainsKeyAndConfig(t *testing.T) {
	mockSELinux(t)
	dir := t.TempDir()
	putTestLabel(t, dir, testSSHLabel)
	for _, name := range []string{"a12345678", "sshd_config"} {
		p := filepath.Join(dir, name)
		os.WriteFile(p, []byte("original"), 0600)
		label := "unconfined_u:object_r:etc_t:s0:c1,c2"
		putTestLabel(t, p, label)
		if err := atomicWrite(p, []byte("replacement"), 0600); err != nil {
			t.Fatal(err)
		}
		if got, _ := selinux.actual(p); got != label {
			t.Fatal("lost full original context", got)
		}
		before, _ := os.Stat(p)
		set := selinux.set
		selinux.set = func(*os.File, string) error { return unix.EPERM }
		if err := atomicWrite(p, []byte("must not apply"), 0600); err == nil {
			t.Fatal("label failure accepted")
		}
		selinux.set = set
		after, _ := os.Stat(p)
		data, _ := os.ReadFile(p)
		if string(data) != "replacement" || !os.SameFile(before, after) {
			t.Fatal("label failure replaced live file")
		}
	}
	files, _ := filepath.Glob(filepath.Join(dir, ".allocube-*"))
	if len(files) != 0 {
		t.Fatal("temporary files leaked")
	}
}

func TestSELinuxKeyDriftFailsEvenWithoutContentChange(t *testing.T) {
	mockSELinux(t)
	dir := t.TempDir()
	putTestLabel(t, dir, testSSHLabel)
	p := filepath.Join(dir, "a12345678")
	os.WriteFile(p, nil, 0644)
	putTestLabel(t, p, "system_u:object_r:etc_t:s0")
	if _, err := replaceKeys(p, nil); err == nil || !strings.Contains(err.Error(), "restorecon") {
		t.Fatal(err)
	}
	putTestLabel(t, p, testSSHLabel)
	selinux.expected = func(string) (string, error) { return "system_u:object_r:etc_t:s0", nil }
	if _, err := replaceKeys(p, nil); err == nil {
		t.Fatal("missing persistent rule accepted")
	}
}

func TestSELinuxPreflightManualInstructionsAndLabelRepair(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("trusted paths require root")
	}
	mockSELinux(t)
	dir, err := os.MkdirTemp("/root", "allocube-selinux-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	c := defaults()
	c.KeyDir = filepath.Join(dir, "keys")
	os.Mkdir(c.KeyDir, 0755)
	a := []Account{{Name: "a12345678", UID: 1000}}
	putTestLabel(t, c.KeyDir, testSSHLabel)
	if err = checkSELinuxKeys(c, a); err != nil {
		t.Fatal(err)
	} // future key file has no inode yet
	expected := selinux.expected
	selinux.expected = func(string) (string, error) { return "system_u:object_r:etc_t:s0", nil }
	err = checkSELinuxKeys(c, a)
	for _, want := range []string{"sudo dnf install /usr/sbin/semanage", "sudo semanage fcontext -a -t ssh_home_t", "sudo restorecon -Rv", "Files unchanged"} {
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Fatal("missing instruction", want, err)
		}
	}
	selinux.expected = expected
	putTestLabel(t, c.KeyDir, "system_u:object_r:etc_t:s0")
	if err = checkSELinuxKeys(c, a); err == nil || !strings.Contains(err.Error(), "restorecon") {
		t.Fatal(err)
	}
	putTestLabel(t, c.KeyDir, testSSHLabel)
	if err = checkSELinuxKeys(c, a); err != nil {
		t.Fatal("manual repair still rejected", err)
	}
	// Never recommend recursive relabeling of private data, links or subtrees.
	c.IdentityKey = filepath.Join(c.KeyDir, "identity.key")
	if err = safeSELinuxKeyDirectory(c); err == nil {
		t.Fatal("identity directory accepted")
	}
	c.IdentityKey = defaults().IdentityKey
	os.Symlink("/etc/passwd", filepath.Join(c.KeyDir, "link"))
	if err = safeSELinuxKeyDirectory(c); err == nil {
		t.Fatal("symlink accepted")
	}
}

func TestSELinuxDisabledAndDetectionFailure(t *testing.T) {
	mockSELinux(t)
	selinux.enabled = func() (bool, error) { return false, nil }
	selinux.actual = func(string) (string, error) { t.Fatal("disabled SELinux read labels"); return "", nil }
	p := filepath.Join(t.TempDir(), "key")
	if _, err := replaceKeys(p, nil); err != nil {
		t.Fatal(err)
	}
	selinux.enabled = func() (bool, error) { return false, errors.New("state unreadable") }
	if err := atomicWrite(p, []byte("must not write"), 0600); err == nil {
		t.Fatal("unreadable SELinux state ignored")
	}
}

func TestSELinuxPolicyDriftStillRemovesRevokedKeys(t *testing.T) {
	mockSELinux(t)
	dir := t.TempDir()
	putTestLabel(t, dir, testSSHLabel)
	p := filepath.Join(dir, "a12345678")
	old, _ := canonicalKeys(testKey(t, "revoked"))
	added, _ := canonicalKeys(testKey(t, "withheld"))
	if _, err := replaceKeys(p, old); err != nil {
		t.Fatal(err)
	}
	selinux.expected = func(string) (string, error) { return "system_u:object_r:etc_t:s0", nil }
	if changed, err := replaceKeys(p, added); !changed || err == nil {
		t.Fatal("must revoke while reporting withheld grants", changed, err)
	}
	if data, _ := os.ReadFile(p); len(data) != 0 {
		t.Fatal("revocation lost or new key granted")
	}
	if label, _ := selinux.actual(p); label != testSSHLabel {
		t.Fatal("existing label changed")
	}
}
