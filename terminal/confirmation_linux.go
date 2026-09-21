package main

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var installationTimerReady = func() bool {
	active, err := command("/usr/bin/systemctl", "is-active", "allocube-terminal-sync.timer")
	if err != nil || strings.TrimSpace(active) != "active" {
		return false
	}
	enabled, err := command("/usr/bin/systemctl", "is-enabled", "allocube-terminal-sync.timer")
	return err == nil && strings.TrimSpace(enabled) == "enabled"
}

// Called under the SSH lock, only after a successful complete synchronization.
// Registration, key previews and declined SSH confirmation never reach this path.
func confirmInstallation(c Config, required bool) error {
	p, err := newPlatform(c)
	if err != nil {
		return err
	}
	stamp := digest(c.Platform + ":" + c.TerminalID + ":" + string(p.Key[ed25519.SeedSize:]))
	path := filepath.Join(c.StateDir, "installation-confirmed")
	previous, err := safeRead(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if string(previous) == stamp && !required {
		return nil
	}
	services, err := discoverSSHServices()
	if err != nil {
		return err
	}
	if err = checkSSHInventory(c, services); err != nil {
		return err
	}
	if !installationTimerReady() {
		if required {
			return errors.New("installation is not confirmed: the sync timer must be enabled and active")
		}
		return nil
	}
	var response struct {
		TerminalID  string `json:"terminalId"`
		ConfirmedAt string `json:"confirmedAt"`
	}
	if err = p.call("confirm-installation", map[string]int{"protocolVersion": 1}, &response); err != nil {
		return err
	}
	if _, err = time.Parse(time.RFC3339, response.ConfirmedAt); err != nil || response.TerminalID != c.TerminalID {
		return errors.New("invalid installation confirmation response; retrying is safe")
	}
	if err = atomicWrite(path, []byte(stamp), 0600); err != nil {
		return err
	}
	fmt.Println("[OK] Installation completion confirmed by Allocube.")
	return nil
}
