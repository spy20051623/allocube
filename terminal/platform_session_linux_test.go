package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type platformTestHook func(http.ResponseWriter, *http.Request, int) bool

// Real HTTP/TLS, signatures and single-use challenges, with controllable failure
// responses and elapsed time. No operating-system clock or live files change.
func platformTestClient(t *testing.T, hook platformTestHook) (*Platform, func(string) int, *time.Duration, *[]time.Duration) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	counts := map[string]int{}
	challenges := map[string]bool{}
	p := &Platform{Key: key, ctx: context.Background()}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1/terminal/machine/")
		mu.Lock()
		counts[path]++
		count := counts[path]
		mu.Unlock()
		if hook != nil && hook(w, r, count) {
			return
		}
		switch path {
		case "challenge":
			challenge := randomToken()
			challenges[challenge] = true
			json.NewEncoder(w).Encode(map[string]string{"challenge": challenge})
		case "token":
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			message := fmt.Sprintf("allocube-machine-token-v2\n%s\n%s/api/v1/terminal/machine/token\n%s", p.Config.TerminalID, p.Config.Platform, body["challenge"])
			proof, _ := base64.RawURLEncoding.DecodeString(body["proof"])
			if !challenges[body["challenge"]] || !ed25519.Verify(key.Public().(ed25519.PublicKey), []byte(message), proof) {
				t.Error("invalid or reused challenge/proof")
				w.WriteHeader(401)
				return
			}
			delete(challenges, body["challenge"])
			json.NewEncoder(w).Encode(map[string]any{"access_token": fmt.Sprintf("token-%d", count), "expires_in": 60})
		default:
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer token-") {
				t.Error("missing credential")
				w.WriteHeader(401)
				return
			}
			fmt.Fprint(w, `{"ok":true}`)
		}
	}))
	t.Cleanup(server.Close)
	p.Config = Config{Platform: server.URL, TerminalID: "test-terminal"}
	p.Client = server.Client()
	elapsed := time.Duration(0)
	waits := []time.Duration{}
	p.elapsed = func() time.Duration { return elapsed }
	p.wait = func(ctx context.Context, delay time.Duration) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		waits = append(waits, delay)
		elapsed += delay
		return nil
	}
	count := func(path string) int { mu.Lock(); defer mu.Unlock(); return counts[path] }
	return p, count, &elapsed, &waits
}

func TestPlatformReusesCredentialAndRefreshesBeforeExpiry(t *testing.T) {
	p, count, elapsed, _ := platformTestClient(t, nil)
	for i := 0; i < 40; i++ {
		if err := p.call("keys", map[string]any{}, nil); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{"help", "confirm-installation"} {
		if err := p.call(path, map[string]any{}, nil); err != nil {
			t.Fatal(err)
		}
	}
	if count("challenge") != 1 || count("token") != 1 {
		t.Fatal("credential not reused")
	}
	*elapsed = 54 * time.Second
	if _, err := p.token(); err != nil {
		t.Fatal(err)
	}
	if count("token") != 1 {
		t.Fatal("premature refresh")
	}
	*elapsed = 55 * time.Second
	if _, err := p.token(); err != nil {
		t.Fatal(err)
	}
	if count("challenge") != 2 || count("token") != 2 {
		t.Fatal("expiry margin not applied")
	}
}

func TestPlatformRefreshesRejectedCredentialOnce(t *testing.T) {
	for _, permanent := range []bool{false, true} {
		t.Run(fmt.Sprint(permanent), func(t *testing.T) {
			p, count, _, _ := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
				if strings.HasSuffix(r.URL.Path, "/keys") && (permanent || n == 1) {
					w.WriteHeader(401)
					return true
				}
				return false
			})
			err := p.call("keys", nil, nil)
			if (err != nil) != permanent || count("keys") != 2 || count("token") != 2 {
				t.Fatal("invalid refresh behavior", err)
			}
		})
	}
}

