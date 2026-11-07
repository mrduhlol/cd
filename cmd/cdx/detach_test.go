package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestShouldDetachDefaultsToBackgroundWithoutATerminal(t *testing.T) {
	tests := []struct {
		name     string
		request  sendRequest
		terminal bool
		want     bool
	}{
		{"terminal", sendRequest{}, true, false},
		{"pipe or agent", sendRequest{}, false, true},
		{"--detach in a terminal", sendRequest{detach: true}, true, true},
		{"--wait without a terminal", sendRequest{wait: true}, false, false},
	}
	for _, test := range tests {
		if got := shouldDetach(test.request, test.terminal); got != test.want {
			t.Fatalf("%s: shouldDetach = %v, want %v", test.name, got, test.want)
		}
	}
}

func TestParseSendArgsDetachAndWaitFlags(t *testing.T) {
	request, err := parseSendArgs([]string{"--detach", "file.bin"})
	if err != nil || !request.detach {
		t.Fatalf("--detach = %#v, %v", request, err)
	}
	request, err = parseSendArgs([]string{"file.bin", "--wait"})
	if err != nil || !request.wait {
		t.Fatalf("--wait = %#v, %v", request, err)
	}
	if _, err := parseSendArgs([]string{"--detach", "--wait", "file.bin"}); err == nil {
		t.Fatal("accepted --detach with --wait")
	}
}

func TestStateKeyFromInputAcceptsCodesIDsAndLinks(t *testing.T) {
	for input, want := range map[string]string{
		"48291":                  "48291",
		" 4829 ":                 "4829",
		"aO6Ww6lyA10XmqHEgQYHyA": "aO6Ww6lyA10XmqHEgQYHyA",
		"https://cd.yash0.in/s/aO6Ww6lyA10XmqHEgQYHyA#v1.key": "aO6Ww6lyA10XmqHEgQYHyA",
	} {
		if got, err := stateKeyFromInput(input); err != nil || got != want {
			t.Fatalf("stateKeyFromInput(%q) = %q, %v", input, got, err)
		}
	}
	for _, input := range []string{"", "123", "../../etc/passwd", "48291.json"} {
		if _, err := stateKeyFromInput(input); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
}

func TestStateRoundTripAndLinkModeKey(t *testing.T) {
	dir := t.TempDir()
	coded := transferState{Version: 1, Code: "48291", TransferID: "aO6Ww6lyA10XmqHEgQYHyA", Filename: "a.bin", Phase: phaseWaiting, PID: os.Getpid(), StartedAt: time.Now().UTC()}
	if err := writeState(dir, coded); err != nil {
		t.Fatal(err)
	}
	read, err := readState(dir, "48291")
	if err != nil || read.Filename != "a.bin" || read.UpdatedAt.IsZero() {
		t.Fatalf("readState = %#v, %v", read, err)
	}
	linked := transferState{Version: 1, TransferID: "bO6Ww6lyA10XmqHEgQYHyA", Filename: "b.bin", Phase: phaseWaiting, PID: os.Getpid(), StartedAt: time.Now().UTC()}
	if err := writeState(dir, linked); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "bO6Ww6lyA10XmqHEgQYHyA.json")); err != nil {
		t.Fatalf("link-mode state is not keyed by transfer ID: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, coded.TransferID+".json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("state file mode = %v, %v", info.Mode().Perm(), err)
	}
}

func deadPID(t *testing.T) int {
	t.Helper()
	command := exec.Command(os.Args[0], "-test.run=^$")
	if err := command.Run(); err != nil {
		t.Fatal(err)
	}
	return command.Process.Pid
}

func TestEffectiveStateReportsADeadHolderAsFailed(t *testing.T) {
	dir := t.TempDir()
	state := transferState{Version: 1, Code: "48291", TransferID: "aO6Ww6lyA10XmqHEgQYHyA", Filename: "a.bin", StartedAt: time.Now().UTC(), Phase: phaseSending, PID: deadPID(t)}
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	if got := effectiveState(dir, state); got.Phase != phaseFailed || got.Error == "" {
		t.Fatalf("dead holder state = %#v", got)
	}
	// A holder that wrote its final state before exiting is not a failure.
	state.Phase = phaseVerified
	if err := writeState(dir, state); err != nil {
		t.Fatal(err)
	}
	stale := state
	stale.Phase = phaseSending
	if got := effectiveState(dir, stale); got.Phase != phaseVerified {
		t.Fatalf("finished holder state = %#v", got)
	}
	live := transferState{Code: "1234", Phase: phaseWaiting, PID: os.Getpid(), StartedAt: time.Now().UTC()}
	if got := effectiveState(dir, live); got.Phase != phaseWaiting {
		t.Fatalf("live holder state = %#v", got)
	}
}

