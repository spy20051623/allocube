package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// A small actionable summary; mappings/check-ssh remain the detailed inspection commands.
func installationSummary(c Config, path string) error {
	accounts, err := localAccounts()
	if err != nil {
		return err
	}
	managed, excluded, empty := 0, 0, 0
	for _, a := range accounts {
		selection, err := selectAccount(c, a)
		if err != nil {
			return err
		}
		if explicitlyExcluded(c, a.Name) {
			excluded++
		}
		if !selection.Managed {
			continue
		}
		managed++
		keys, err := safeRead(filepath.Join(c.KeyDir, a.Name))
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if len(bytes.TrimSpace(keys)) == 0 {
			empty++
		}
	}
	fmt.Printf("Accounts: %d managed, %d explicitly excluded, %d without keys.\n", managed, excluded, empty)
	fmt.Printf("Configuration: %s\n", path)
	services, coverageErr := discoverSSHServices()
	if coverageErr == nil {
		coverageErr = checkSSHInventory(c, services)
	}
	if coverageErr != nil {
		fmt.Printf("SSH coverage: NEEDS ATTENTION (%v).\n", coverageErr)
	} else {
		fmt.Printf("SSH coverage: %d services confirmed.\n", len(services))
	}
	if j, e := readSSHJournal(c); e != nil {
		return e
	} else if unfinishedSSH(j) {
		fmt.Printf("Recovery required: %s\n", terminalCommand(path, "recover-ssh"))
	}

	if _, err := os.Stat(filepath.Join(c.StateDir, "sync-paused")); err == nil {
		fmt.Printf("PAUSED. Next: %s\n", terminalCommand(path, "resume"))
	} else if !os.IsNotExist(err) {
		return err
	} else if managed == 0 {
		fmt.Printf("No accounts managed. To change this:\n  sudoedit '%s'\n  %s\n", escapeShellSingle(path), terminalCommand(path, "configure-ssh"))
	} else if empty > 0 {
		fmt.Println("Accounts without keys cannot log in through Allocube. To grant access: Allocube > Public keys > Manage > select this machine.")
	} else {
		fmt.Println("Next: test a new SSH connection with your private key.")
	}
	if managed > 0 {
		fmt.Printf("To change mappings or exclusions: sudoedit '%s'\nThen: %s\n", escapeShellSingle(path), terminalCommand(path, "configure-ssh"))
	}
	return nil
}

func escapeShellSingle(value string) string {
	// Paths are supplied by root but still must be quoted correctly in copyable commands.
	return strings.ReplaceAll(value, "'", "'\"'\"'")
}

func terminalCommand(path, action string) string {
	if path == "/etc/allocube-terminal/config.json" {
		return "sudo allocube-terminal " + action
	}
	return "sudo allocube-terminal --config '" + escapeShellSingle(path) + "' " + action
}

func configureWithSummary(c Config, path string) error {
	if err := os.MkdirAll("/var/log", 0755); err != nil {
		return err
	}
	if err := trustedPath("/var/log"); err != nil {
		return err
	}
	log, err := os.CreateTemp("/var/log", "allocube-terminal-ssh-*.log")
	if err != nil {
		return err
	}
	output, stderr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = log, log
	err = configureSSH(c)
	if err != nil {
		fmt.Fprintln(log, "[ERROR]", err)
	}
	os.Stdout, os.Stderr = output, stderr
	log.Close()
	if err != nil {
		return fmt.Errorf("%w\nConfiguration: %s\nDetails: sudo cat %s", err, path, log.Name())
	}
	fmt.Println("SSH configuration check completed.")
	if err = installationSummary(c, path); err != nil {
		return err
	}
	fmt.Printf("Details: sudo cat %s\n", log.Name())
	return nil
}
