package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func exclusionsToRestore(c Config, accounts []Account) ([]Account, error) {
	original, err := os.ReadFile(c.SSHConfig)
	if err != nil {
		return nil, err
	}
	base, err := originalSSH(original)
	if err != nil {
		return nil, err
	}
	_, names, err := priorSSHBlocks(original, base)
	if err != nil {
		return nil, err
	}
	var result []Account
	for _, a := range accounts {
		if a.Name == "root" || a.UID == 0 {
			continue
		}
		selected, err := selectAccount(c, a)
		if err != nil {
			return nil, err
		}
		if selected.Excluded && names[a.Name] {
			result = append(result, a)
		}
	}
	return result, nil
}

type accountSelection struct {
	Managed  bool
	Excluded bool
	Employee string
}

func explicitlyExcluded(c Config, name string) bool {
	value, exists := c.UserMapping[name]
	return exists && value == nil
}

func selectAccount(c Config, a Account) (accountSelection, error) {
	if a.Name == "root" || a.UID == 0 || a.Name == "nobody" || a.UID == 65534 || a.UID == 65535 {
		return accountSelection{Excluded: true}, nil
	}
	if explicitlyExcluded(c, a.Name) {
		return accountSelection{Excluded: true}, nil
	}
	if !usernamePattern.MatchString(a.Name) || len(a.Name) > 32 {
		return accountSelection{}, errors.New("unsupported account name")
	}
	for _, name := range c.DisabledUsers {
		if name == a.Name {
			return accountSelection{}, nil
		}
	}
	if employee, ok := c.UserMapping[a.Name]; ok {
		if !employeePattern.MatchString(*employee) {
			return accountSelection{}, errors.New("invalid manual mapping; default mapping not used")
		}
		return accountSelection{Managed: true, Employee: *employee}, nil
	}
	if c.AccountScope == "regular" {
		if c.RegularUIDMin < 1 || c.RegularUIDMax < c.RegularUIDMin {
			return accountSelection{}, errors.New("regular UID range has not been loaded")
		}
		if a.UID < c.RegularUIDMin || a.UID > c.RegularUIDMax {
			return accountSelection{}, nil
		}
		if len(a.Name) > 1 && ownName(a.Name, a.Name[1:]) {
			return accountSelection{Managed: true, Employee: a.Name[1:]}, nil
		}
		return accountSelection{Managed: true}, nil
	}
	if len(a.Name) > 1 && ownName(a.Name, a.Name[1:]) {
		return accountSelection{Managed: true, Employee: a.Name[1:]}, nil
	}
	return accountSelection{}, nil
}

func employeeFor(c Config, a Account) (string, error) {
	selected, err := selectAccount(c, a)
	return selected.Employee, err
}

func parseRegularUIDRange(data string) (int, int, error) {
	low, high := 1000, 60000
	seen := map[string]bool{}
	for _, line := range strings.Split(data, "\n") {
		fields := strings.Fields(strings.SplitN(line, "#", 2)[0])
		if len(fields) == 0 || (fields[0] != "UID_MIN" && fields[0] != "UID_MAX") {
			continue
		}
		if len(fields) != 2 || seen[fields[0]] {
			return 0, 0, errors.New("ambiguous UID_MIN/UID_MAX in /etc/login.defs")
		}
		seen[fields[0]] = true
		value, err := strconv.Atoi(fields[1])
		if err != nil || value < 1 || int64(value) > 4294967294 {
			return 0, 0, fmt.Errorf("invalid %s in /etc/login.defs", fields[0])
		}
		if fields[0] == "UID_MIN" {
			low = value
		} else {
			high = value
		}
	}
	if low > high {
		return 0, 0, errors.New("UID_MIN exceeds UID_MAX in /etc/login.defs")
	}
	return low, high, nil
}

func regularUIDRange() (int, int, error) {
	data, err := os.ReadFile("/etc/login.defs")
	if os.IsNotExist(err) {
		return 1000, 60000, nil
	}
	if err != nil {
		return 0, 0, err
	}
	if err = trustedPath("/etc/login.defs"); err != nil {
		return 0, 0, err
	}
	return parseRegularUIDRange(string(data))
}

func printScope(c Config) {
	if c.AccountScope == "regular" {
		fmt.Printf("[POLICY] Regular local accounts: UID %d-%d. Accounts without an employee mapping receive an empty key list.\n", c.RegularUIDMin, c.RegularUIDMax)
	} else {
		fmt.Println("[POLICY] Employee-named accounts and explicit mappings.")
	}
	fmt.Println("[POLICY] userMapping entries set to null are excluded. Run configure-ssh after changing exclusions to restore the underlying SSH policy.")
}
