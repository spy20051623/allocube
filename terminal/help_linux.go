package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Only actionable errors become assistance requests. Raw errors stay on disk.
type HelpError struct {
	Code, Scope, Outcome string
	Cause                error
}

func (e *HelpError) Error() string { return e.Cause.Error() }
func (e *HelpError) Unwrap() error { return e.Cause }
func needsHelp(code, scope, outcome string, err error) error {
	if err == nil {
		return nil
	}
	return &HelpError{code, scope, outcome, err}
}

type RetryError struct{ Cause error }

func (e *RetryError) Error() string { return e.Cause.Error() }
func (e *RetryError) Unwrap() error { return e.Cause }

type HelpEvent struct {
	EventID  string `json:"eventId"`
	Revision int    `json:"revision"`
	Code     string `json:"code"`
	Scope    string `json:"scope"`
	Outcome  string `json:"outcome"`
	Status   string `json:"status"`
	LogPath  string `json:"logPath"`
	Severity string `json:"severity"`
}

func helpSeverity(outcome string) string {
	if outcome == "RECOVERY_REQUIRED" {
		return "URGENT"
	}
	return "GENERAL"
}

type LocalHelp struct {
	Event     HelpEvent `json:"event"`
	Attempted bool      `json:"attempted"`
	Delivered bool      `json:"delivered"`
}
type HelpState struct {
	TerminalID string      `json:"terminalId"`
	Events     []LocalHelp `json:"events"`
}

func helpFind(err error, found map[string]*HelpError) (retry bool) {
	if err == nil {
		return false
	}
	if e, ok := err.(*HelpError); ok {
		key := e.Code + ":" + e.Scope
		rank := map[string]int{"UNCHANGED": 1, "KEYS_WITHHELD": 2, "RESTORED": 3, "RECOVERY_REQUIRED": 4}
		if old, exists := found[key]; !exists || rank[e.Outcome] > rank[old.Outcome] {
			found[key] = e
		}
		return false
	}
	if _, ok := err.(*RetryError); ok {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, e := range joined.Unwrap() {
			if helpFind(e, found) {
				retry = true
			}
		}
		return
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return helpFind(wrapped.Unwrap(), found)
	}
	found["LOCAL_STATE:"] = &HelpError{"LOCAL_STATE", "", "UNCHANGED", err}
	return false
}

