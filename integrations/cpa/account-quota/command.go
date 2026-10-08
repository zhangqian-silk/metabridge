package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const commandRoute = "/v0/management/plugins/factory-quota/command-code"
const commandOrigin = "https://api.commandcode.ai"

var errCommandUnavailable = errors.New("Command Code quota unavailable")

// Credentials always come from the same CPA inference provider, never the browser.
// Multiple keys may route to different accounts; refuse to guess which quota applies.
func readCommandCredential(home string) (string, error) {
	raw, err := readPrivateFile(filepath.Join(home, ".config/cliproxyapi/config.json"))
	if err != nil {
		return "", errCommandUnavailable
	}
	var config struct {
		APIKeys struct {
			Providers []struct {
				Name string `json:"name"`
				Base string `json:"base-url"`
				Keys []struct {
					Key string `json:"api-key"`
				} `json:"keys"`
			} `json:"openai-compatibility"`
		} `json:"api-keys"`
	}
	if json.Unmarshal(raw, &config) != nil {
		return "", errCommandUnavailable
	}
	var key string
	for _, provider := range config.APIKeys.Providers {
		if provider.Name != "command-code" {
			continue
		}
		if key != "" || provider.Base != commandOrigin+"/provider/v1" || len(provider.Keys) != 1 {
			return "", errCommandUnavailable
		}
		key = strings.TrimSpace(provider.Keys[0].Key)
		if key == "" || strings.ContainsAny(key, "\r\n") {
			return "", errCommandUnavailable
		}
	}
	if key == "" {
		return "", errCommandUnavailable
	}
	return key, nil
}

type commandWindow struct {
	Window            string  `json:"window"`
	Used              float64 `json:"used"`
	Cap               float64 `json:"cap"`
	RemainingFraction float64 `json:"remainingFraction"`
	ResetTime         string  `json:"resetTime,omitempty"`
}

type commandQuota struct {
	Windows   []commandWindow    `json:"windows"`
	Credits   map[string]float64 `json:"credits"`
	Balance   *float64           `json:"balance,omitempty"`
	PeriodEnd string             `json:"periodEnd,omitempty"`
	UpdatedAt string             `json:"updatedAt"`
}

func commandPayload(raw []byte) (map[string]any, error) {
	var value map[string]any
	if json.Unmarshal(raw, &value) != nil || value == nil {
		return nil, errCommandUnavailable
	}
	if nested, ok := value["data"].(map[string]any); ok {
		return nested, nil
	}
	return value, nil
}

func commandNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	return number, ok && !math.IsNaN(number) && !math.IsInf(number, 0) && number >= 0
}

func commandReset(value any) string {
	if text, ok := value.(string); ok {
		if parsed, err := time.Parse(time.RFC3339, text); err == nil {
			return parsed.UTC().Format(time.RFC3339)
		}
	}
	if number, ok := commandNumber(value); ok && number > 0 && number < 1e15 {
		// Command Code commonly returns unix milliseconds; zero means unknown.
		if number < 1e11 {
			number *= 1000
		}
		return time.UnixMilli(int64(number)).UTC().Format(time.RFC3339)
	}
	return ""
}

func normalizeCommandQuota(raw, subscription []byte) (commandQuota, error) {
	result := commandQuota{Windows: []commandWindow{}, Credits: map[string]float64{},
		UpdatedAt: time.Now().UTC().Format(time.RFC3339)}
	body, err := commandPayload(raw)
	if err != nil {
		return result, err
	}
	credits, _ := body["credits"].(map[string]any)
	total := 0.0
	for _, pool := range []string{"monthlyCredits", "purchasedCredits", "freeCredits"} {
		if value, ok := commandNumber(credits[pool]); ok {
			result.Credits[pool] = value
			total += value
		}
	}
	// An incomplete pool set is not an authoritative total balance.
	if len(result.Credits) == 3 && !math.IsInf(total, 0) {
		result.Balance = &total
	}
	limits, _ := body["windowLimits"].(map[string]any)
	for _, pair := range [][2]string{{"fiveHour", "5h"}, {"weekly", "weekly"}} {
		row, ok := limits[pair[0]].(map[string]any)
		if !ok {
			continue
		}
		used, usedOK := commandNumber(row["used"])
		cap, capOK := commandNumber(row["cap"])
		if !usedOK || !capOK || cap <= 0 {
			continue
		}
		result.Windows = append(result.Windows, commandWindow{
			Window: pair[1], Used: used, Cap: cap,
			RemainingFraction: math.Max(0, 1-used/cap), ResetTime: commandReset(row["resetAt"]),
		})
	}
	if len(result.Credits) == 0 && len(result.Windows) == 0 {
		return result, errCommandUnavailable
	}
	// Period end is not the expiry of purchased credits or a rolling-window reset.
	if sub, err := commandPayload(subscription); err == nil {
		result.PeriodEnd = commandReset(sub["currentPeriodEnd"])
	}
	return result, nil
}

func commandGET(ctx context.Context, client *http.Client, endpoint, query, key string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, commandOrigin+endpoint+query, nil)
	if err != nil {
		return nil, errCommandUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Accept", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, errCommandUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, errCommandUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return nil, errCommandUnavailable
	}
	return raw, nil
}

func queryCommandQuota(ctx context.Context, client *http.Client, key string) (commandQuota, error) {
	whoRaw, err := commandGET(ctx, client, "/alpha/whoami", "", key)
	if err != nil {
		return commandQuota{}, err
	}
	who, err := commandPayload(whoRaw)
	if err != nil {
		return commandQuota{}, err
	}
	query := ""
	if org, ok := who["org"].(map[string]any); ok {
		if id, ok := org["id"].(string); ok && strings.TrimSpace(id) != "" {
			query = "?orgId=" + url.QueryEscape(strings.TrimSpace(id))
		}
	}
	raw, err := commandGET(ctx, client, "/alpha/billing/credits", query, key)
	if err != nil {
		return commandQuota{}, err
	}
	// Subscription metadata is optional, unlike whoami/account scope and credits.
	sub, _ := commandGET(ctx, client, "/alpha/billing/subscriptions", query, key)
	return normalizeCommandQuota(raw, sub)
}

func fetchCommandQuota() (commandQuota, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return commandQuota{}, errCommandUnavailable
	}
	key, err := readCommandCredential(home)
	if err != nil {
		return commandQuota{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	transport := http.DefaultTransport.(*http.Transport).Clone()
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return errCommandUnavailable }}
	return queryCommandQuota(ctx, client, key)
}
