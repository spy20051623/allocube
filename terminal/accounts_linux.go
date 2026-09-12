package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"golang.org/x/crypto/ssh"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type Account struct {
	Name     string    `json:"name"`
	UID      int       `json:"uid"`
	GID      int       `json:"gid"`
	Home     string    `json:"home"`
	Shell    string    `json:"shell"`
	Own      bool      `json:"own"`
	Keys     []KeyInfo `json:"keys"`
	KeyError string    `json:"keyError,omitempty"`
}
type KeyInfo struct {
	ID          string   `json:"id"`
	Fingerprint string   `json:"fingerprint"`
	Comment     string   `json:"comment"`
	Options     []string `json:"options"`
}

var usernamePattern = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_.-]{0,31}\$?$`)
var employeePattern = regexp.MustCompile(`^(\d{8}|wx\d{6,7})$`)

func ownName(name, employee string) bool {
	return employeePattern.MatchString(employee) && len(name) == len(employee)+1 && name[0] >= 'a' && name[0] <= 'z' && name[1:] == employee
}

var localAccounts = readLocalAccounts

func readLocalAccounts() ([]Account, error) {
	data, err := os.ReadFile("/etc/passwd")
	if err != nil {
		return nil, err
	}
	var result []Account
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Split(line, ":")
		if len(parts) != 7 {
			continue
		}
		uid, e := strconv.Atoi(parts[2])
		if e != nil {
			continue
		}
		gid, e := strconv.Atoi(parts[3])
		if e != nil {
			continue
		}
		result = append(result, Account{Name: parts[0], UID: uid, GID: gid, Home: parts[5], Shell: parts[6]})
	}
	return result, nil
}
func command(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = []string{"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL=C"}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s failed: %s: %w", filepath.Base(name), strings.TrimSpace(string(out)), err)
	}
	return string(out), nil
}
func keyLines(data string) ([]string, []KeyInfo, error) {
	var lines []string
	var infos []KeyInfo
	for _, line := range strings.Split(data, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, comment, options, rest, err := ssh.ParseAuthorizedKey([]byte(line + "\n"))
		if err != nil || len(bytes.TrimSpace(rest)) != 0 {
			return nil, nil, errors.New("invalid existing authorized_keys entry; manual review required")
		}
		if _, ok := key.(*ssh.Certificate); ok {
			return nil, nil, errors.New("SSH certificates require manual review")
		}
		for _, opt := range options {
			if opt == "cert-authority" {
				return nil, nil, errors.New("SSH CA entries require manual review")
			}
		}
		lines = append(lines, line)
		infos = append(infos, KeyInfo{digest(line), ssh.FingerprintSHA256(key), comment, options})
	}
	return lines, infos, nil
}
func validateNewKey(value string) (string, error) {
	if len(value) > 16384 || strings.ContainsAny(strings.TrimSpace(value), "\r\n") {
		return "", errors.New("provide one public key, not a private key or multiple entries")
	}
	lines, keys, err := keyLines(value)
	if err != nil {
		return "", err
	}
	if len(lines) != 1 || len(keys[0].Options) > 0 {
		return "", errors.New("new public keys must not contain SSH options")
	}
	key, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(lines[0]))
	switch key.Type() {
	case ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521, ssh.KeyAlgoRSA, ssh.KeyAlgoSKED25519, ssh.KeyAlgoSKECDSA256:
	default:
		return "", errors.New("unsupported public key algorithm")
	}
	if c, ok := key.(ssh.CryptoPublicKey); ok {
		if r, ok := c.CryptoPublicKey().(interface{ Size() int }); ok && r.Size() < 256 {
			return "", errors.New("RSA keys must be at least 2048 bits")
		}
	}
	return lines[0] + "\n", nil
}
func safeRead(path string) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() || st.Size() > 1024*1024 {
		return nil, errors.New("unsafe or oversized key file")
	}
	var b bytes.Buffer
	_, err = b.ReadFrom(f)
	return b.Bytes(), err
}
