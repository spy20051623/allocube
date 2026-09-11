package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"golang.org/x/crypto/ssh"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testKey(t *testing.T, comment string) string {
	t.Helper()
	pub, _, e := ed25519.GenerateKey(rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	key, e := ssh.NewPublicKey(pub)
	if e != nil {
		t.Fatal(e)
	}
	return string(ssh.MarshalAuthorizedKey(key))[:len(ssh.MarshalAuthorizedKey(key))-1] + " " + comment
}
func TestMappingPrecedence(t *testing.T) {
	c := defaults()
	c.UserMapping = map[string]*string{"a12345678": mappingValue("87654321"), "custom": mappingValue("12345678"), "b12345678": mappingValue("bad"), "root": mappingValue("12345678"), "alias": mappingValue("12345678")}
	for _, row := range []struct {
		name string
		uid  int
		want string
		bad  bool
	}{{"a12345678", 1001, "87654321", false}, {"c12345678", 1001, "12345678", false}, {"awx123456", 1001, "wx123456", false}, {"custom", 1001, "12345678", false}, {"b12345678", 1001, "", true}, {"root", 1001, "", false}, {"alias", 0, "", false}, {"A12345678", 1001, "", false}, {"123456789", 1001, "", true}, {"daemon", 1, "", false}} {
		got, err := employeeFor(c, Account{Name: row.name, UID: row.uid})
		if got != row.want || (err != nil) != row.bad {
			t.Errorf("%s: got %q %v", row.name, got, err)
		}
	}
	c.DisabledUsers = []string{"a12345678"}
	if got, _ := employeeFor(c, Account{Name: "a12345678", UID: 1001}); got != "" {
		t.Fatal("disabled override ignored")
	}
}
func TestNoRewriteForUnchangedSet(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("file ownership check requires root")
	}
	path := filepath.Join(t.TempDir(), "keys")
	a, b := testKey(t, "a"), testKey(t, "b")
	desired, err := canonicalKeys(a + "\n" + b)
	if err != nil {
		t.Fatal(err)
	}
	if changed, err := replaceKeys(path, desired); !changed || err != nil {
		t.Fatal(changed, err)
	}
	before, _ := os.Stat(path)
	stamp := time.Unix(1000, 0)
	os.Chtimes(path, stamp, stamp)
	reordered, _ := canonicalKeys(b + "\n" + a + "\n" + a)
	if changed, err := replaceKeys(path, reordered); changed || err != nil {
		t.Fatal(changed, err)
	}
	after, _ := os.Stat(path)
	if !os.SameFile(before, after) || !after.ModTime().Equal(stamp) {
		t.Fatal("unchanged keys rewritten")
	}
	if changed, err := replaceKeys(path, []byte{}); !changed || err != nil {
		t.Fatal(changed, err)
	}
	empty, _ := os.ReadFile(path)
	if len(empty) != 0 {
		t.Fatal("explicit empty list not applied")
	}
}
func TestUnsafeKeyFilesRemainUntouched(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "outside")
	os.WriteFile(target, []byte("sentinel"), 0600)
	link := filepath.Join(dir, "keys")
	os.Symlink(target, link)
	if _, err := replaceKeys(link, []byte{}); err == nil {
		t.Fatal("symlink accepted")
	}
	b, _ := os.ReadFile(target)
	if string(b) != "sentinel" {
		t.Fatal("outside file changed")
	}
	restricted := "command=\"true\" " + testKey(t, "restricted")
	if _, err := canonicalKeys(restricted); err == nil {
		t.Fatal("options stripped")
	}
	if _, err := canonicalKeys("-----BEGIN PRIVATE KEY-----"); err == nil {
		t.Fatal("private key accepted")
	}
}