func TestPruneStatesKeepsRecentTransfers(t *testing.T) {
	dir := t.TempDir()
	for _, state := range []transferState{
		{Version: 1, Code: "1111", TransferID: "aO6Ww6lyA10XmqHEgQYHyA", Filename: "a.bin", PID: os.Getpid(), StartedAt: time.Now().UTC(), Phase: phaseVerified},
		{Version: 1, Code: "2222", TransferID: "bO6Ww6lyA10XmqHEgQYHyA", Filename: "b.bin", PID: os.Getpid(), StartedAt: time.Now().UTC(), Phase: phaseSending},
	} {
		if err := writeState(dir, state); err != nil {
			t.Fatal(err)
		}
	}
	pruneStates(dir, time.Now().Add(time.Hour))
	if states, _ := listStates(dir); len(states) != 2 {
		t.Fatalf("pruned recent transfers: %d left", len(states))
	}
	pruneStates(dir, time.Now().Add(4*time.Hour))
	if states, _ := listStates(dir); len(states) != 1 || states[0].Code != "1111" {
		t.Fatalf("after stale prune = %#v", states)
	}
	pruneStates(dir, time.Now().Add(25*time.Hour))
	if states, _ := listStates(dir); len(states) != 0 {
		t.Fatalf("after finished prune = %#v", states)
	}
}

func TestHolderFailureReturnsTheLastErrorLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "send.log")
	if err := os.WriteFile(path, []byte("sharing a.bin\ncdx: first\nnoise\ncdx: CD relay did not answer\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := holderFailure(path); got != "cdx: CD relay did not answer" {
		t.Fatalf("holderFailure = %q", got)
	}
}

func TestDetachedPreparationReturnsReadyAndReportsNestedErrors(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "cdx")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v: %s", err, output)
	}
	newFakeRelay(t, "11111")
	stateDirectory := t.TempDir()
	t.Setenv("CD_STATE_DIR", stateDirectory)
	root := t.TempDir()
	folder := filepath.Join(root, "tree")
	for i := 0; i < 10000; i++ {
		writeTestFile(t, filepath.Join(folder, fmt.Sprintf("dir-%03d", i/100), fmt.Sprintf("file-%05d", i)), make([]byte, 4096))
	}
	extra := filepath.Join(root, "extra.txt")
	writeTestFile(t, extra, []byte("extra"))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, binary, "send", "--json", folder, extra)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	started := time.Now()
	if err := command.Run(); err != nil {
		t.Fatalf("detached send: %v: %s", err, stderr.String())
	}
	t.Logf("10000-file tree plus file detached readiness: %s", time.Since(started))
	if stderr.Len() != 0 {
		t.Fatalf("captured detached send wrote progress without opt-in: %s", stderr.String())
	}
	var ready readyOutput
	if err := json.Unmarshal(stdout.Bytes(), &ready); err != nil || ready.Code != "11111" || ready.Size == 0 {
		t.Fatalf("ready = %s, %v", stdout.Bytes(), err)
	}
	state, err := readState(stateDirectory, ready.Code)
	if err != nil {
		t.Fatal(err)
	}
	process, err := os.FindProcess(state.PID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = process.Kill() })
	if !processAlive(state.PID) {
		t.Fatal("holder stopped when parent returned")
	}
	if runtime.GOOS != "windows" {
		invalid := filepath.Join(root, "invalid-tree")
		writeTestFile(t, filepath.Join(invalid, "bad-\xff"), []byte("content"))
		failure := exec.CommandContext(ctx, binary, "send", invalid)
		output, err := failure.CombinedOutput()
		if err == nil || !strings.Contains(string(output), "UTF-8") || !strings.Contains(string(output), "bad-") {
			t.Fatalf("nested failure = %v, %s", err, output)
		}
	}
}

func TestHolderArgsPreservesProgressOptIn(t *testing.T) {
	for _, progress := range []bool{false, true} {
		arguments := holderArgs(sendRequest{progress: progress}, []string{"/tmp/example"})
		request, err := parseSendArgs(arguments[1:])
		if err != nil || request.progress != progress || !request.jsonOutput {
			t.Fatalf("holder args %q parsed as %#v, %v", arguments, request, err)
		}
	}
}

func TestParseStateArgsAcceptsDashPrefixedTransferID(t *testing.T) {
	jsonOutput, timeout, rest, err := parseStateArgs([]string{"--json", "--timeout", "30s", "--", "-ABCDEFGHIJKLMNOPQRSTU"})
	if err != nil || !jsonOutput || timeout != 30*time.Second || len(rest) != 1 || rest[0] != "-ABCDEFGHIJKLMNOPQRSTU" {
		t.Fatalf("state arguments = %v %v %v %v", jsonOutput, timeout, rest, err)
	}
}
