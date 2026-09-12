package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Runtime-only fields are not user supplied. A service is identified by systemd
// Id, never by a guessed distribution-specific alias.
type SSHService struct {
	ID         string   `json:"id"`
	Names      string   `json:"names"`
	PID        int      `json:"-"`
	Executable string   `json:"executable"`
	Config     string   `json:"config"`
	Args       []string `json:"args"`
	Sockets    string   `json:"sockets,omitempty"`
	Listeners  string   `json:"listeners"`
}

func parseSSHArgs(args []string) (string, []string, error) {
	if len(args) == 0 || !filepath.IsAbs(args[0]) || filepath.Base(args[0]) != "sshd" {
		return "", nil, errors.New("expected an absolute OpenSSH sshd executable")
	}
	config := "/etc/ssh/sshd_config"
	var result []string
	seenConfig := false
	for i := 1; i < len(args); i++ {
		a := args[i]
		switch a {
		case "-D", "-e", "-q":
			continue
		case "-4", "-6":
			result = append(result, a)
			continue
		}
		if len(a) < 2 || a[0] != '-' {
			return "", nil, fmt.Errorf("cannot safely interpret SSH argument %q; use separate, unambiguous arguments in the service ExecStart", a)
		}
		flag := a[:2]
		if !strings.Contains(" f p o h c E g u ", " "+flag[1:]+" ") {
			return "", nil, fmt.Errorf("unsupported SSH argument %q; keep the service unchanged and review its ExecStart", a)
		}
		value := a[2:]
		if value == "" {
			i++
			if i >= len(args) {
				return "", nil, fmt.Errorf("missing value for %s", flag)
			}
			value = args[i]
		}
		if value == "" || strings.ContainsAny(value, "\x00\r\n\"'") {
			return "", nil, fmt.Errorf("ambiguous value for %s", flag)
		}
		if flag == "-o" {
			parts := strings.Fields(strings.ReplaceAll(value, "=", " "))
			if len(parts) < 2 || strings.EqualFold(parts[0], "Include") || strings.EqualFold(parts[0], "Match") {
				return "", nil, errors.New("SSH -o Include/Match or ambiguous option cannot be inspected safely; move it to the configuration file, then rerun check-ssh")
			}
		}
		if flag == "-f" {
			if seenConfig || !filepath.IsAbs(value) || filepath.Clean(value) != value {
				return "", nil, errors.New("SSH -f must specify one absolute configuration path")
			}
			config = value
			seenConfig = true
		} else if flag != "-E" {
			result = append(result, flag, value)
		}
	}
	return config, result, nil
}

func systemdRecords(out string) []map[string]string {
	var records []map[string]string
	for _, block := range strings.Split(strings.TrimSpace(out), "\n\n") {
		r := map[string]string{}
		for _, line := range strings.Split(block, "\n") {
			k, v, ok := strings.Cut(line, "=")
			if ok {
				r[k] = v
			}
		}
		if r["Id"] != "" {
			records = append(records, r)
		}
	}
	return records
}

var discoverSSHServices = discoverSystemSSHServices

