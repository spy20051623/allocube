package main

import (
	"crypto/x509"
	"errors"
	"net"
	"net/url"
	"strings"
	"testing"
)

func TestConnectionErrorsAreActionableWithoutSecrets(t *testing.T) {
	for _, test := range []struct {
		cause error
		want  string
	}{
		{x509.UnknownAuthorityError{}, "not trusted"},
		{x509.HostnameError{}, "does not match"},
		{x509.CertificateInvalidError{}, "invalid or expired"},
		{&net.DNSError{}, "DNS"},
		{&net.OpError{Op: "dial", Net: "tcp", Err: timeoutError{}}, "timed out"},
		{errors.New("secret-proxy-password"), "outcome is unknown"},
	} {
		wrapped := &url.Error{Op: "Post", URL: "https://secret-in-error.test", Err: test.cause}
		got := platformConnectionError(wrapped).Error()
		if !strings.Contains(got, test.want) || strings.Contains(got, "secret") || strings.Contains(got, "no operation performed") {
			t.Fatal(got)
		}
	}
}

func TestPlatformErrorsAreEnglishAndDoNotEchoResponseBodies(t *testing.T) {
	for _, row := range []struct {
		status     int
		body, want string
	}{
		{401, `{"error":"接入凭据已使用或过期"}`, "enrollment token"},
		{403, `{"error":"终端已停用或机器不存在"}`, "disabled"},
		{429, `{"error":"secret-value"}`, "Wait"},
		{502, `<html>secret-value</html>`, "unavailable"},
		{400, `{"error":"未知错误 secret-value"}`, "compatibility"},
	} {
		message := platformHTTPError("enroll", row.status, []byte(row.body)).Error()
		if !strings.Contains(message, row.want) || strings.Contains(message, "secret-value") {
			t.Fatal(message)
		}
		for _, r := range message {
			if r > 127 {
				t.Fatal("non-English error:", message)
			}
		}
	}
}

type timeoutError struct{}

func (timeoutError) Error() string   { return "timeout" }
func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
