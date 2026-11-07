package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/YashasVM/cd/internal/devices"
)

func TestDeviceDetachedCLIReportsChildFailure(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "cdx")
	if output, err := exec.Command("go", "build", "-o", binary, ".").CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, output)
	}
	t.Setenv("CD_STATE_DIR", filepath.Join(dir, "state"))
	t.Setenv("CD_DEVICE_DIR", filepath.Join(dir, "devices"))
	pair, err := devices.NewPair("Test phone", "wss://cd.yash0.in", nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	store, err := deviceStore()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save("paired-target", pair); err != nil {
		t.Fatal(err)
	}
	t.Setenv("CD_DEVICE_LISTEN", "invalid-listen-address")
	source := filepath.Join(dir, "--payload with spaces.bin")
	if err := os.WriteFile(source, []byte("payload"), 0600); err != nil {
		t.Fatal(err)
	}
	output, err := exec.Command(binary, "send", "--to", "paired-target", "--json", "--", source).CombinedOutput()
	if err != nil {
		t.Fatalf("parent: %v: %s", err, output)
	}
	var result struct {
		PID int    `json:"pid"`
		Log string `json:"log"`
	}
	if err := json.Unmarshal(output, &result); err != nil || result.PID <= 0 || filepath.Dir(result.Log) != os.Getenv("CD_STATE_DIR") {
		t.Fatalf("invalid background result: %s (%v)", output, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		data, err := os.ReadFile(result.Log)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), "invalid-listen-address") {
			if strings.Contains(string(data), `"phase":"verified"`) || strings.Contains(string(data), `"pid":`) {
				t.Fatalf("incorrect child result: %s", data)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("child failed to log failure: %s", data)
		}
		time.Sleep(10 * time.Millisecond)
	}
	logs, err := filepath.Glob(filepath.Join(os.Getenv("CD_STATE_DIR"), "device-send-*.log"))
	if err != nil || len(logs) != 1 {
		t.Fatalf("recursive detach: %v, %v", logs, err)
	}
	output, err = exec.Command(binary, "send", "--to", "paired-target", "--json", "--", source+" missing").CombinedOutput()
	if err == nil || strings.Contains(string(output), `"pid":`) {
		t.Fatalf("invalid source detached: %s (%v)", output, err)
	}
}
