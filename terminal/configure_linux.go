package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const managedSSHBegin = "# BEGIN ALLOCUBE PUBLIC KEY SYNC"
const managedSSHEnd = "# END ALLOCUBE PUBLIC KEY SYNC"

func originalSSH(data []byte) ([]byte, error) {
	text := string(data)
	if !strings.Contains(text, managedSSHBegin) && !strings.Contains(text, managedSSHEnd) {
		return data, nil
	}
	if strings.Count(text, managedSSHBegin) != 1 || strings.Count(text, managedSSHEnd) != 1 {
		return nil, errors.New("ambiguous Allocube SSH block; manual review required")
	}
	start := strings.Index(text, managedSSHBegin)
	end := strings.Index(text, managedSSHEnd)
	if end < start || (start > 0 && text[start-1] != '\n') {
		return nil, errors.New("invalid Allocube SSH block boundaries")
	}
	suffix := strings.TrimPrefix(text[end+len(managedSSHEnd):], "\n")
	if strings.TrimSpace(suffix) != "" {
		parts := strings.Fields(suffix)
		if len(parts) == 0 || (!strings.EqualFold(parts[0], "Match") && !strings.EqualFold(parts[0], "Include")) {
			return nil, errors.New("Allocube SSH block must precede an existing Match/Include block or end the file")
		}
	}
	return []byte(text[:start] + suffix), nil
}

// Automatic edits support global and user-only rules. Connection-dependent
// policies cannot be proven safe from one synthetic connection context.
func automaticSSHFiles(path string, rootBody []byte, files map[string][]byte, depth int) error {
	if depth > 12 {
		return errors.New("SSH include nesting too deep")
	}
	if _, ok := files[path]; ok {
		return nil
	}
	if err := trustedPath(path); err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	files[path] = data
	body := data
	if rootBody != nil {
		body = rootBody
	}
	for _, line := range strings.Split(string(body), "\n") {
		parts := strings.Fields(strings.SplitN(line, "#", 2)[0])
		if len(parts) == 0 {
			continue
		}
		if strings.Contains(parts[0], "=") {
			return errors.New("nonstandard SSH option syntax requires manual review")
		}
		switch strings.ToLower(parts[0]) {
		case "match":
			if !(len(parts) == 2 && strings.EqualFold(parts[1], "all")) && !(len(parts) == 3 && strings.EqualFold(parts[1], "user")) {
				return fmt.Errorf("%s: automatic configuration supports Match User and Match all only; connection-dependent rules require manual integration", path)
			}
		case "include":
			for _, pattern := range parts[1:] {
				if strings.ContainsAny(pattern, "\"'\\~$%{}") {
					return errors.New("complex SSH Include paths require manual review")
				}
				if !filepath.IsAbs(pattern) {
					pattern = filepath.Join("/etc/ssh", pattern)
				}
				matches, e := filepath.Glob(pattern)
				if e != nil {
					return e
				}
				for _, next := range matches {
					if e = automaticSSHFiles(next, nil, files, depth+1); e != nil {
						return e
					}
				}
			}
		}
	}
	return nil
}

func unchangedSSHFiles(path string, base []byte, snapshots map[string][]byte) error {
	current := map[string][]byte{}
	if err := automaticSSHFiles(path, base, current, 0); err != nil {
		return err
	}
	if len(current) != len(snapshots) {
		return errors.New("SSH includes changed; rerun configuration")
	}
	for path, old := range snapshots {
		if !bytes.Equal(current[path], old) {
			return errors.New("SSH configuration changed; rerun configuration")
		}
	}
	return nil
}

func sshSettings(c Config, a Account) (map[string]string, error) {
	out, err := command("/usr/sbin/sshd", "-T", "-f", c.SSHConfig, "-C", "user="+a.Name+",host=localhost,addr=127.0.0.1")
	if err != nil {
		return nil, err
	}
	result := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		p := strings.SplitN(line, " ", 2)
		if len(p) == 2 {
			result[p[0]] = p[1]
		}
	}
	return result, nil
}

