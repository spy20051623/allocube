package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestAutomaticManagementConfigurationDefault(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		want        bool
	}{
		{"legacy", "", true},
		{"enabled", `,"autoManageNewAccounts":true`, true},
		{"explicitly_disabled", `,"autoManageNewAccounts":false`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			data := []byte(`{"platform":"https://example.test","terminalId":"saved","userMapping":{"deploy":null,"worker":"12345678"}` + tc.field + `}`)
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			c, err := loadConfig(path)
			if err != nil || c.AutoManageNewAccounts != tc.want || !explicitlyExcluded(c, "deploy") || c.UserMapping["worker"] == nil || *c.UserMapping["worker"] != "12345678" {
				t.Fatalf("configuration default/preservation failed: %+v %v", c, err)
			}
			after, _ := os.ReadFile(path)
			if string(after) != string(data) {
				t.Fatal("loading configuration rewrote the file")
			}
		})
	}
}

// Exercise the complete shipped Bash entry point against an isolated filesystem
// and fake systemctl/binary. No host services, SSH files or users are modified.
func TestInstallerInstallAndUpgrade(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("installer requires root ownership")
	}
	source, err := os.ReadFile("deploy/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, failure                                            string
		existing, paused, brokenPackage, missingConfig, staleEnv bool
		args                                                     []string
		stuck                                                    bool
	}{
		{name: "fresh"},
		{name: "upgrade", existing: true},
		{name: "resume_alias", existing: true, args: []string{"--resume"}},
		{name: "old_enrollment_command", existing: true, staleEnv: true},
		{name: "paused", existing: true, paused: true},
		{name: "identity_failure", existing: true, failure: "verify-registration"},
		{name: "configure_failure", existing: true, failure: "--verbose configure-ssh"},
		{name: "sync_failure", existing: true, failure: "sync"},
		{name: "bad_package", existing: true, brokenPackage: true},
		{name: "missing_configuration", existing: true, missingConfig: true},
		{name: "running_sync_timeout", existing: true, stuck: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			write := func(path, text string, mode os.FileMode) {
				t.Helper()
				if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(text), mode); err != nil {
					t.Fatal(err)
				}
			}
			paths := []string{"/etc/allocube-terminal", "/usr/local/bin", "/var/backups/allocube-terminal", "/var/log", "/run", "/etc/systemd/system"}
			script := strings.ReplaceAll(string(source), "\r\n", "\n")
			for _, path := range paths {
				script = strings.ReplaceAll(script, path, dir+path)
				if err := os.MkdirAll(dir+path, 0755); err != nil {
					t.Fatal(err)
				}
			}
			arch := "x86_64"
			if runtime.GOARCH == "arm64" {
				arch = "aarch64"
			}
			script = strings.ReplaceAll(script, "__MACHINE__", arch)
			if tc.stuck {
				script = strings.ReplaceAll(script, "SECONDS + 150", "SECONDS + 1")
			}
			config := dir + "/etc/allocube-terminal/config.json"
			binary := dir + "/usr/local/bin/allocube-terminal"
			if tc.existing {
				write(binary, "old program\n", 0755)
				write(dir+"/etc/systemd/system/allocube-terminal-sync.service", "old service\n", 0644)
				if !tc.missingConfig {
					write(config, `{"terminalId":"saved","userMapping":{"deploy":null}}`, 0600)
					write(dir+"/etc/allocube-terminal/identity.key", "saved private identity\n", 0600)
				}
			}
			write(dir+"/mock/systemctl", `#!/bin/bash
set -eu
echo "systemctl $*" >> "$FIXTURE/events"
case "$*" in
  *LoadState*) if [ "$EXISTING" = yes ]; then echo loaded; else echo not-found; fi ;;
  *ActiveState*)
    if [ "${STUCK:-no}" = yes ]; then echo activating; exit 0; fi
    if [ "$EXISTING" = yes ] && [ ! -f "$FIXTURE/waited" ]; then
      touch "$FIXTURE/waited"; echo activating
    else echo inactive; fi ;;
  stop*) touch "$FIXTURE/timer-stopped" ;;
  *) echo 'Unexpected systemctl mutation' >&2; exit 1 ;;
esac
`, 0755)
			program := `#!/bin/bash
set -eu
echo "binary $*" >> "$FIXTURE/events"
if [ "$*" = "$FAILURE" ]; then echo '[ERROR] injected failure'; exit 1; fi
case "$*" in
  setup) cat >/dev/null; echo saved > "$FIXTURE/etc/allocube-terminal/config.json" ;;
  start-timer) if [ "$PAUSED" != yes ]; then touch "$FIXTURE/timer-started"; fi ;;
  status) echo 'Sync status available' ;;
esac
`
			write(dir+"/package/install.sh", script, 0755)
			write(dir+"/package/allocube-terminal", program, 0755)
			sums := fmt.Sprintf("%x  install.sh\n%x  allocube-terminal\n", sha256.Sum256([]byte(script)), sha256.Sum256([]byte(program)))
			write(dir+"/package/SHA256SUMS", sums, 0644)
			if tc.brokenPackage {
				write(dir+"/package/allocube-terminal", "corrupt", 0755)
			}
			env := []string{"PATH=" + dir + "/mock:/usr/bin:/bin", "FIXTURE=" + dir, "FAILURE=" + tc.failure, "EXISTING=no", "PAUSED=no"}
			if tc.existing {
				env = append(env, "EXISTING=yes")
			}
			if tc.paused {
				env = append(env, "PAUSED=yes")
			}
			if tc.stuck {
				env = append(env, "STUCK=yes")
			}
			if !tc.existing || tc.staleEnv {
				env = append(env, "ALLOCUBE_PLATFORM=https://example.test", "ALLOCUBE_TERMINAL_ID=11111111-1111-1111-1111-111111111111", "ALLOCUBE_ENROLL_TOKEN="+strings.Repeat("x", 32))
			}
			cmd := exec.Command("/bin/bash", append([]string{dir + "/package/install.sh"}, tc.args...)...)
			cmd.Env = env
			out, runErr := cmd.CombinedOutput()
			failed := tc.failure != "" || tc.brokenPackage || tc.missingConfig || tc.stuck
			if (runErr != nil) != failed {
				t.Fatalf("unexpected result %v: %s", runErr, out)
			}
			events, _ := os.ReadFile(dir + "/events")
			trace := string(events)
			if tc.stuck {
				got, _ := os.ReadFile(binary)
				if string(got) != "old program\n" || strings.Contains(trace, "systemctl stop allocube-terminal-sync.service") || !strings.Contains(string(out), "It was not interrupted") {
					t.Fatalf("unsafe timeout handling: %s %s", trace, out)
				}
				return
			}
			beforeReplacementFailure := tc.failure == "verify-registration" || tc.brokenPackage || tc.missingConfig
			if beforeReplacementFailure {
				got, _ := os.ReadFile(binary)
				if string(got) != "old program\n" || strings.Contains(trace, "systemctl stop") {
					t.Fatalf("preflight changed installation: %s", trace)
				}
				return
			}
			if tc.existing {
				if strings.Contains(trace, "binary setup") {
					t.Fatal("upgrade attempted enrollment")
				}
				got, _ := os.ReadFile(config)
				key, _ := os.ReadFile(dir + "/etc/allocube-terminal/identity.key")
				if string(got) != `{"terminalId":"saved","userMapping":{"deploy":null}}` || string(key) != "saved private identity\n" {
					t.Fatal("upgrade changed configuration/identity")
				}
				backups, _ := filepath.Glob(dir + "/var/backups/allocube-terminal/upgrade.*")
				if len(backups) != 1 {
					t.Fatal("upgrade backup missing")
				}
				old, _ := os.ReadFile(backups[0] + binary)
				if string(old) != "old program\n" {
					t.Fatal("previous binary missing from backup")
				}
				if !strings.Contains(string(out), "Waiting for the current sync") {
					t.Fatal("did not wait for running service")
				}
			}
			_, startedErr := os.Stat(dir + "/timer-started")
			if failed || tc.paused {
				if startedErr == nil {
					t.Fatal("failed/paused install started timer")
				}
			} else {
				if startedErr != nil {
					t.Fatalf("timer not started: %s", out)
				}
				install := strings.Index(trace, "binary --defer-timer-start install\n")
				sync := strings.Index(trace, "binary sync\n")
				start := strings.Index(trace, "binary start-timer\n")
				if install < 0 || sync <= install || start <= sync {
					t.Fatalf("unsafe install sequence: %s", trace)
				}
				want := "INSTALLED"
				if tc.existing {
					want = "UPGRADED"
				}
				if !strings.Contains(string(out), want) {
					t.Fatalf("missing result: %s", out)
				}
			}
			if failed && !strings.Contains(string(out), "sudo bash ./install.sh") {
				t.Fatalf("missing retry instructions: %s", out)
			}
			if tc.failure != "" {
				// Retry the exact same entry point after correcting the failure,
				// without enrollment credentials or a manual service restart.
				retry := exec.Command("/bin/bash", dir+"/package/install.sh")
				retry.Env = append(env, "FAILURE=")
				out, err := retry.CombinedOutput()
				if err != nil || !strings.Contains(string(out), "UPGRADED") {
					t.Fatalf("retry failed: %v %s", err, out)
				}
				if _, err := os.Stat(dir + "/timer-started"); err != nil {
					t.Fatal("retry did not resume timer")
				}
			}
		})
	}
}

func TestStartTimerPreservesPause(t *testing.T) {
	c := defaults()
	c.StateDir = t.TempDir()
	if err := os.WriteFile(filepath.Join(c.StateDir, "sync-paused"), []byte("paused"), 0600); err != nil {
		t.Fatal(err)
	}
	// Returning before systemctl also ensures this test cannot start host units.
	if err := startSyncTimer(c); err != nil {
		t.Fatal(err)
	}
}
