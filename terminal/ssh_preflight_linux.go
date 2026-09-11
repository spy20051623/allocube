package main

import (
	"errors"
	"fmt"
	"strings"
)

// Certificate-based authentication requires separate policy review. Existing
// key commands and files are disabled only for managed non-root accounts.
func checkAdditionalSSHAuth(settings map[string]string) error {
	for _, name := range []string{"trustedusercakeys", "authorizedprincipalscommand", "authorizedprincipalsfile"} {
		if v := settings[name]; v != "" && v != "none" {
			return fmt.Errorf("SSH certificate authentication (%s) is configured. Automatic integration is not supported; have an SSH administrator review this account", name)
		}
	}
	return nil
}

func sshRuntimeArgs(data []byte) ([]string, error) {
	text := strings.TrimRight(string(data), "\x00")
	// OpenSSH rewrites argv to a process title after becoming a listener.
	if strings.HasPrefix(text, "sshd: ") && !strings.ContainsRune(text, '\x00') {
		start, _, ok := strings.Cut(strings.TrimPrefix(text, "sshd: "), " [listener]")
		if !ok {
			return nil, errors.New("cannot identify the SSH listener command line")
		}
		return strings.Fields(start), nil
	}
	return strings.Split(text, "\x00"), nil
}

func checkSSHRuntimeArgs(args []string) error {
	_, _, err := parseSSHArgs(args)
	return err
}

// Read-only: candidate files are temporary; live SSH and key files are untouched.
func checkSSH(c Config) error {
	plan, err := prepareSSHPlan(c)
	if err != nil {
		return err
	}
	defer plan.close()
	for _, s := range plan.Services {
		fmt.Printf("[OK] %s | %s | %s\n", s.ID, s.Config, s.Listeners)
	}
	fmt.Printf("[OK] %d services, %d configuration files checked.\n", len(plan.Services), len(plan.Files))
	return nil
}
