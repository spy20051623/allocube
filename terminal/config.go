package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Config struct {
	SSHServices     []SSHService       `json:"-"`
	ConfigPath      string             `json:"-"`
	Platform        string             `json:"platform"`
	CAFile          string             `json:"caFile,omitempty"`
	TerminalID      string             `json:"terminalId"`
	IdentityKey     string             `json:"identityKey"`
	StateDir        string             `json:"stateDir"`
	KeyDir          string             `json:"syncKeyDir"`
	SSHConfig       string             `json:"sshConfig"`
	UserMapping     map[string]*string `json:"userMapping"`
	AccountScope    string             `json:"accountScope,omitempty"`
	RegularUIDMin   int                `json:"-"`
	RegularUIDMax   int                `json:"-"`
	DisabledUsers   []string           `json:"disabledUsers"`
	IntervalSeconds int                `json:"intervalSeconds"`
}

func defaults() Config {
	return Config{IdentityKey: "/etc/allocube-terminal/identity.key", StateDir: "/var/lib/allocube-terminal", KeyDir: "/etc/allocube-terminal/synced_keys", SSHConfig: "/etc/ssh/sshd_config", UserMapping: map[string]*string{}, AccountScope: "named", IntervalSeconds: 300}
}
func loadConfig(path string) (Config, error) {
	c := defaults()
	data, err := os.ReadFile(path)
	if err != nil {
		return c, err
	}
	if err = json.Unmarshal(data, &c); err != nil {
		return c, err
	}
	if c.AccountScope == "regular" {
		c.RegularUIDMin, c.RegularUIDMax, err = regularUIDRange()
		if err != nil {
			return c, err
		}
	}
	return c, validateConfig(c)
}
func validateConfig(c Config) error {
	if c.AccountScope != "" && c.AccountScope != "named" && c.AccountScope != "regular" {
		return errors.New("accountScope must be named or regular")
	}
	u, err := url.Parse(c.Platform)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return errors.New("platform must be an HTTPS origin")
	}
	if c.TerminalID == "" {
		return errors.New("missing terminal ID")
	}
	if c.IntervalSeconds < 60 || c.IntervalSeconds > 86400 {
		return errors.New("intervalSeconds must be between 60 and 86400")
	}
	paths := []string{c.IdentityKey, c.StateDir, c.KeyDir, c.SSHConfig}
	if c.CAFile != "" {
		paths = append(paths, c.CAFile)
	}
	for _, p := range paths {
		if !filepath.IsAbs(p) || filepath.Clean(p) != p || p == "/" {
			return fmt.Errorf("invalid absolute path: %s", p)
		}
	}
	return nil
}
func randomToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}
func digest(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func uuid() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	return atomicWriteLabeled(path, data, mode, "")
}
func atomicWriteLabeled(path string, data []byte, mode os.FileMode, label string) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".allocube-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(mode); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = labelAtomicReplacement(f, path, label)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	d, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}
func writeJSON(path string, v any, mode os.FileMode) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return atomicWrite(path, data, mode)
}
func readKey(path string) (ed25519.PrivateKey, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(data)
	if block == nil {
		return nil, errors.New("invalid private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	k, ok := key.(ed25519.PrivateKey)
	if !ok {
		return nil, errors.New("expected Ed25519 key")
	}
	return k, nil
}
func newKey(path string) (ed25519.PrivateKey, error) {
	_, k, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	der, err := x509.MarshalPKCS8PrivateKey(k)
	if err != nil {
		return nil, err
	}
	return k, atomicWrite(path, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0600)
}
func publicPEM(key ed25519.PrivateKey) string {
	der, _ := x509.MarshalPKIXPublicKey(key.Public())
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

type Platform struct {
	Config Config
	Key    ed25519.PrivateKey
	Client *http.Client
}

func newPlatform(c Config) (*Platform, error) {
	k, err := readKey(c.IdentityKey)
	if err != nil {
		return nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if c.CAFile != "" {
		if err = trustedPath(c.CAFile); err != nil {
			return nil, err
		}
		data, e := os.ReadFile(c.CAFile)
		if e != nil {
			return nil, e
		}
		// An explicit platform CA is scoped to this client, not system-wide trust.
		roots := x509.NewCertPool()
		if len(data) > 65536 || !roots.AppendCertsFromPEM(data) {
			return nil, errors.New("invalid platform CA certificate")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	return &Platform{c, k, &http.Client{Transport: transport, Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("platform redirects are forbidden") }}}, nil
}

func platformConnectionError(err error) error {
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	var dns *net.DNSError
	var network net.Error
	switch {
	case errors.As(err, &unknown):
		return errors.New("platform TLS certificate is not trusted; configure the platform CA certificate (caFile)")
	case errors.As(err, &hostname):
		return errors.New("platform TLS certificate does not match the platform address")
	case errors.As(err, &invalid):
		return errors.New("platform TLS certificate is invalid or expired; check the certificate and system clock")
	case errors.As(err, &dns):
		return errors.New("platform hostname could not be resolved; check DNS and network settings")
	case errors.As(err, &network) && network.Timeout():
		return errors.New("platform request timed out; request outcome is unknown")
	default:
		return errors.New("platform connection failed; check network and proxy settings; request outcome is unknown")
	}
}
func (p *Platform) post(path, token string, input, output any) error {
	data, err := json.Marshal(input)
	if err != nil {
		return err
	}
	req, err := http.NewRequest("POST", p.Config.Platform+"/api/v1/terminal/machine/"+path, strings.NewReader(string(data)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := p.Client.Do(req)
	if err != nil {
		return platformConnectionError(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2097153))
	if err != nil || len(body) > 2097152 {
		return errors.New("invalid platform response")
	}
	if resp.StatusCode != 200 {
		return platformHTTPError(path, resp.StatusCode, body)
	}
	if output == nil {
		return nil
	}
	return json.Unmarshal(body, output)
}

// Do not print raw platform/proxy responses: they may be localized or contain secrets.
func platformHTTPError(operation string, status int, body []byte) error {
	var problem struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(body, &problem)
	known := map[string]string{
		"接入凭据已使用或过期":  "the enrollment token has expired or was already used. Generate a new enrollment command in Allocube for this machine",
		"终端已停用或机器不存在": "this terminal is disabled or its machine no longer exists. Ask the machine administrator to check its registration in Allocube",
		"机器凭据无效":      "machine credentials were rejected. Check whether the machine was re-enrolled or disabled in Allocube",
		"机器签名无效":      "machine signature verification failed. Check the machine clock and registration; do not delete the local identity key",
		"机器签名已经使用":    "a machine authentication request was already used. Retry with a fresh request",
		"注册签名无效":      "enrollment signature verification failed. Keep the local identity files and ask the administrator to check the registration",
	}
	message := known[problem.Error]
	if message == "" {
		switch {
		case status == 429:
			message = "too many requests. Wait before retrying; do not repeatedly regenerate enrollment tokens"
		case status >= 500:
			message = "the platform is unavailable. Retry later; a write request may have completed, so keep the existing identity files"
		case status == 401 || status == 403:
			message = "authorization was rejected. Check the machine registration and platform permissions"
		default:
			message = "the platform rejected the request. Check platform configuration and terminal version compatibility"
		}
	}
	return fmt.Errorf("platform %s failed (HTTP %d): %s", operation, status, message)
}
func (p *Platform) token() (string, error) {
	now := time.Now().Unix()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`))
	body, _ := json.Marshal(map[string]any{"iss": p.Config.TerminalID, "sub": p.Config.TerminalID, "aud": p.Config.Platform + "/api/v1/terminal/machine/token", "iat": now, "exp": now + 60, "jti": randomToken()})
	unsigned := header + "." + base64.RawURLEncoding.EncodeToString(body)
	jwt := unsigned + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(p.Key, []byte(unsigned)))
	var result struct {
		Token string `json:"access_token"`
	}
	err := p.post("token", "", map[string]string{"client_id": p.Config.TerminalID, "grant_type": "client_credentials", "client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer", "client_assertion": jwt}, &result)
	if err == nil && result.Token == "" {
		err = errors.New("missing machine token")
	}
	return result.Token, err
}
func (p *Platform) call(path string, input, output any) error {
	token, err := p.token()
	if err != nil {
		return err
	}
	return p.post(path, token, input, output)
}