func discoverSystemSSHServices() ([]SSHService, error) {
	out, err := command("/usr/bin/systemctl", "list-units", "--type=service", "--state=running", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil, fmt.Errorf("cannot enumerate systemd services: %w", err)
	}
	units := []string{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) > 0 && strings.HasSuffix(f[0], ".service") {
			units = append(units, f[0])
		}
	}
	if len(units) == 0 {
		return nil, errors.New("no running systemd services found; run systemctl list-units --type=service")
	}
	args := append([]string{"show", "--no-pager", "--property=Id,Names,MainPID,TriggeredBy,CanReload,RootDirectory,RootImage"}, units...)
	out, err = command("/usr/bin/systemctl", args...)
	if err != nil {
		return nil, err
	}
	var services []SSHService
	seen := map[string]bool{}
	pids := map[int]bool{}
	for _, r := range systemdRecords(out) {
		pid, _ := strconv.Atoi(r["MainPID"])
		if pid <= 1 || seen[r["Id"]] || pids[pid] {
			continue
		}
		proc := filepath.Join("/proc", strconv.Itoa(pid))
		exe, e := os.Readlink(filepath.Join(proc, "exe"))
		if e != nil {
			continue
		}
		if filepath.Base(strings.TrimSuffix(exe, " (deleted)")) != "sshd" {
			continue
		}
		fail := func(e error) ([]SSHService, error) {
			return nil, fmt.Errorf("%s: %w; inspect: systemctl cat %s", r["Id"], e, r["Id"])
		}
		if strings.HasSuffix(exe, " (deleted)") {
			return fail(errors.New("running SSH executable was replaced; reload the service to use its installed executable before configuring SSH"))
		}
		if r["RootDirectory"] != "" || r["RootImage"] != "" {
			continue
		} // Different account database, outside this host's scope.
		local, e := os.Stat("/etc/passwd")
		remote, re := os.Stat(filepath.Join(proc, "root/etc/passwd"))
		if e != nil || re != nil || !os.SameFile(local, remote) {
			continue
		}
		if e = trustedPath(exe); e != nil {
			return fail(e)
		}
		raw, e := os.ReadFile(filepath.Join(proc, "cmdline"))
		if e != nil {
			return fail(e)
		}
		argv, e := sshRuntimeArgs(raw)
		if e != nil {
			return fail(e)
		}
		config, opts, e := parseSSHArgs(argv)
		if e != nil {
			return fail(e)
		}
		actual, e := os.Stat(exe)
		claimed, ce := os.Stat(argv[0])
		if e != nil || ce != nil || !os.SameFile(actual, claimed) {
			return fail(errors.New("listener executable differs from its command line"))
		}
		if r["CanReload"] != "yes" {
			return fail(errors.New("service has no reload support; add ExecReload=/bin/kill -HUP $MAINPID to its [Service] drop-in and run systemctl daemon-reload"))
		}
		names, sockets := strings.Fields(r["Names"]), strings.Fields(r["TriggeredBy"])
		sort.Strings(names)
		sort.Strings(sockets)
		s := SSHService{ID: r["Id"], Names: strings.Join(names, " "), PID: pid, Executable: exe, Config: config, Args: opts, Sockets: strings.Join(sockets, " ")}
		settings, e := serviceSettings(s, config, Account{Name: "root"})
		if e != nil {
			return fail(e)
		}
		s.Listeners = settings["listenaddress"]
		seen[s.ID] = true
		pids[pid] = true
		services = append(services, s)
	}
	// A wrapper's child or an unmanaged listener must not silently escape coverage.
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		pid, e := strconv.Atoi(entry.Name())
		if e != nil || pids[pid] {
			continue
		}
		proc := filepath.Join("/proc", entry.Name())
		exe, e := os.Readlink(filepath.Join(proc, "exe"))
		if e != nil || filepath.Base(exe) != "sshd" {
			continue
		}
		raw, e := os.ReadFile(filepath.Join(proc, "cmdline"))
		if e != nil {
			continue
		}
		title := string(raw)
		if !strings.Contains(title, "[listener]") {
			continue
		}
		a, ae := os.Stat("/etc/passwd")
		b, be := os.Stat(filepath.Join(proc, "root/etc/passwd"))
		if ae != nil || be != nil || !os.SameFile(a, b) {
			continue
		}
		return nil, fmt.Errorf("SSH listener PID %d is not a reloadable systemd MainPID. Use a direct sshd ExecStart (Type=simple with -D, or correct PIDFile for Type=forking); inspect: systemctl status %d", pid, pid)
	}
	if len(services) == 0 {
		return nil, errors.New("no supported running OpenSSH service found; inspect: systemctl list-units --type=service")
	}
	if err := checkDormantSSHSockets(pids); err != nil {
		return nil, err
	}
	sort.Slice(services, func(i, j int) bool { return services[i].ID < services[j].ID })
	return services, nil
}

func serviceCommand(s SSHService, path, mode string, extra ...string) (string, error) {
	args := append([]string{}, s.Args...)
	args = append(args, mode, "-f", path)
	args = append(args, extra...)
	out, err := command(s.Executable, args...)
	if err != nil {
		return "", fmt.Errorf("%s (%s): %w", s.ID, path, err)
	}
	return out, nil
}
func serviceSettings(s SSHService, path string, a Account) (map[string]string, error) {
	out, err := serviceCommand(s, path, "-T", "-C", "user="+a.Name+",host=localhost,addr=127.0.0.1")
	if err != nil {
		return nil, err
	}
	result := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(line, " ")
		if ok {
			if old, exists := result[k]; exists {
				result[k] = old + "; " + v
			} else {
				result[k] = v
			}
		}
	}
	return result, nil
}
func sameServices(a, b []SSHService) bool {
	copyOf := func(v []SSHService) []SSHService {
		r := append([]SSHService{}, v...)
		for i := range r {
			r[i].PID = 0
		}
		return r
	}
	return reflect.DeepEqual(copyOf(a), copyOf(b))
}

