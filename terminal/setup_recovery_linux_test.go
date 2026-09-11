package main

import (
	"bufio"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSetupRecoversCommittedEnrollment(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("trusted configuration requires root")
	}
	for _, delayed := range []bool{false, true} {
		t.Run(fmt.Sprintf("delayed_verification_%t", delayed), func(t *testing.T) {
			dir, err := os.MkdirTemp("/root", "allocube-setup-recovery-")
			if err != nil {
				t.Fatal(err)
			}
			defer os.RemoveAll(dir)
			c := defaults()
			c.TerminalID = "old-terminal"
			c.StateDir = dir
			c.KeyDir = filepath.Join(dir, "keys")
			c.IdentityKey = filepath.Join(dir, "identity.key")
			c.SSHConfig = filepath.Join(dir, "sshd_config")
			c.CAFile = filepath.Join(dir, "ca.pem")
			c.UserMapping = map[string]*string{"deploy": nil, "worker": mappingValue("12345678")}
			key, err := newKey(c.IdentityKey)
			if err != nil {
				t.Fatal(err)
			}
			enrolled, enrollCalls, authenticated := false, 0, 0
			delay := delayed
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]string
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					w.WriteHeader(400)
					return
				}
				if strings.HasSuffix(r.URL.Path, "/token") {
					parts := strings.Split(body["client_assertion"], ".")
					valid := false
					if len(parts) == 3 {
						sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
						valid = ed25519.Verify(key.Public().(ed25519.PublicKey), []byte(parts[0]+"."+parts[1]), sig)
					}
					if !enrolled || body["client_id"] != "new-terminal" || !valid {
						w.WriteHeader(401)
						return
					}
					if delay {
						delay = false
						w.WriteHeader(503)
						return
					}
					authenticated++
					fmt.Fprint(w, `{"access_token":"new-machine-credential"}`)
					return
				}
				if body["terminalId"] != "new-terminal" || body["publicKey"] != publicPEM(key) || body["enrollmentToken"] != "one-time" || enrolled {
					w.WriteHeader(401)
					return
				}
				enrolled = true
				enrollCalls++
				conn, _, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				conn.Close()
			}))
			defer server.Close()
			c.Platform = server.URL
			if err = os.WriteFile(c.CAFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(c.SSHConfig, []byte("# unchanged"), 0600); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "config.json")
			if err = writeJSON(path, c, 0600); err != nil {
				t.Fatal(err)
			}
			before, _ := os.ReadFile(path)
			input := server.URL + "\nnew-terminal\none-time\n"
			err = setup(path, bufio.NewReader(strings.NewReader(input)))
			if delayed {
				if err == nil {
					t.Fatal("unverified remote state must not be saved")
				}
				after, _ := os.ReadFile(path)
				if string(after) != string(before) {
					t.Fatal("failed verification changed configuration")
				}
				// Repeating the original command succeeds despite its consumed token.
				err = setup(path, bufio.NewReader(strings.NewReader(input)))
			}
			if err != nil {
				t.Fatal(err)
			}
			saved, err := loadConfig(path)
			if err != nil || saved.TerminalID != "new-terminal" || enrollCalls != 1 || authenticated != 1 {
				t.Fatal(saved, err, enrollCalls, authenticated)
			}
			if !explicitlyExcluded(saved, "deploy") || *saved.UserMapping["worker"] != "12345678" {
				t.Fatal("mapping changed")
			}
			savedKey, err := readKey(c.IdentityKey)
			if err != nil || !key.Equal(savedKey) {
				t.Fatal("identity key changed")
			}
			data, _ := os.ReadFile(path)
			if strings.Contains(string(data), "one-time") {
				t.Fatal("enrollment token persisted")
			}
		})
	}
}
