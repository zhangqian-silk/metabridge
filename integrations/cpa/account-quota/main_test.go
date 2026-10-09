package main

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestAccountQuotaFailureDoesNotHideOtherAccount(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".config/cliproxyapi/quota")
	os.MkdirAll(dir, 0700)
	for i, id := range []string{"factory", "factory-2"} {
		key := id + "-private"
		fail := i == 1
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/quota" || r.Header.Get("Authorization") != "Bearer "+key {
				t.Error("wrong account credential or path")
			}
			if fail {
				w.WriteHeader(502)
				w.Write([]byte("secret upstream body"))
				return
			}
			w.Write([]byte(`{"groups":[{"displayName":"Standard","buckets":[{"window":"weekly","remainingFraction":0.2}]}]}`))
		}))
		defer server.Close()
		raw, _ := json.Marshal(map[string]any{"name": "factory", "base_url": "https://api.factory.ai",
			"auth":    map[string]string{"type": "keyfile", "file": id + "-key"},
			"gateway": map[string]any{"host": "127.0.0.1", "port": server.Listener.Addr().(*net.TCPAddr).Port}})
		os.WriteFile(filepath.Join(dir, id+".json"), raw, 0600)
		os.WriteFile(filepath.Join(dir, id+"-key"), []byte(key), 0600)
	}
	result, err := fetchAccountQuotasForHome(home)
	if err != nil {
		t.Fatal(err)
	}
	accounts := result.(map[string]any)["accounts"].([]accountQuota)
	if len(accounts) != 2 || accounts[0].ID != "factory" || len(accounts[0].Quota) == 0 ||
		accounts[0].Error != "" || accounts[1].ID != "factory-2" || len(accounts[1].Quota) != 0 ||
		accounts[1].Error != errUnavailable.Error() {
		t.Fatal("account success/failure isolation failed")
	}
}

func TestSeparateFactoryCredentialFiles(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".config/cliproxyapi/quota")
	os.MkdirAll(dir, 0700)
	for i, id := range []string{"factory", "factory-2"} {
		raw, _ := json.Marshal(map[string]any{"name": "factory", "base_url": "https://api.factory.ai",
			"auth":    map[string]string{"type": "keyfile", "file": id + "-key"},
			"gateway": map[string]any{"host": "127.0.0.1", "port": 8319 + i}})
		os.WriteFile(filepath.Join(dir, id+".json"), raw, 0600)
		os.WriteFile(filepath.Join(dir, id+"-key"), []byte(id+"-private"), 0600)
		url, key, err := readAccountCredential(home, id)
		if err != nil || key != id+"-private" || url == "" {
			t.Fatal("account credential isolation failed")
		}
	}
	for _, id := range []string{"../factory", "factory.json", "other", "factory-"} {
		if _, _, err := readAccountCredential(home, id); err == nil {
			t.Fatal("invalid account accepted")
		}
	}
	ids, err := factoryAccountIDs(home)
	if err != nil || len(ids) != 2 || ids[0] != "factory" || ids[1] != "factory-2" {
		t.Fatal("account discovery failed")
	}
}

func TestQuotaPluginIsReadOnlyAndDoesNotRegisterRouting(t *testing.T) {
	result, err := handleMethod("plugin.register", nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(result)
	var registration struct{ Capabilities map[string]bool }
	if json.Unmarshal(raw, &registration) != nil {
		t.Fatal("invalid registration")
	}
	for key, enabled := range registration.Capabilities {
		if enabled && key != "quota_provider" && key != "management_api" {
			t.Fatal("unexpected capability", key)
		}
	}
	if _, err := handleMethod("quota.reset", nil); err == nil {
		t.Fatal("reset must be rejected")
	}
	if _, err := handleMethod("quota.fetch", []byte(`{"provider":"codex"}`)); err == nil {
		t.Fatal("wrong provider accepted")
	}
	result, _ = handleMethod("management.handle", []byte(`{"Method":"POST","Path":"`+accountRoute+`"}`))
	if result.(map[string]any)["StatusCode"] != 404 {
		t.Fatal("mutation route accepted")
	}
}

func TestFileCredentialIsPrivateAndCannotRedirectToRemoteHost(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".config/cliproxyapi/quota")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	config := map[string]any{"name": "factory", "base_url": "https://api.factory.ai",
		"auth":    map[string]string{"type": "keyfile", "file": "factory-key"},
		"gateway": map[string]any{"host": "127.0.0.1", "port": 8319}}
	filename := filepath.Join(dir, "factory.json")
	writeConfig := func() {
		raw, _ := json.Marshal(config)
		if err := os.WriteFile(filename, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeConfig()
	keyfile := filepath.Join(dir, "factory-key")
	if err := os.WriteFile(keyfile, []byte("fixture-private"), 0600); err != nil {
		t.Fatal(err)
	}
	url, key, err := readCredential(home)
	if err != nil || url != "http://127.0.0.1:8319/v1/quota" || key != "fixture-private" {
		t.Fatal("private file config failed")
	}
	if err := os.Chmod(keyfile, 0644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readCredential(home); err == nil {
		t.Fatal("public key file accepted")
	}
	os.Chmod(keyfile, 0600)
	config["gateway"] = map[string]any{"host": "evil.example", "port": 8319}
	writeConfig()
	if _, _, err := readCredential(home); err == nil {
		t.Fatal("remote URL accepted")
	}
}
