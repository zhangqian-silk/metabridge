package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type commandRoundTrip func(*http.Request) (*http.Response, error)

func (f commandRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCommandQueriesReadOnlyScopedAccountAndOptionalSubscription(t *testing.T) {
	var paths []string
	client := &http.Client{Transport: commandRoundTrip(func(req *http.Request) (*http.Response, error) {
		if req.Method != "GET" || req.URL.Scheme != "https" ||
			req.URL.Host != "api.commandcode.ai" || req.Header.Get("Authorization") != "Bearer fixture" {
			t.Fatal("unexpected credential destination or method")
		}
		paths = append(paths, req.URL.Path)
		status, body := 200, ""
		switch req.URL.Path {
		case "/alpha/whoami":
			body = `{"data":{"org":{"id":"team & one"}}}`
		case "/alpha/billing/credits":
			if req.URL.Query().Get("orgId") != "team & one" {
				t.Fatal("missing account scope")
			}
			body = `{"data":{"credits":{"monthlyCredits":0,"purchasedCredits":0,"freeCredits":0}}}`
		case "/alpha/billing/subscriptions":
			if req.URL.Query().Get("orgId") != "team & one" {
				t.Fatal("subscription scope mismatch")
			}
			status, body = 403, `{"secret":"must not escape"}`
		default:
			t.Fatal("unexpected request")
		}
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)),
			Header: make(http.Header), Request: req}, nil
	})}
	value, err := queryCommandQuota(context.Background(), client, "fixture")
	if err != nil || value.Balance == nil || *value.Balance != 0 || value.PeriodEnd != "" || len(paths) != 3 {
		t.Fatal("optional metadata failure lost valid zero balance")
	}
	paths = nil
	client.Transport = commandRoundTrip(func(req *http.Request) (*http.Response, error) {
		paths = append(paths, req.URL.Path)
		return &http.Response{StatusCode: 401, Body: io.NopCloser(strings.NewReader("private error"))}, nil
	})
	if _, err := queryCommandQuota(context.Background(), client, "fixture"); err == nil ||
		strings.Contains(err.Error(), "private") || len(paths) != 1 {
		t.Fatal("failed whoami must not fall back to unscoped quota or expose upstream body")
	}
}

func TestCommandQuotaZeroUnknownAndOverspend(t *testing.T) {
	raw := []byte(`{"credits":{"monthlyCredits":0,"purchasedCredits":2,"freeCredits":0},"windowLimits":{"fiveHour":{"used":16,"cap":14,"resetAt":0},"weekly":{"used":0,"cap":35,"resetAt":1791375965000}}}`)
	value, err := normalizeCommandQuota(raw, []byte(`{"currentPeriodEnd":"2026-10-16T03:38:06.000Z"}`))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(value)
	var result struct {
		Windows []struct {
			RemainingFraction float64 `json:"remainingFraction"`
			ResetTime         string  `json:"resetTime"`
		}
		Balance float64
	}
	json.Unmarshal(body, &result)
	if len(result.Windows) != 2 || result.Windows[0].RemainingFraction != 0 ||
		result.Windows[0].ResetTime != "" || result.Windows[1].RemainingFraction != 1 ||
		result.Windows[1].ResetTime == "" || result.Balance != 2 {
		t.Fatalf("invalid normalization: %s", body)
	}
	if _, err := normalizeCommandQuota([]byte(`{"credits":{},"windowLimits":{}}`), nil); err == nil {
		t.Fatal("empty quota must not become zero")
	}
	if _, err := normalizeCommandQuota([]byte(`{"windowLimits":{"fiveHour":{"used":-1,"cap":14}}}`), nil); err == nil {
		t.Fatal("malformed window must not become healthy")
	}
}

func TestCommandCredentialUsesOnlyUnambiguousCPAAccount(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".config/cliproxyapi")
	os.MkdirAll(dir, 0700)
	file := filepath.Join(dir, "config.json")
	provider := map[string]any{"name": "command-code", "base-url": "https://api.commandcode.ai/provider/v1",
		"keys": []any{map[string]any{"api-key": "fixture-key"}}}
	save := func() {
		raw, _ := json.Marshal(map[string]any{"api-keys": map[string]any{"openai-compatibility": []any{provider}}})
		os.WriteFile(file, raw, 0600)
	}
	save()
	if key, err := readCommandCredential(home); err != nil || key != "fixture-key" {
		t.Fatal("configured account not read")
	}
	provider["base-url"] = "https://api.commandcode.ai.evil.example/provider/v1"
	save()
	if _, err := readCommandCredential(home); err == nil {
		t.Fatal("lookalike destination accepted")
	}
	provider["base-url"] = "https://api.commandcode.ai/provider/v1"
	provider["keys"] = []any{map[string]any{"api-key": "one"}, map[string]any{"api-key": "two"}}
	save()
	if _, err := readCommandCredential(home); err == nil {
		t.Fatal("ambiguous account accepted")
	}
	provider["keys"] = []any{map[string]any{"api-key": "fixture-key"}}
	save()
	os.Chmod(file, 0644)
	if _, err := readCommandCredential(home); err == nil {
		t.Fatal("public credential file accepted")
	}
}

func TestCommandManagementRouteRejectsMutation(t *testing.T) {
	result, _ := handleMethod("management.handle", []byte(`{"Method":"POST","Path":"`+commandRoute+`"}`))
	if result.(map[string]any)["StatusCode"] != 404 {
		t.Fatal("mutation route accepted")
	}
	routes, _ := handleMethod("management.register", nil)
	raw, _ := json.Marshal(routes)
	if !strings.Contains(string(raw), commandRoute) || !strings.Contains(string(raw), accountRoute) {
		t.Fatal("account routes missing")
	}
}