func TestPlatformRetriesFreshChallengeAfterLostTokenResponse(t *testing.T) {
	p, count, _, _ := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
		if strings.HasSuffix(r.URL.Path, "/token") && n == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return true
			}
			conn.Close()
			return true
		}
		return false
	})
	if err := p.call("keys", nil, nil); err != nil {
		t.Fatal(err)
	}
	if count("challenge") != 2 || count("token") != 2 || count("keys") != 1 {
		t.Fatal("did not restart challenge exchange")
	}
}

func TestPlatformExpiredChallengeRetriesButInvalidIdentityDoesNot(t *testing.T) {
	for _, expired := range []bool{true, false} {
		t.Run(fmt.Sprint(expired), func(t *testing.T) {
			p, count, _, _ := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
				if strings.HasSuffix(r.URL.Path, "/token") && n == 1 {
					message := "机器签名无效"
					if expired {
						message = "机器挑战无效或已过期"
					}
					w.WriteHeader(401)
					json.NewEncoder(w).Encode(map[string]string{"error": message})
					return true
				}
				return false
			})
			err := p.call("keys", nil, nil)
			if expired {
				if err != nil || count("challenge") != 2 || count("keys") != 1 {
					t.Fatal("expired challenge not renewed", err)
				}
			} else if err == nil || count("challenge") != 1 || count("keys") != 0 {
				t.Fatal("invalid identity retried", err)
			}
		})
	}
}

func TestPlatformRequestDeadlineCancelsInflightRequest(t *testing.T) {
	release := make(chan struct{})
	defer close(release)
	p, count, _, waits := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
		if strings.HasSuffix(r.URL.Path, "/keys") {
			select {
			case <-r.Context().Done():
			case <-release:
			}
			return true
		}
		return false
	})
	if _, err := p.token(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	p.ctx = ctx
	started := time.Now()
	if err := p.call("keys", nil, nil); err == nil || time.Since(started) > time.Second || count("keys") != 1 || len(*waits) != 0 {
		t.Fatal("deadline failed to stop in-flight network work", err)
	}
}

func TestPlatformBackoffAndRetryAfterUseServerTime(t *testing.T) {
	for _, header := range []string{"2", "Thu, 22 Oct 2026 03:30:02 GMT"} {
		t.Run(header, func(t *testing.T) {
			p, count, _, waits := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
				if strings.HasSuffix(r.URL.Path, "/keys") && n == 1 {
					w.Header().Set("Date", "Thu, 22 Oct 2026 03:30:00 GMT")
					w.Header().Set("Retry-After", header)
					w.WriteHeader(429)
					return true
				}
				return false
			})
			if err := p.call("keys", nil, nil); err != nil {
				t.Fatal(err)
			}
			if count("token") != 1 || count("keys") != 2 || len(*waits) != 1 || (*waits)[0] != 2*time.Second {
				t.Fatal("wrong retry delay", *waits)
			}
		})
	}
	p, count, _, waits := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
		if strings.HasSuffix(r.URL.Path, "/keys") && n < 3 {
			w.WriteHeader(503)
			return true
		}
		return false
	})
	if err := p.call("keys", nil, nil); err != nil {
		t.Fatal(err)
	}
	if count("keys") != 3 || len(*waits) != 2 || (*waits)[0] != 250*time.Millisecond || (*waits)[1] != 500*time.Millisecond {
		t.Fatal("unbounded or missing backoff", *waits)
	}
}

func TestPlatformBoundsRetriesAndDoesNotReplayRotation(t *testing.T) {
	for _, path := range []string{"keys", "rotate"} {
		p, count, _, _ := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
			if strings.HasSuffix(r.URL.Path, "/"+path) {
				w.WriteHeader(503)
				return true
			}
			return false
		})
		if err := p.call(path, nil, nil); err == nil {
			t.Fatal("permanent failure ignored")
		}
		want := 3
		if path == "rotate" {
			want = 1
		}
		if count(path) != want {
			t.Fatal("unexpected attempts", path, count(path))
		}
	}
	p, count, _, waits := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
		if strings.HasSuffix(r.URL.Path, "/keys") {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(429)
			return true
		}
		return false
	})
	if err := p.call("keys", nil, nil); err == nil || count("keys") != 1 || len(*waits) != 0 {
		t.Fatal("long wait exceeded sync budget")
	}
	if err := p.call("help", nil, nil); err == nil || count("help") != 0 {
		t.Fatal("a later sync stage ignored Retry-After")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	p.ctx = ctx
	if err := p.call("keys", nil, nil); err == nil || count("keys") != 1 {
		t.Fatal("cancelled cycle made a request")
	}
}

