package main

import (
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func syncResponseFixture(t *testing.T, users ...map[string]any) SyncResponse {
	t.Helper()
	data, err := json.Marshal(map[string]any{"terminalId": "machine", "users": users})
	if err != nil {
		t.Fatal(err)
	}
	var response SyncResponse
	if err = json.Unmarshal(data, &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestBadUserKeysDoNotBlockOtherUsers(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("file ownership check requires root")
	}
	curve := elliptic.P256()
	compressed := "ecdsa-sha2-nistp256 " + base64.StdEncoding.EncodeToString(ssh.Marshal(struct {
		Algorithm, Curve string
		Point            []byte
	}{
		"ecdsa-sha2-nistp256", "nistp256", elliptic.MarshalCompressed(curve, curve.Params().Gx, curve.Params().Gy),
	}))
	if _, err := validateNewKey(compressed); err == nil {
		t.Fatal("compressed SSH point accepted")
	}
	good := testKey(t, "new")
	for _, invalid := range []map[string]any{
		{"status": "OK", "keys": []any{map[string]string{"publicKey": compressed}}},
		{"status": "OK", "keys": []any{map[string]string{"publicKey": good}, map[string]string{"publicKey": "broken"}}},
		{"status": "OK", "keys": nil},
		{"status": "DENIED", "keys": []any{map[string]string{"publicKey": good}}},
		{"status": "UNEXPECTED", "keys": []any{}},
	} {
		invalid["employeeNumber"] = "12345678"
		response := syncResponseFixture(t, invalid,
			map[string]any{"employeeNumber": "12345679", "status": "OK", "keys": []any{map[string]string{"publicKey": good}}},
			map[string]any{"employeeNumber": "12345680", "status": "DENIED", "keys": []any{}},
		)
		normalized, problems, err := normalizeSyncResponse("machine", []string{"12345678", "12345679", "12345680"}, response)
		if err != nil || len(problems) != 1 || !strings.Contains(problems[0].Error(), "12345678") {
			t.Fatal(problems, err)
		}
		if _, exists := normalized["12345678"]; exists {
			t.Fatal("invalid user's keys must be retained, not partially replaced")
		}
		dir := t.TempDir()
		old, _ := canonicalKeys(testKey(t, "old"))
		for _, employee := range []string{"12345678", "12345679", "12345680"} {
			if _, err = replaceKeys(filepath.Join(dir, employee), old); err != nil {
				t.Fatal(err)
			}
		}
		for employee, keys := range normalized {
			if _, err = replaceKeys(filepath.Join(dir, employee), keys); err != nil {
				t.Fatal(err)
			}
		}
		retained, _ := os.ReadFile(filepath.Join(dir, "12345678"))
		updated, _ := os.ReadFile(filepath.Join(dir, "12345679"))
		revoked, _ := os.ReadFile(filepath.Join(dir, "12345680"))
		if string(retained) != string(old) || string(updated) != good+"\n" || len(revoked) != 0 {
			t.Fatal("per-user isolation failed")
		}
	}
}

func TestInvalidSyncEnvelopeRejectsWholeBatch(t *testing.T) {
	user := map[string]any{"employeeNumber": "12345678", "status": "OK", "keys": []any{}}
	for _, response := range []SyncResponse{
		{TerminalID: "other"},
		syncResponseFixture(t),
		syncResponseFixture(t, user, user),
		syncResponseFixture(t, user, map[string]any{"employeeNumber": "99999999", "status": "OK", "keys": []any{}}),
	} {
		keys, _, err := normalizeSyncResponse("machine", []string{"12345678", "12345679"}, response)
		if err == nil || keys != nil {
			t.Fatal("invalid envelope accepted", response)
		}
	}
}
