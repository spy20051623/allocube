package main

import (
	"os/exec"
	"strings"
	"testing"
)

func TestSummaryCommandsPreserveCustomConfigPath(t *testing.T) {
	if terminalCommand("/etc/allocube-terminal/config.json", "resume") != "sudo allocube-terminal resume" {
		t.Fatal("default command should be short")
	}
	path := "/root/custom config's $(value); config.json"
	output, err := exec.Command("/bin/sh", "-c", "printf '%s' '"+escapeShellSingle(path)+"'").Output()
	if err != nil || string(output) != path {
		t.Fatal("copyable path changed", err)
	}
	if !strings.Contains(terminalCommand(path, "configure-ssh"), "--config '"+escapeShellSingle(path)+"'") {
		t.Fatal("custom config omitted")
	}
}
