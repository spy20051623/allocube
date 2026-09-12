package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallerPreservesManualRepairInstructions(t *testing.T) {
	data, err := os.ReadFile("deploy/install.sh")
	if err != nil {
		t.Fatal(err)
	}
	prefix, _, ok := strings.Cut(string(data), "package_dir=")
	if !ok {
		t.Fatal("installer entry point not found")
	}
	log := filepath.Join(t.TempDir(), "install.log")
	message := "SELinux key labels need administrator setup.\nRun these commands once:\n  sudo dnf install /usr/sbin/semanage\n  sudo semanage fcontext -a -t ssh_home_t '/etc/allocube-terminal/synced_keys(/.*)?'\n  sudo restorecon -Rv '/etc/allocube-terminal/synced_keys'"
	if err = os.WriteFile(log, []byte("[OK] Earlier step completed\n[ERROR] "+message+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/bash", "-c", strings.ReplaceAll(prefix, "\r\n", "\n")+"\nlog=$PROBE_LOG\nenrolled=yes\nstep='Preparing SSH access'\nfalse\n")
	cmd.Env = append(os.Environ(), "PROBE_LOG="+log)
	out, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatal("expected installation failure")
	}
	for _, want := range []string{"FAILED: Preparing SSH access", message, "sudo bash ./install.sh"} {
		if !strings.Contains(string(out), want) {
			t.Fatalf("missing %q in output: %s", want, out)
		}
	}
	if strings.Contains(string(out), "[OK] Earlier step") {
		t.Fatal("unrelated logs clutter repair summary")
	}
}
