package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct {
  uint32_t abi_version; void* host_ctx;
  cliproxy_host_call_fn call; cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct {
  uint32_t abi_version; cliproxy_plugin_call_fn call;
  cliproxy_plugin_free_fn free_buffer; cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;
extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"
)

// CPA ABI 1 / JSON schema 6, verified against v8.0.12 sdk/pluginabi.
// No model/auth/executor capabilities: this plugin cannot alter model routing.
const accountRoute = "/v0/management/plugins/factory-quota/account"

var errUnavailable = errors.New("Factory billing quota unavailable")

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if host == nil || plugin == nil || host.abi_version != 1 {
		return 1
	}
	plugin.abi_version = 1
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, size C.size_t, response *C.cliproxy_buffer) C.int {
	if response == nil {
		return 1
	}
	response.ptr = nil
	response.len = 0
	var data []byte
	if method == nil || uint64(size) > 4*1024*1024 {
		return 1
	}
	if request != nil && size > 0 {
		data = C.GoBytes(unsafe.Pointer(request), C.int(size))
	}
	result, err := handleMethod(C.GoString(method), data)
	envelope := map[string]any{"ok": true, "result": result}
	if err != nil {
		// Never propagate HTTP bodies, credentials, paths or exception text.
		message := errUnavailable.Error()
		if errors.Is(err, errCommandUnavailable) {
			message = errCommandUnavailable.Error()
		}
		envelope = map[string]any{"ok": false, "error": map[string]string{
			"code": "quota_unavailable", "message": message,
		}}
	}
	raw, marshalErr := json.Marshal(envelope)
	if marshalErr != nil {
		return 1
	}
	response.ptr = C.CBytes(raw)
	response.len = C.size_t(len(raw))
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, size C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {}

func handleMethod(method string, request []byte) (any, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		return map[string]any{
			"schema_version": 6,
			"metadata": map[string]any{"Name": "Factory and Command Code Account Quota", "Version": "0.2.0",
				"Author": "metabridge", "GitHubRepository": "local://codex-metabridge/integrations/cpa-account-quota"},
			"capabilities": map[string]bool{"quota_provider": true, "management_api": true},
		}, nil
	case "plugin.quiesce", "plugin.shutdown":
		return map[string]any{}, nil
	case "quota.identifier":
		return map[string]string{"identifier": "factory"}, nil
	case "quota.describe":
		return map[string]any{"supported_providers": []string{"factory", "command-code"},
			"display_name": "Factory / Command Code", "supports_reset": false}, nil
	case "quota.fetch":
		var req struct {
			Provider string `json:"provider"`
		}
		if json.Unmarshal(request, &req) != nil {
			return nil, errUnavailable
		}
		if req.Provider == "command-code" {
			return fetchCommandQuota()
		}
		if req.Provider != "factory" {
			return nil, errUnavailable
		}
		return fetchQuota()
	case "quota.reset":
		return nil, errUnavailable // No upstream reset capability.
	case "management.register":
		return map[string]any{"routes": []map[string]string{
			{"Method": "GET", "Path": accountRoute},
			{"Method": "GET", "Path": commandRoute},
		}}, nil
	case "management.handle":
		var req struct{ Method, Path string }
		if json.Unmarshal(request, &req) != nil || req.Method != "GET" ||
			(req.Path != accountRoute && req.Path != commandRoute) {
			return managementResponse(404, map[string]string{"error": "Unsupported Factory route"}), nil
		}
		if req.Path == commandRoute {
			quota, err := fetchCommandQuota()
			if err != nil {
				return managementResponse(502, map[string]string{"error": errCommandUnavailable.Error()}), nil
			}
			return managementResponse(200, quota), nil
		}
		quota, err := fetchQuota()
		if err != nil {
			return managementResponse(502, map[string]string{"error": errUnavailable.Error()}), nil
		}
		return managementResponse(200, quota), nil
	default:
		return nil, errUnavailable
	}
}

func managementResponse(status int, value any) any {
	body, _ := json.Marshal(value)
	return map[string]any{"StatusCode": status, "Headers": map[string][]string{
		"Content-Type": {"application/json"}, "Cache-Control": {"no-store"},
	}, "Body": body}
}

func readCredential(home string) (string, string, error) {
	configPath := filepath.Join(home, ".config/cliproxyapi/quota/factory.json")
	raw, err := readPrivateFile(configPath)
	if err != nil {
		return "", "", errUnavailable
	}
	var config struct {
		Name    string                      `json:"name"`
		BaseURL string                      `json:"base_url"`
		Auth    struct{ Type, File string } `json:"auth"`
		Gateway struct {
			Host string
			Port int
		} `json:"gateway"`
	}
	if json.Unmarshal(raw, &config) != nil || config.Name != "factory" ||
		config.BaseURL != "https://api.factory.ai" || config.Auth.Type != "keyfile" ||
		config.Auth.File == "" || config.Gateway.Host != "127.0.0.1" ||
		config.Gateway.Port < 1 || config.Gateway.Port > 65535 {
		return "", "", errUnavailable
	}
	keyPath := config.Auth.File
	if strings.HasPrefix(keyPath, "~/") {
		keyPath = filepath.Join(home, keyPath[2:])
	}
	if !filepath.IsAbs(keyPath) {
		keyPath = filepath.Join(filepath.Dir(configPath), keyPath)
	}
	keyRaw, err := readPrivateFile(keyPath)
	if err != nil {
		return "", "", errUnavailable
	}
	key := strings.TrimSpace(string(keyRaw))
	if key == "" || strings.ContainsAny(key, "\r\n") {
		return "", "", errUnavailable
	}
	return fmt.Sprintf("http://127.0.0.1:%d/v1/quota", config.Gateway.Port), key, nil
}

func readPrivateFile(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, errUnavailable
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm()&0077 != 0 ||
		stat.Size() > 128*1024 {
		return nil, errUnavailable
	}
	return io.ReadAll(io.LimitReader(file, 128*1024+1))
}

func fetchQuota() (json.RawMessage, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, errUnavailable
	}
	url, key, err := readCredential(home)
	if err != nil {
		return nil, errUnavailable
	}
	client := &http.Client{
		Timeout:       25 * time.Second,
		Transport:     &http.Transport{Proxy: nil}, // Localhost must never go through the corporate proxy.
		CheckRedirect: func(*http.Request, []*http.Request) error { return errUnavailable },
	}
	defer client.CloseIdleConnections()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, errUnavailable
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := client.Do(req)
	if err != nil {
		return nil, errUnavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errUnavailable
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 || !json.Valid(raw) {
		return nil, errUnavailable
	}
	return json.RawMessage(raw), nil
}
