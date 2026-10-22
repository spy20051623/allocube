package main

import (
	"context"
	"crypto/x509"
	"errors"
	"net/http"
	"strconv"
	"time"
)

const syncRequestBudget = 90 * time.Second
const retryWaitBudget = 10 * time.Second

type platformRequestError struct {
	cause            error
	status           int
	transient        bool
	challengeExpired bool
	retryAfter       time.Duration
}

func (e *platformRequestError) Error() string { return e.cause.Error() }
func (e *platformRequestError) Unwrap() error { return e.cause }

func transientConnectionError(err error) bool {
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var invalid x509.CertificateInvalidError
	return !errors.Is(err, context.Canceled) &&
		!errors.As(err, &unknown) && !errors.As(err, &hostname) && !errors.As(err, &invalid)
}

func platformRetryAfter(header http.Header) time.Duration {
	value := header.Get("Retry-After")
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseInt(value, 10, 64); err == nil && seconds >= 0 {
		if seconds > 3600 {
			return time.Hour
		}
		return time.Duration(seconds) * time.Second
	}
	until, err := http.ParseTime(value)
	if err != nil {
		return 0
	}
	// HTTP-date is interpreted against the server's Date, not this machine's
	// possibly skewed wall clock. Without Date, defer to the next timer cycle.
	serverNow, err := http.ParseTime(header.Get("Date"))
	if err != nil {
		return time.Hour
	}
	return max(0, until.Sub(serverNow))
}

func (p *Platform) retry(err error, attempt int) bool {
	var request *platformRequestError
	if attempt >= 2 || !errors.As(err, &request) || !request.transient || p.ctx.Err() != nil {
		return false
	}
	delay := max(time.Duration(1<<attempt)*250*time.Millisecond, request.retryAfter)
	if p.retryWait+delay > retryWaitBudget {
		return false
	}
	if deadline, ok := p.ctx.Deadline(); ok && time.Until(deadline) < delay+12*time.Second {
		return false
	}
	p.retryWait += delay
	if p.wait != nil {
		return p.wait(p.ctx, delay) == nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-p.ctx.Done():
		return false
	}
}
