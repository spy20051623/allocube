package main

import (
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func helpFixture(t *testing.T) (Config, *[]HelpEvent, *bool) {
	c, _, _, _ := automaticFixture(t)
	events := []HelpEvent{}
	unavailable := false
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/terminal/machine/token" {
			fmt.Fprint(w, `{"access_token":"fixture"}`)
			return
		}
		var body struct {
			Events []HelpEvent `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		events = append(events, body.Events...)
		if unavailable {
			w.WriteHeader(503)
			return
		}
		accepted := []map[string]any{}
		for _, e := range body.Events {
			accepted = append(accepted, map[string]any{"eventId": e.EventID, "revision": e.Revision})
		}
		json.NewEncoder(w).Encode(map[string]any{"accepted": accepted})
	}))
	t.Cleanup(server.Close)
	c.Platform = server.URL
	if err := os.WriteFile(c.CAFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	return c, &events, &unavailable
}
func TestHelpOnlyRequestsAndResolutionAreSent(t *testing.T) {
	c, events, _ := helpFixture(t)
	if err := updateHelp(c, nil); err != nil {
		t.Fatal(err)
	}
	if err := updateHelp(c, &RetryError{errors.New("offline")}); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 0 {
		t.Fatal("healthy cycle or network retry sent report")
	}
	failure := needsHelp("SSH_CONFIGURATION", "sshd.service", "UNCHANGED", errors.New("local-only diagnostic: private-details"))
	if err := updateHelp(c, failure); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatal("missing help request")
	}
	first := (*events)[0]
	if first.Severity != "GENERAL" {
		t.Fatal("ordinary report must be general")
	}
	if err := updateHelp(c, failure); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatal("duplicate help transmitted")
	}
	if err := updateHelp(c, &RetryError{errors.New("network failed before recheck")}); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatal("unverified recovery sent")
	}
	if err := updateHelp(c, nil); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 2 || (*events)[1].Status != "RESOLVED" || (*events)[1].EventID != first.EventID {
		t.Fatal("resolution not tied to request")
	}
	if err := updateHelp(c, nil); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 2 {
		t.Fatal("extra success report")
	}
	body, _ := json.Marshal(events)
	if string(body) == "" {
		t.Fatal("empty fixture")
	}
	state, _ := safeRead(filepath.Join(c.StateDir, "help-requests.json"))
	var queue HelpState
	json.Unmarshal(state, &queue)
	if len(queue.Events) != 0 {
		t.Fatal("resolved acknowledgement not removed")
	}
}
func TestHelpSeverityEscalationAndRecovery(t *testing.T) {
	c, events, _ := helpFixture(t)
	for _, outcome := range []string{"UNCHANGED", "RECOVERY_REQUIRED", "RECOVERY_REQUIRED"} {
		if err := updateHelp(c, needsHelp("SSH_CONFIGURATION", "sshd.service", outcome, errors.New("fixture"))); err != nil {
			t.Fatal(err)
		}
	}
	if len(*events) != 2 || (*events)[0].Severity != "GENERAL" || (*events)[1].Severity != "URGENT" || (*events)[0].EventID != (*events)[1].EventID || (*events)[1].Revision != 2 {
		t.Fatalf("invalid severity escalation: %+v", *events)
	}
	if err := updateHelp(c, nil); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 3 || (*events)[2].Status != "RESOLVED" || (*events)[2].Severity != "URGENT" {
		t.Fatal("resolution must retain incident severity")
	}
}
func TestLegacyQueuedResolutionGetsSeverity(t *testing.T) {
	c, events, _ := helpFixture(t)
	event := HelpEvent{EventID: uuid(), Revision: 2, Code: "SSH_RECOVERY", Scope: "sshd.service", Outcome: "RECOVERY_REQUIRED", Status: "RESOLVED", LogPath: filepath.Join(c.StateDir, "help.log")}
	if err := writeJSON(filepath.Join(c.StateDir, "help-requests.json"), HelpState{TerminalID: c.TerminalID, Events: []LocalHelp{{Event: event, Attempted: true}}}, 0600); err != nil {
		t.Fatal(err)
	}
	if err := updateHelp(c, nil); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 || (*events)[0].Severity != "URGENT" || (*events)[0].Revision != 3 || (*events)[0].Status != "RESOLVED" {
		t.Fatalf("invalid legacy queue upgrade: %+v", *events)
	}
}
func TestUnknownHelpDeliveryReplaysSameIDAndResolvesAfterRestart(t *testing.T) {
	c, events, unavailable := helpFixture(t)
	*unavailable = true
	failure := needsHelp("KEY_WRITE", "a12345678", "UNCHANGED", errors.New("write failed"))
	if err := updateHelp(c, failure); err == nil {
		t.Fatal("expected failed delivery")
	}
	first := (*events)[0]
	*unavailable = false
	if err := updateHelp(c, failure); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 2 || (*events)[1] != first {
		t.Fatal("retry changed event identity")
	}
	if err := updateHelp(c, nil); err != nil {
		t.Fatal(err)
	}
	if (*events)[2].Revision != 2 {
		t.Fatal("resolution must advance revision")
	}
}
func TestHelpSurvivesPartialNetworkFailure(t *testing.T) {
	c, events, _ := helpFixture(t)
	failure := needsHelp("SSH_RECOVERY", "", "RECOVERY_REQUIRED", errors.New("recovery failed"))
	if err := updateHelp(c, errors.Join(failure, &RetryError{errors.New("offline")})); err != nil {
		t.Fatal(err)
	}
	if len(*events) != 1 {
		t.Fatal("other actionable error hidden by network failure")
	}
}