// Persist before attempting delivery, including attempts whose HTTP outcome is unknown.
// Successful healthy cycles with no prior requests create no files or network traffic.
func updateHelp(c Config, result error) error {
	path := filepath.Join(c.StateDir, "help-requests.json")
	state := HelpState{TerminalID: c.TerminalID}
	before, err := safeRead(path)
	if err == nil {
		if err = trustedPath(path); err != nil {
			return err
		}
		if len(before) > 256*1024 {
			return errors.New("assistance queue too large")
		}
		if err = json.Unmarshal(before, &state); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if state.TerminalID != c.TerminalID {
		state = HelpState{TerminalID: c.TerminalID}
	}
	if len(state.Events) > 128 {
		return errors.New("assistance queue limit exceeded")
	}
	found := map[string]*HelpError{}
	retry := helpFind(result, found)
	if result != nil {
		// One bounded diagnostic file; no periodic successful-cycle log.
		body := []byte(result.Error())
		if len(body) > 32768 {
			body = body[:32768]
		}
		body = append(body, []byte("\nNext: review this error and run allocube-terminal check-ssh. For an unfinished operation, run allocube-terminal recover-ssh.\n")...)
		previous, _ := safeRead(filepath.Join(c.StateDir, "help.log"))
		if string(previous) != string(body) {
			if err = atomicWrite(filepath.Join(c.StateDir, "help.log"), body, 0600); err != nil {
				return err
			}
		}
	}
	remaining := make([]LocalHelp, 0, len(state.Events))
	for _, item := range state.Events {
		if item.Event.Severity == "" {
			item.Event.Severity = helpSeverity(item.Event.Outcome)
			item.Event.Revision++
			item.Delivered = false
		}
		key := item.Event.Code + ":" + item.Event.Scope
		if current, ok := found[key]; ok && item.Event.Status == "OPEN" {
			if current.Outcome != item.Event.Outcome || item.Event.Severity != helpSeverity(current.Outcome) {
				item.Event.Outcome = current.Outcome
				item.Event.Severity = helpSeverity(current.Outcome)
				item.Event.Revision++
				item.Delivered = false
			}
			delete(found, key)
		} else if !retry && item.Event.Status == "OPEN" {
			if !item.Attempted {
				continue
			} // Transient, never reported: do not notify after it is gone.
			item.Event.Status = "RESOLVED"
			item.Event.Severity = helpSeverity(item.Event.Outcome)
			item.Event.Revision++
			item.Delivered = false
		}
		remaining = append(remaining, item)
	}
	state.Events = remaining
	keys := make([]string, 0, len(found))
	for key := range found {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if len(state.Events) >= 128 {
			return errors.New("assistance queue full; review help.log")
		}
		e := found[key]
		scope := e.Scope
		// Account/service identifiers only; never forward arbitrary error text.
		if len(scope) > 128 || strings.ContainsAny(scope, " /\\\n\r\t") {
			scope = ""
		}
		state.Events = append(state.Events, LocalHelp{Event: HelpEvent{EventID: uuid(), Revision: 1, Code: e.Code, Scope: scope, Outcome: e.Outcome, Status: "OPEN", LogPath: filepath.Join(c.StateDir, "help.log"), Severity: helpSeverity(e.Outcome)}})
	}
	persist := func() error {
		after, e := json.Marshal(state)
		if e != nil {
			return e
		}
		if string(after) == string(before) {
			return nil
		}
		if len(before) == 0 && len(state.Events) == 0 {
			return nil
		}
		if e = atomicWrite(path, after, 0600); e == nil {
			before = after
		}
		return e
	}
	var batch []HelpEvent
	for i := range state.Events {
		if !state.Events[i].Delivered && len(batch) < 16 {
			state.Events[i].Attempted = true
			batch = append(batch, state.Events[i].Event)
		}
	}
	if err = persist(); err != nil {
		return err
	}
	if len(batch) == 0 {
		return nil
	}
	p, err := newPlatform(c)
	if err != nil {
		return err
	}
	var reply struct {
		Accepted []struct {
			EventID  string `json:"eventId"`
			Revision int    `json:"revision"`
		} `json:"accepted"`
	}
	if err = p.call("help", map[string]any{"events": batch}, &reply); err != nil {
		return err
	}
	if len(reply.Accepted) != len(batch) {
		return errors.New("incomplete assistance acknowledgement")
	}
	accepted := map[string]int{}
	for _, a := range reply.Accepted {
		accepted[a.EventID] = a.Revision
	}
	for _, e := range batch {
		if accepted[e.EventID] != e.Revision {
			return errors.New("invalid assistance acknowledgement")
		}
	}
	remaining = nil
	for _, item := range state.Events {
		if accepted[item.Event.EventID] == item.Event.Revision {
			if item.Event.Status == "RESOLVED" {
				continue
			}
			item.Delivered = true
		}
		remaining = append(remaining, item)
	}
	state.Events = remaining
	return persist()
}

func synchronize(c Config) error {
	if _, err := os.Stat(filepath.Join(c.StateDir, "sync-paused")); err == nil {
		fmt.Println("[SKIP] Synchronization is paused.")
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	unlock, err := sshLock(c)
	if err != nil {
		return err
	}
	defer unlock()
	autoErr := autoManageAccounts(c)
	syncErr := synchronizeKeys(c)
	result := errors.Join(autoErr, syncErr)
	if err := updateHelp(c, result); err != nil {
		fmt.Fprintln(os.Stderr, "[HELP] Assistance delivery pending; retrying on the next synchronization:", err)
	}
	return result
}
