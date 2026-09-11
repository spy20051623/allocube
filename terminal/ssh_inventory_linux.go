package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type SSHInventory struct {
	Services []SSHService      `json:"services"`
	Files    map[string]string `json:"files"`
}

func inventoryFor(services []SSHService) (SSHInventory, error) {
	inventory := SSHInventory{Services: services, Files: map[string]string{}}
	seen := map[string]bool{}
	for _, s := range services {
		if err := inspectSyncSSH(s.Config, seen, 0); err != nil {
			return inventory, fmt.Errorf("%s (%s): %w", s.ID, s.Config, err)
		}
	}
	for path := range seen {
		data, err := safeRead(path)
		if err != nil {
			return inventory, err
		}
		inventory.Files[path] = digest(string(data))
	}
	return inventory, nil
}
func saveSSHInventory(c Config, services []SSHService) error {
	inventory, err := inventoryFor(services)
	if err != nil {
		return err
	}
	return writeJSON(filepath.Join(c.StateDir, "ssh-inventory.json"), inventory, 0600)
}
func checkSSHInventory(c Config, services []SSHService) error {
	data, err := safeRead(filepath.Join(c.StateDir, "ssh-inventory.json"))
	if os.IsNotExist(err) {
		return errors.New("SSH service coverage has not been confirmed; run allocube-terminal configure-ssh")
	}
	if err != nil {
		return err
	}
	if err = trustedPath(filepath.Join(c.StateDir, "ssh-inventory.json")); err != nil {
		return err
	}
	var previous SSHInventory
	if err = json.Unmarshal(data, &previous); err != nil {
		return err
	}
	now, err := inventoryFor(services)
	if err != nil {
		return err
	}
	if !sameServices(previous.Services, services) || len(previous.Files) != len(now.Files) {
		return errors.New("SSH services or configuration changed; run allocube-terminal configure-ssh")
	}
	for path, hash := range now.Files {
		if previous.Files[path] != hash {
			return fmt.Errorf("%s changed; run allocube-terminal configure-ssh", path)
		}
	}
	j, err := readSSHJournal(c)
	if err != nil {
		return err
	}
	if unfinishedSSH(j) {
		return fmt.Errorf("unfinished SSH operation; next: %s", recoveryCommand(c))
	}
	return nil
}
func checkSSHPolicy(c Config, settings map[string]string) error {
	if settings["passwordauthentication"] != "no" || settings["kbdinteractiveauthentication"] != "no" {
		return errors.New("password and keyboard-interactive authentication must both be disabled")
	}
	if err := checkAdditionalSSHAuth(settings); err != nil {
		return err
	}
	if settings["pubkeyauthentication"] != "yes" || settings["authenticationmethods"] != "publickey" || settings["authorizedkeyscommand"] != "none" || settings["authorizedkeysfile"] != filepath.Join(c.KeyDir, "%u") {
		return errors.New("SSH must use only the Allocube key file, AuthenticationMethods publickey and AuthorizedKeysCommand none; run allocube-terminal configure-ssh")
	}
	return nil
}

// During coverage drift, only remove keys from an already-bound account. A
// verified empty response still revokes keys; network/parser errors never do.
func removalOnly(old, desired []byte) ([]byte, error) {
	canonical, err := canonicalKeys(string(old))
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{}
	for _, line := range strings.Split(string(desired), "\n") {
		allowed[line] = true
	}
	keep := []string{}
	for _, line := range strings.Split(string(canonical), "\n") {
		if line != "" && allowed[line] {
			keep = append(keep, line)
		}
	}
	return canonicalKeys(strings.Join(keep, "\n"))
}