func TestPlatformRetryWaitBudgetIsSharedAcrossCalls(t *testing.T) {
	p, count, _, waits := platformTestClient(t, func(w http.ResponseWriter, r *http.Request, n int) bool {
		if strings.HasSuffix(r.URL.Path, "/keys") && n%2 == 1 {
			w.Header().Set("Retry-After", "6")
			w.WriteHeader(429)
			return true
		}
		return false
	})
	if err := p.call("keys", nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := p.call("keys", nil, nil); err == nil || count("keys") != 3 || len(*waits) != 1 {
		t.Fatal("wait budget was reset between batches")
	}
	if !transientConnectionError(timeoutError{}) || transientConnectionError(context.Canceled) {
		t.Fatal("incorrect network retry classification")
	}
}

type observingTransport struct {
	next  http.RoundTripper
	paths map[string]int
}

func (o *observingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	o.paths[r.URL.Path]++
	return o.next.RoundTrip(r)
}

func TestSyncSessionBatches65EmployeesWithOneCredential(t *testing.T) {
	c, _, _, _ := automaticFixture(t)
	c.session = &platformSession{ctx: context.Background()}
	p, err := newPlatform(c)
	if err != nil {
		t.Fatal(err)
	}
	observer := &observingTransport{next: p.Client.Transport, paths: map[string]int{}}
	p.Client.Transport = observer
	accounts := []Account{}
	for i := 0; i < 65; i++ {
		accounts = append(accounts, Account{Name: fmt.Sprintf("a%08d", 10000000+i), UID: 1000 + i})
	}
	keys, err := fetchPlanKeys(c, accounts)
	if err != nil || len(keys) != 65 {
		t.Fatal("batch fetch failed", err, len(keys))
	}
	if observer.paths["/api/v1/terminal/machine/keys"] != 3 || observer.paths["/api/v1/terminal/machine/token"] != 1 {
		t.Fatal("batch size or credential reuse changed", observer.paths)
	}
	shared, err := newPlatform(c)
	if err != nil || shared != p {
		t.Fatal("cycle session not shared", err)
	}
	encoded, err := json.Marshal(c)
	if err != nil || strings.Contains(string(encoded), "fixture") {
		t.Fatal("credential persisted", err)
	}
	c.session = &platformSession{ctx: context.Background()}
	next, err := newPlatform(c)
	if err != nil || next == p || next.accessToken != "" {
		t.Fatal("credentials leaked across cycles", err)
	}
}

func TestSyncRetainsKeysAfterExhaustedRetryAndRevokesOnRecovery(t *testing.T) {
	key := testKey(t, "revocation-retry")
	publicKeys := []any{map[string]string{"publicKey": key}}
	c, _, _, unavailable := automaticFixture(t, func() []any { return publicKeys })
	if err := autoManageAccounts(c); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(c.KeyDir, "a12345678")
	before, err := os.ReadFile(path)
	if err != nil || len(before) == 0 {
		t.Fatal("missing initial key", err)
	}
	*unavailable = true
	publicKeys = []any{}
	if err = synchronizeKeys(c); err == nil {
		t.Fatal("outage was hidden")
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(before) {
		t.Fatal("failed request cleared keys", err)
	}
	*unavailable = false
	if err = synchronizeKeys(c); err != nil {
		t.Fatal(err)
	}
	after, err = os.ReadFile(path)
	if err != nil || len(after) != 0 {
		t.Fatal("recovery did not apply revocation", err)
	}
}
