package main

import (
	"bufio"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "[ERROR]", err)
		os.Exit(1)
	}
}
func run() error {
	flags := flag.NewFlagSet("allocube-terminal", flag.ContinueOnError)
	path := flags.String("config", "/etc/allocube-terminal/config.json", "root-owned configuration")
	caFile := flags.String("ca-file", "", "platform CA certificate for init/setup; saved in configuration")
	verbose := flags.Bool("verbose", false, "show detailed SSH configuration checks")
	deferTimer := flags.Bool("defer-timer-start", false, "install service files without starting synchronization (installer use)")
	if err := flags.Parse(os.Args[1:]); err != nil {
		return err
	}
	args := flags.Args()
	if len(args) != 1 {
		return errors.New("commands: init, setup, enroll, rotate, install, start-timer, sync, mappings, status, verify-registration, check-ssh, configure-ssh, recover-ssh, quiet, resume")
	}
	if os.Geteuid() != 0 {
		return errors.New("this command requires root")
	}
	if args[0] == "init" {
		return initializeWithCA(*path, bufio.NewReader(os.Stdin), *caFile)
	}
	if args[0] == "setup" {
		return setupWithCA(*path, bufio.NewReader(os.Stdin), *caFile)
	}
	if *caFile != "" {
		return errors.New("--ca-file is only supported for init/setup")
	}
	c, err := loadConfig(*path)
	if err != nil {
		return err
	}
	if err = trustedConfig(*path, c); err != nil {
		return err
	}
	c.ConfigPath = *path
	switch args[0] {
	case "verify-registration":
		p, err := newPlatform(c)
		if err != nil {
			return err
		}
		_, err = p.token()
		return err
	case "status":
		return installationSummary(c, *path)
	case "enroll":
		return enroll(c)
	case "rotate":
		return rotate(c)
	case "sync":
		return synchronize(c)
	case "mappings":
		return showMappings(c)
	case "check-ssh":
		return checkSSH(c)
	case "recover-ssh":
		return recoverSSH(c)
	case "configure-ssh":
		if !*verbose {
			return configureWithSummary(c, *path)
		}
		return configureSSH(c)
	case "install":
		return installSync(c, *path, *deferTimer)
	case "start-timer":
		return startSyncTimer(c)
	case "quiet":
		if err = atomicWrite(filepath.Join(c.StateDir, "sync-paused"), []byte("paused\n"), 0600); err != nil {
			return err
		}
		_, err = command("/usr/bin/systemctl", "disable", "--now", "allocube-terminal-sync.timer")
		if err == nil {
			_, err = command("/usr/bin/systemctl", "stop", "allocube-terminal-sync.service")
		}
		return err
	case "resume":
		if err = os.Remove(filepath.Join(c.StateDir, "sync-paused")); err != nil && !os.IsNotExist(err) {
			return err
		}
		_, err = command("/usr/bin/systemctl", "enable", "--now", "allocube-terminal-sync.timer")
		return err
	default:
		return errors.New("unknown command; account operations and web login have been removed")
	}
}
func trustedPath(path string) error {
	for p := path; ; p = filepath.Dir(p) {
		st, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 || st.Sys().(*syscall.Stat_t).Uid != 0 || st.Mode().Perm()&0022 != 0 {
			return fmt.Errorf("path must be root-owned, not symlinked or writable by others: %s", p)
		}
		if p == filepath.Dir(p) {
			break
		}
	}
	return nil
}
func trustedConfig(path string, c Config) error {
	for _, p := range []string{path, c.IdentityKey, c.StateDir} {
		if err := trustedPath(p); err != nil {
			return err
		}
	}
	return nil
}
func prompt(r *bufio.Reader, label string) (string, error) {
	if st, err := os.Stdin.Stat(); err == nil && st.Mode()&os.ModeCharDevice != 0 {
		fmt.Fprint(os.Stderr, label+": ")
	}
	line, err := r.ReadString('\n')
	return strings.TrimSpace(line), err
}
func initialize(path string) error {
	return initializeWithReader(path, bufio.NewReader(os.Stdin))
}
func initializeWithReader(path string, r *bufio.Reader) error {
	return initializeWithCA(path, r, "")
}
func initializeWithCA(path string, r *bufio.Reader, caFile string) error {
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		return errors.New("configuration already exists; edit it locally and use enroll")
	}
	c := defaults()
	c.AutoManageNewAccounts = os.Getenv("ALLOCUBE_CONFIGURE_SSH") != "skip"
	c.CAFile = caFile
	var err error
	if c.Platform, err = prompt(r, "Platform HTTPS origin"); err != nil {
		return err
	}
	c.Platform = strings.TrimRight(c.Platform, "/")
	if c.TerminalID, err = prompt(r, "Terminal ID"); err != nil {
		return err
	}
	if err = validateConfig(c); err != nil {
		return err
	}
	for _, p := range []string{filepath.Dir(path), filepath.Dir(c.IdentityKey), c.StateDir, c.KeyDir} {
		if err = os.MkdirAll(p, 0755); err != nil {
			return err
		}
		if err = trustedPath(p); err != nil {
			return err
		}
	}
	if _, err = os.Lstat(c.IdentityKey); !os.IsNotExist(err) {
		return errors.New("identity key already exists; restore configuration")
	}
	if _, err = newKey(c.IdentityKey); err != nil {
		return err
	}
	if err = writeJSON(path, c, 0600); err != nil {
		return err
	}
	if _, err = loadConfig(path); err != nil {
		return err
	}
	return enrollWithReader(c, r)
}

