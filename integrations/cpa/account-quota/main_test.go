package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

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