// A successful ExecReload can mean only that SIGHUP was sent. Wait until the
// listener has replaced its listening sockets before claiming it is ready.
func listenerSockets(pid int) (map[string]string, error) {
	proc := filepath.Join("/proc", strconv.Itoa(pid))
	fds, err := os.ReadDir(filepath.Join(proc, "fd"))
	if err != nil {
		return nil, err
	}
	owned := map[string]bool{}
	for _, fd := range fds {
		target, e := os.Readlink(filepath.Join(proc, "fd", fd.Name()))
		if e == nil && strings.HasPrefix(target, "socket:[") {
			owned[strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")] = true
		}
	}
	listening := map[string]string{}
	for _, name := range []string{"tcp", "tcp6"} {
		data, e := os.ReadFile(filepath.Join(proc, "net", name))
		if os.IsNotExist(e) {
			continue
		}
		if e != nil {
			return nil, e
		}
		for _, line := range strings.Split(string(data), "\n") {
			f := strings.Fields(line)
			if len(f) > 9 && f[3] == "0A" && owned[f[9]] {
				listening[f[9]] = name + ":" + f[1]
			}
		}
	}
	return listening, nil
}

var reloadSSHService = reloadSystemSSHService

func reloadSystemSSHService(s SSHService) error {
	before, err := listenerSockets(s.PID)
	if err != nil {
		return fmt.Errorf("%s: cannot inspect listener before reload: %w", s.ID, err)
	}
	if len(before) == 0 {
		return fmt.Errorf("%s: no owned TCP listening socket; inspect socket activation with systemctl status %s", s.ID, s.ID)
	}
	beforeExec := listenerExecIdentity(s.PID)
	if _, err = command("/usr/bin/systemctl", "reload", s.ID); err != nil {
		return fmt.Errorf("%s reload failed: %w", s.ID, err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		now, e := listenerSockets(s.PID)
		// Socket-activated services can inherit the same sockets on exec. In
		// that case also require evidence that the listener re-executed.
		reopened := !reflect.DeepEqual(before, now)
		afterExec := listenerExecIdentity(s.PID)
		if s.Sockets != "" && beforeExec != "" && afterExec != "" && afterExec != beforeExec {
			reopened = true
		}
		if e == nil && len(now) > 0 && reopened && sameListenerAddresses(before, now) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("%s did not reopen its listening sockets after reload; inspect: journalctl -u %s -n 30 --no-pager", s.ID, s.ID)
}

func sameListenerAddresses(a, b map[string]string) bool {
	values := func(m map[string]string) []string {
		v := []string{}
		for _, s := range m {
			v = append(v, s)
		}
		sort.Strings(v)
		return v
	}
	return reflect.DeepEqual(values(a), values(b))
}
func listenerExecIdentity(pid int) string {
	data, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(pid), "stat"))
	if err != nil {
		return ""
	}
	text := string(data)
	end := strings.LastIndex(text, ")")
	if end < 0 {
		return ""
	}
	fields := strings.Fields(text[end+1:])
	if len(fields) < 26 {
		return ""
	}
	return strings.Join(fields[23:26], ":")
}
func checkDormantSSHSockets(active map[int]bool) error {
	out, err := command("/usr/bin/systemctl", "list-units", "--type=socket", "--state=active", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return fmt.Errorf("cannot inspect socket activation: %w", err)
	}
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 0 || !strings.HasSuffix(fields[0], ".socket") {
			continue
		}
		socket := fields[0]
		out, err := command("/usr/bin/systemctl", "show", "--property=Id,Triggers", socket)
		if err != nil {
			return err
		}
		for _, record := range systemdRecords(out) {
			for _, unit := range strings.Fields(record["Triggers"]) {
				out, err := command("/usr/bin/systemctl", "show", "--property=Id,ExecStart,MainPID,RootDirectory,RootImage", unit)
				if err != nil {
					return err
				}
				for _, service := range systemdRecords(out) {
					if !strings.Contains(service["ExecStart"], "/sshd ") && !strings.Contains(service["ExecStart"], "/sshd;") {
						continue
					}
					if service["RootDirectory"] != "" || service["RootImage"] != "" {
						continue
					}
					pid, _ := strconv.Atoi(service["MainPID"])
					if active[pid] {
						continue
					}
					return fmt.Errorf("%s activates %s without a supported running listener. Start its persistent listener with systemctl start %s, then rerun configure-ssh. Per-connection sshd -i services require a persistent service; files unchanged", socket, unit, unit)
				}
			}
		}
	}
	return nil
}