// setup consumes credentials from stdin, never command arguments or a stored plan.
// Re-enrollment preserves machine identity, mappings, paths and pause state.
func setup(path string, r *bufio.Reader) error {
	return setupWithCA(path, r, "")
}
func setupWithCA(path string, r *bufio.Reader, caFile string) error {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return initializeWithCA(path, r, caFile)
	} else if err != nil {
		return err
	}
	c, err := loadConfig(path)
	if err != nil {
		return err
	}
	if err = trustedConfig(path, c); err != nil {
		return err
	}
	if caFile != "" {
		c.CAFile = caFile
	}
	origin, err := prompt(r, "Platform HTTPS origin")
	if err != nil {
		return err
	}
	if strings.TrimRight(origin, "/") != c.Platform {
		return errors.New("existing configuration belongs to another platform; review it locally first")
	}
	if c.TerminalID, err = prompt(r, "Terminal ID"); err != nil {
		return err
	}
	if err = validateConfig(c); err != nil {
		return err
	}
	p, err := newPlatform(c)
	if err != nil {
		return err
	}
	// The input ID may already be enrolled even when the saved ID is still old:
	// enrollment can commit remotely before its response or local save succeeds.
	if _, err = p.token(); err == nil {
		return writeJSON(path, c, 0600)
	}
	if err = enrollWithReader(c, r); err != nil {
		// Only successful proof of possession for this ID resolves an uncertain
		// enrollment. Never replace the saved registration on an unverified error.
		if _, verifyErr := p.token(); verifyErr != nil {
			return err
		}
	}
	return writeJSON(path, c, 0600)
}
func enroll(c Config) error { return enrollWithReader(c, bufio.NewReader(os.Stdin)) }
func enrollWithReader(c Config, r *bufio.Reader) error {
	token, err := prompt(r, "One-time enrollment token (input is not stored)")
	if err != nil {
		return err
	}
	p, err := newPlatform(c)
	if err != nil {
		return err
	}
	proof := base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.Key, []byte("allocube-enroll:"+c.TerminalID+":"+token)))
	var result struct {
		Callback string `json:"callbackUrl"`
	}
	if err = p.post("enroll", "", map[string]string{"terminalId": c.TerminalID, "enrollmentToken": token, "publicKey": publicPEM(p.Key), "proof": proof}, &result); err != nil {
		return err
	}
	return nil
}
func rotate(c Config) error {
	p, err := newPlatform(c)
	if err != nil {
		return err
	}
	next := c.IdentityKey + ".next"
	if _, err = os.Lstat(next); err == nil {
		return errors.New("pending identity.key.next exists; inspect prior rotation before retrying")
	}
	key, err := newKey(next)
	if err != nil {
		return err
	}
	pub := publicPEM(key)
	proof := base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte("allocube-rotate:"+c.TerminalID+":"+digest(pub))))
	if err = p.call("rotate", map[string]string{"publicKey": pub, "proof": proof}, nil); err != nil {
		return fmt.Errorf("rotation outcome uncertain; retain .next and reconcile with platform before retry: %w", err)
	}
	data, err := os.ReadFile(next)
	if err != nil {
		return err
	}
	if err = atomicWrite(c.IdentityKey, data, 0600); err != nil {
		return err
	}
	return os.Remove(next)
}
