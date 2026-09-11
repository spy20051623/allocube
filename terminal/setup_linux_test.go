package main

import (
	"bufio"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupPreservesConfigurationAndIdentity(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("trusted configuration requires root")
	}
	dir, err := os.MkdirTemp("/root", "allocube-setup-test-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	accepted := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if r.URL.Path != "/api/v1/terminal/machine/enroll" || json.NewDecoder(r.Body).Decode(&body) != nil || body["terminalId"] != "new-terminal" || body["enrollmentToken"] != "one-time" {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		accepted = true
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`))
	}))
	defer server.Close()
	ca := filepath.Join(dir, "ca.pem")
	os.WriteFile(ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600)
	c := defaults()
	c.CAFile = ca
	c.Platform, c.TerminalID = server.URL, "old-terminal"
	c.IdentityKey, c.SSHConfig = filepath.Join(dir, "identity.key"), filepath.Join(dir, "sshd_config")
	c.StateDir, c.KeyDir = dir, filepath.Join(dir, "keys")
	c.UserMapping = map[string]*string{"developer": mappingValue("12345678"), "deploy": nil}
	c.AccountScope = "regular"
	c.DisabledUsers, c.IntervalSeconds = []string{"a12345678"}, 900
	newKey(c.IdentityKey)
	os.WriteFile(c.SSHConfig, []byte("# unchanged"), 0600)
	path := filepath.Join(dir, "config.json")
	if err = writeJSON(path, c, 0600); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	key, _ := os.ReadFile(c.IdentityKey)
	for _, input := range []string{"https://other.example.com\nnew-terminal\none-time\n", server.URL + "\nnew-terminal\ninvalid\n"} {
		if err = setup(path, bufio.NewReader(strings.NewReader(input))); err == nil {
			t.Fatal("invalid enrollment accepted")
		}
		after, _ := os.ReadFile(path)
		if string(before) != string(after) {
			t.Fatal("failed enrollment modified existing configuration")
		}
	}
	c.CAFile = ""
	if err = writeJSON(path, c, 0600); err != nil {
		t.Fatal(err)
	}
	if err = setup(path, bufio.NewReader(strings.NewReader(server.URL+"\nnew-terminal\none-time\n"))); err == nil || !strings.Contains(err.Error(), "not trusted") {
		t.Fatal("untrusted CA must fail explicitly", err)
	}
	if err = setupWithCA(path, bufio.NewReader(strings.NewReader(server.URL+"\nnew-terminal\none-time\n")), ca); err != nil {
		t.Fatal(err)
	}
	after, err := loadConfig(path)
	if err != nil || !accepted || after.CAFile != ca || after.TerminalID != "new-terminal" || (after.UserMapping["developer"] == nil || *after.UserMapping["developer"] != "12345678") || after.IntervalSeconds != 900 || after.DisabledUsers[0] != "a12345678" || after.KeyDir != c.KeyDir || after.IdentityKey != c.IdentityKey {
		t.Fatal("configuration not preserved", after, err)
	}
	newKey, _ := os.ReadFile(c.IdentityKey)
	if !explicitlyExcluded(after, "deploy") || after.AccountScope != "regular" {
		t.Fatal("account scope or exclusion lost during enrollment")
	}
	if string(newKey) != string(key) {
		t.Fatal("identity changed")
	}
	data, _ := os.ReadFile(path)
	if strings.Contains(string(data), "one-time") {
		t.Fatal("enrollment token persisted")
	}
}

func TestInitRejectsInvalidPlatformBeforeWriting(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := initializeWithReader(path, bufio.NewReader(strings.NewReader("http://insecure.test\nterminal\ntoken\n"))); err == nil {
		t.Fatal("accepted HTTP")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("invalid input wrote configuration")
	}
}
