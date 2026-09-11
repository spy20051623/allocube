package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// Only labels on our replacement inode are written. Persistent policy and
// existing files are never relabeled by the terminal; the administrator does
// that explicitly using the commands printed by the preflight check.
var selinux = struct {
	enabled  func() (bool, error)
	actual   func(string) (string, error)
	expected func(string) (string, error)
	set      func(*os.File, string) error
}{
	enabled: func() (bool, error) {
		data, err := os.ReadFile("/sys/fs/selinux/enforce")
		if os.IsNotExist(err) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		switch strings.TrimSpace(string(data)) {
		case "0", "1":
			return true, nil // Prepare labels in permissive mode too.
		default:
			return false, errors.New("cannot determine SELinux state")
		}
	},
	actual: func(path string) (string, error) {
		buf := make([]byte, 4096)
		n, err := unix.Lgetxattr(path, "security.selinux", buf)
		if err != nil {
			return "", err
		}
		return strings.TrimRight(string(buf[:n]), "\x00"), nil
	},
	expected: func(path string) (string, error) {
		for _, tool := range []string{"/usr/sbin/matchpathcon", "/sbin/matchpathcon", "/usr/bin/matchpathcon"} {
			if _, err := os.Stat(tool); err == nil {
				out, err := command(tool, "-n", path)
				return strings.TrimSpace(out), err
			}
		}
		return "", errors.New("matchpathcon is missing; install policycoreutils")
	},
	set: func(file *os.File, label string) error {
		buf := make([]byte, 4096)
		if n, err := unix.Fgetxattr(int(file.Fd()), "security.selinux", buf); err == nil && strings.TrimRight(string(buf[:n]), "\x00") == label {
			return nil
		}
		return unix.Fsetxattr(int(file.Fd()), "security.selinux", []byte(label+"\x00"), 0)
	},
}

func contextType(label string) string {
	parts := strings.SplitN(label, ":", 4)
	if len(parts) != 4 || parts[0] == "" || parts[1] == "" || parts[3] == "" {
		return ""
	}
	return parts[2]
}

func labelAtomicReplacement(file *os.File, path, label string) error {
	enabled, err := selinux.enabled()
	if err != nil {
		return err
	}
	if !enabled {
		return nil
	}
	if label == "" {
		// Preserve the original full context, including administrator-set MLS/MCS
		// ranges, for SSH configuration, recovery, identity and state files.
		label, err = selinux.actual(path)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read SELinux label for %s: %w; file retained", path, err)
		}
	}
	if contextType(label) == "" {
		return fmt.Errorf("invalid SELinux label for %s; file retained", path)
	}
	if err = selinux.set(file, label); err != nil {
		return fmt.Errorf("preserve SELinux label for %s: %w; file retained", path, err)
	}
	return nil
}

func selinuxSetupError(dir string, cause error) error {
	q := func(value string) string { return "'" + escapeShellSingle(value) + "'" }
	// The exact directory is escaped as a regular expression as well as a shell
	// argument. Never print a broad /etc or home-directory relabel command.
	return fmt.Errorf("SELinux key labels need administrator setup (%v). Files unchanged.\n"+
		"Run these commands once, then retry:\n"+
		"  # If semanage is missing on openEuler/RHEL:\n"+
		"  sudo dnf install /usr/sbin/semanage\n"+
		"  sudo semanage fcontext -a -t ssh_home_t %s\n"+
		"  sudo restorecon -Rv %s\n"+
		"If the exact rule already exists, review it before using semanage fcontext -m instead of -a.\n"+
		"Next: sudo allocube-terminal configure-ssh (or resume the installer).",
		cause, q(regexp.QuoteMeta(dir)+"(/.*)?"), q(dir))
}

func safeSELinuxKeyDirectory(c Config) error {
	if err := trustedPath(c.KeyDir); err != nil {
		return err
	}
	// Automated instructions must never suggest relabeling a shared system
	// directory or any of the private material used by the terminal.
	if c.KeyDir == "/" || filepath.Dir(c.KeyDir) == "/" {
		return errors.New("SELinux requires a dedicated public key directory")
	}
	for _, p := range []string{c.IdentityKey, c.ConfigPath, c.StateDir, c.SSHConfig, c.CAFile, "/etc/ssh", "/home", "/root", "/usr", "/var"} {
		if p != "" && (p == c.KeyDir || strings.HasPrefix(p, c.KeyDir+"/")) {
			return errors.New("SELinux requires a dedicated public key directory separate from system files and private state")
		}
	}
	entries, err := os.ReadDir(c.KeyDir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		p := filepath.Join(c.KeyDir, entry.Name())
		st, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if !st.Mode().IsRegular() || st.Sys().(*syscall.Stat_t).Nlink != 1 {
			return fmt.Errorf("SELinux setup needs review: %s is not a private regular key file; no recursive relabel command will be suggested", p)
		}
		if err = trustedPath(p); err != nil {
			return err
		}
	}
	return nil
}

func checkSELinuxKeys(c Config, accounts []Account) error {
	enabled, err := selinux.enabled()
	if err != nil || !enabled || len(accounts) == 0 {
		return err
	}
	if err = safeSELinuxKeyDirectory(c); err != nil {
		return err
	}
	paths := []string{c.KeyDir}
	for _, a := range accounts {
		paths = append(paths, filepath.Join(c.KeyDir, a.Name))
	}
	for _, path := range paths {
		expected, e := selinux.expected(path)
		if e != nil {
			return selinuxSetupError(c.KeyDir, e)
		}
		if contextType(expected) != "ssh_home_t" {
			return selinuxSetupError(c.KeyDir, fmt.Errorf("%s needs a persistent ssh_home_t rule", path))
		}
		actual, e := selinux.actual(path)
		if os.IsNotExist(e) && path != c.KeyDir {
			continue
		}
		if e != nil {
			return selinuxSetupError(c.KeyDir, e)
		}
		if contextType(actual) != "ssh_home_t" {
			return fmt.Errorf("SELinux label on %s is not ssh_home_t. Files unchanged.\nRun: sudo restorecon -v '%s'\nThen retry configure-ssh or resume the installer.", path, escapeShellSingle(path))
		}
	}
	return nil
}

func managedKeyLabel(path string) (string, error) {
	enabled, err := selinux.enabled()
	if err != nil || !enabled {
		return "", err
	}
	dir := filepath.Dir(path)
	actual, actualErr := selinux.actual(path)
	if actualErr != nil && !os.IsNotExist(actualErr) {
		return "", actualErr
	}
	if actualErr == nil && contextType(actual) == "" {
		return "", errors.New("invalid SELinux key label; file retained")
	}
	// This check also runs for unchanged keys, so label drift is reported without
	// rewriting the file. Sync never installs policy or invokes restorecon.
	actualDir, err := selinux.actual(dir)
	if err != nil {
		return actual, err
	}
	if contextType(actualDir) != "ssh_home_t" {
		return actual, fmt.Errorf("SELinux key directory label changed; run configure-ssh for repair instructions; new keys withheld")
	}
	expected, err := selinux.expected(path)
	if err != nil {
		return actual, err
	}
	if contextType(expected) != "ssh_home_t" {
		return actual, errors.New("SELinux key rule missing or changed; run configure-ssh for repair instructions; new keys withheld")
	}
	if os.IsNotExist(actualErr) {
		return expected, nil
	}
	if contextType(actual) != "ssh_home_t" {
		return actual, fmt.Errorf("SELinux key label changed; run sudo restorecon -v '%s'; new keys withheld", escapeShellSingle(path))
	}
	return actual, nil
}
