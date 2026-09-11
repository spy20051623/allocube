package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func mappingValue(value string) *string { return &value }

func TestRegularSelectionAndExclusions(t *testing.T) {
	c := defaults()
	c.AccountScope = "regular"
	c.RegularUIDMin, c.RegularUIDMax = 1000, 60000
	c.UserMapping = map[string]*string{"a12345678": nil, "custom": mappingValue("87654321"), "daemon": mappingValue("12345678"), "root": mappingValue("12345678"), "nobody": mappingValue("12345678"), "bad": mappingValue("")}
	for _, tc := range []struct {
		name              string
		uid               int
		managed, excluded bool
		employee          string
		bad               bool
	}{
		{"a12345678", 1000, false, true, "", false},
		{"custom", 1000, true, false, "87654321", false},
		{"daemon", 1, true, false, "12345678", false},
		{"developer", 1000, true, false, "", false},
		{"b12345678", 60000, true, false, "12345678", false},
		{"b12345678", 999, false, false, "", false},
		{"b12345678", 60001, false, false, "", false},
		{"root", 1000, false, true, "", false},
		{"custom", 0, false, true, "", false},
		{"nobody", 1000, false, true, "", false},
		{"custom", 65534, false, true, "", false},
		{"custom", 65535, false, true, "", false},
		{"bad", 1000, false, false, "", true},
	} {
		got, err := selectAccount(c, Account{Name: tc.name, UID: tc.uid})
		if got.Managed != tc.managed || got.Excluded != tc.excluded || got.Employee != tc.employee || (err != nil) != tc.bad {
			t.Errorf("%s/%d: %+v, %v", tc.name, tc.uid, got, err)
		}
	}
	c.DisabledUsers = []string{"a12345678", "developer"}
	got, _ := selectAccount(c, Account{Name: "a12345678", UID: 1000})
	if !got.Excluded {
		t.Fatal("explicit exclusion must override legacy pause")
	}
	got, _ = selectAccount(c, Account{Name: "developer", UID: 1000})
	if got.Managed || got.Excluded {
		t.Fatal("legacy pause must not restore authentication")
	}
	c.AccountScope = "named"
	c.DisabledUsers = nil
	got, _ = selectAccount(c, Account{Name: "developer", UID: 1000})
	if got.Managed {
		t.Fatal("default scope expanded implicitly")
	}
}

func TestUIDRangeParsing(t *testing.T) {
	for _, tc := range []struct {
		input     string
		low, high int
		bad       bool
	}{
		{"", 1000, 60000, false},
		{"UID_MIN 2000 # configured\nUID_MAX 5000\nSYS_UID_MIN 100", 2000, 5000, false},
		{"UID_MIN 0", 0, 0, true}, {"UID_MAX 999", 0, 0, true},
		{"UID_MIN 1000\nUID_MIN 2000", 0, 0, true},
		{"UID_MAX unknown", 0, 0, true}, {"UID_MAX 4294967295", 0, 0, true},
	} {
		lo, hi, err := parseRegularUIDRange(tc.input)
		if lo != tc.low || hi != tc.high || (err != nil) != tc.bad {
			t.Errorf("%q: %d %d %v", tc.input, lo, hi, err)
		}
	}
}

func TestNullableMappingRoundTrip(t *testing.T) {
	c := defaults()
	if err := json.Unmarshal([]byte(`{"userMapping":{"deploy":null,"custom":"12345678","empty":""}}`), &c); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var next Config
	if err = json.Unmarshal(data, &next); err != nil {
		t.Fatal(err)
	}
	if !explicitlyExcluded(next, "deploy") || explicitlyExcluded(next, "empty") || explicitlyExcluded(next, "absent") {
		t.Fatal("null mapping lost or empty mapping treated as exclusion")
	}
	if next.AccountScope != "named" {
		t.Fatal("default scope changed")
	}
}

func TestExclusionRestoresOnlySelectedBlocks(t *testing.T) {
	c := defaults()
	c.SSHConfig = filepath.Join(t.TempDir(), "sshd_config")
	c.UserMapping = map[string]*string{"a12345678": nil}
	c.DisabledUsers = []string{"b12345678"}
	base := []byte("PasswordAuthentication yes\n")
	var blocks []string
	for _, name := range []string{"a12345678", "b12345678", "c12345678"} {
		block, err := sshAccountBlock(Account{Name: name, UID: 1000}, map[string]string{"pubkeyauthentication": "yes"}, c.KeyDir)
		if err != nil {
			t.Fatal(err)
		}
		blocks = append(blocks, block)
	}
	if err := os.WriteFile(c.SSHConfig, sshCandidate(base, blocks), 0600); err != nil {
		t.Fatal(err)
	}
	accounts := []Account{{Name: "a12345678", UID: 1000}, {Name: "b12345678", UID: 1001}, {Name: "c12345678", UID: 1002}, {Name: "root", UID: 0}}
	restoring, err := exclusionsToRestore(c, accounts)
	if err != nil || len(restoring) != 1 || restoring[0].Name != "a12345678" {
		t.Fatalf("%+v %v", restoring, err)
	}
	if string(sshCandidate(base, nil)) != string(base) {
		t.Fatal("empty policy should leave no managed block")
	}
}