func sshAccountBlock(a Account, settings map[string]string, keyDir string) (string, error) {
	if a.UID == 0 || a.Name == "root" || !usernamePattern.MatchString(a.Name) {
		return "", errors.New("unsafe SSH account")
	}
	if err := checkAdditionalSSHAuth(settings); err != nil {
		return "", err
	}
	if settings["pubkeyauthentication"] != "yes" {
		return "", errors.New("public key authentication is disabled; manual review required")
	}
	if v := settings["authenticationmethods"]; v != "" && v != "any" && v != "publickey" {
		return "", errors.New("custom authentication methods require manual review")
	}
	managed := filepath.Join(keyDir, "%u")
	if strings.ContainsAny(managed, " \t\r\n\"'\\#") {
		return "", errors.New("unsupported managed keys path")
	}
	return fmt.Sprintf("Match User %s\n    AuthorizedKeysFile %s\n    AuthorizedKeysCommand none\n    AuthenticationMethods publickey\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n", a.Name, managed), nil
}

func sshCandidate(base []byte, blocks []string, snapshots ...map[string][]byte) []byte {
	if len(blocks) == 0 {
		return base
	}
	// Match values are first-wins. Insert before existing user rules, after all
	// global directives, preserving the old rules for unmanaged users.
	text := string(base)
	offset := 0
	at := len(text)
	for _, line := range strings.SplitAfter(text, "\n") {
		fields := strings.Fields(strings.SplitN(line, "#", 2)[0])
		beforeMatch := len(fields) > 0 && strings.EqualFold(fields[0], "Match")
		if len(fields) > 0 && strings.EqualFold(fields[0], "Include") && len(snapshots) > 0 {
			beforeMatch = includeHasMatch(fields[1:], snapshots[0], map[string]bool{})
		}
		if beforeMatch {
			at = offset
			break
		}
		offset += len(line)
	}
	return []byte(strings.TrimRight(text[:at], "\n") + "\n" + managedSSHBegin + "\n" + strings.Join(blocks, "") + "Match all\n" + managedSSHEnd + "\n" + text[at:])
}

func includeHasMatch(patterns []string, files map[string][]byte, seen map[string]bool) bool {
	for _, pattern := range patterns {
		if !filepath.IsAbs(pattern) {
			pattern = filepath.Join("/etc/ssh", pattern)
		}
		matches, _ := filepath.Glob(pattern)
		for _, path := range matches {
			if seen[path] {
				continue
			}
			seen[path] = true
			for _, line := range strings.Split(string(files[path]), "\n") {
				fields := strings.Fields(strings.SplitN(line, "#", 2)[0])
				if len(fields) == 0 {
					continue
				}
				if strings.EqualFold(fields[0], "Match") {
					return true
				}
				if strings.EqualFold(fields[0], "Include") && includeHasMatch(fields[1:], files, seen) {
					return true
				}
			}
		}
	}
	return false
}

func priorSSHBlocks(original, base []byte) ([]string, map[string]bool, error) {
	names := map[string]bool{}
	if bytes.Equal(original, base) {
		return nil, names, nil
	}
	text := string(original)
	start, end := strings.Index(text, managedSSHBegin), strings.Index(text, managedSSHEnd)
	if start < 0 || end < start {
		return nil, nil, errors.New("invalid managed SSH boundaries")
	}
	text = text[start : end+len(managedSSHEnd)]
	text = strings.TrimPrefix(text, managedSSHBegin+"\n")
	text = strings.TrimSuffix(strings.TrimSpace(text), managedSSHEnd)
	text = strings.TrimSuffix(strings.TrimSpace(text), "Match all")
	text = strings.TrimSpace(text)
	pattern := regexp.MustCompile(`(?m)^Match User ([a-zA-Z_][a-zA-Z0-9_.-]{0,31}\$?)\n    AuthorizedKeysFile [^\r\n]+\n(?:    AuthorizedKeysCommand none\n    AuthenticationMethods publickey\n)?    PasswordAuthentication no\n    KbdInteractiveAuthentication no(?:\n|$)`)
	matches := pattern.FindAllStringSubmatch(text, -1)
	remainder := pattern.ReplaceAllString(text, "")
	if strings.TrimSpace(remainder) != "" {
		return nil, nil, errors.New("managed SSH block was edited; manual review required")
	}
	var blocks []string
	for _, m := range matches {
		if names[m[1]] || m[1] == "root" {
			return nil, nil, errors.New("unsafe managed SSH block")
		}
		names[m[1]] = true
		blocks = append(blocks, strings.TrimRight(m[0], "\n")+"\n")
	}
	return blocks, names, nil
}
