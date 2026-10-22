package main

import (
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestInstallationConfirmationRequiresLocalCompletionAndRetries(t *testing.T) {
	c, _, _, _ := automaticFixture(t)
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	if err := synchronizeKeys(c); err != nil {
		t.Fatal(err)
	}
	oldReady := installationTimerReady
	t.Cleanup(func() { installationTimerReady = oldReady })
	ready := false
	installationTimerReady = func() bool { return ready }
	calls := 0
	unavailable := true
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/terminal/machine/challenge":
			fmt.Fprint(w, `{"challenge":"abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"}`)
		case "/api/v1/terminal/machine/token":
			fmt.Fprint(w, `{"access_token":"fixture","expires_in":60}`)
		case "/api/v1/terminal/machine/confirm-installation":
			calls++
			if unavailable {
				w.WriteHeader(503)
				return
			}
			if r.Header.Get("Authorization") != "Bearer fixture" {
				t.Error("missing machine authentication")
			}
			fmt.Fprintf(w, `{"terminalId":%q,"confirmedAt":"2026-09-21T12:00:00.000Z"}`, c.TerminalID)
		default:
			w.WriteHeader(503)
		}
	}))
	defer server.Close()
	c.Platform = server.URL
	if err := os.WriteFile(c.CAFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	inventoryPath := filepath.Join(c.StateDir, "ssh-inventory.json")
	inventory, err := os.ReadFile(inventoryPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(inventoryPath); err != nil {
		t.Fatal(err)
	}
	ready = true
	if err = confirmInstallation(c, true); err == nil || calls != 0 {
		t.Fatal("unconfirmed SSH setup reported ready", err, calls)
	}
	if err = os.WriteFile(inventoryPath, inventory, 0600); err != nil {
		t.Fatal(err)
	}
	ready = false
	if err = confirmInstallation(c, false); err != nil || calls != 0 {
		t.Fatal("timer not yet started", err, calls)
	}
	if err = confirmInstallation(c, true); err == nil || calls != 0 {
		t.Fatal("required timer readiness not checked")
	}
	ready = true
	if err = confirmInstallation(c, true); err == nil || calls != 3 {
		t.Fatal("lost confirmation not reported", err, calls)
	}
	if _, err = os.Stat(filepath.Join(c.StateDir, "installation-confirmed")); !os.IsNotExist(err) {
		t.Fatal("failed acknowledgement cached")
	}
	unavailable = false
	if err = confirmInstallation(c, true); err != nil || calls != 4 {
		t.Fatal("retry failed", err, calls)
	}
	if err = confirmInstallation(c, false); err != nil || calls != 4 {
		t.Fatal("repeated confirmation caused another request", err, calls)
	}
	ready = false
	if err = confirmInstallation(c, true); err == nil || calls != 4 {
		t.Fatal("explicit confirmation skipped readiness checks")
	}
	ready = true
	c.TerminalID = "new-registration"
	if err = synchronizeWithConfirmation(c, true); err == nil || calls != 4 {
		t.Fatal("failed key synchronization reported ready", err, calls)
	}
	if err = os.WriteFile(filepath.Join(c.StateDir, "sync-paused"), []byte("paused"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = synchronizeWithConfirmation(c, true); err != nil || calls != 4 {
		t.Fatal("paused installation reported ready", err, calls)
	}
	if err = os.Remove(filepath.Join(c.StateDir, "sync-paused")); err != nil {
		t.Fatal(err)
	}
	if err = confirmInstallation(c, true); err != nil || calls != 5 {
		t.Fatal("new registration reused old completion", err, calls)
	}
}
