package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"time"
)

// Detached sends: `cdx send` (by default when stdout is not a terminal)
// re-executes itself as a background holder in its own session, relays the
// holder's first stdout line (the code or JSON), and exits 0. The holder
// keeps the relay room open until the receiver verifies the file and
// records its progress in a state file that `cdx status` and `cdx wait`
// read. Agents spend one tool call and never hold a long-lived shell.

const (
	phaseWaiting   = "waiting"
	phaseConnected = "connected"
	phaseSending   = "sending"
	phaseVerified  = "verified"
	phaseFailed    = "failed"

	holderCommand = "__hold"
	// readyWait bounds relay admission plus the code claim in the holder.
	readyWait = 30 * time.Second
	// Terminal states are kept a day for `cdx status`; anything older than
	// the relay room lifetime is stale whatever it says.
	finishedRetention = 24 * time.Hour
	staleRetention    = 3 * time.Hour
	waitPollInterval  = 200 * time.Millisecond
)

type transferState struct {
	Version      int       `json:"version"`
	Code         string    `json:"code,omitempty"`
	TransferID   string    `json:"transferId"`
	Filename     string    `json:"filename"`
	Size         uint64    `json:"size"`
	Phase        string    `json:"phase"`
	Acknowledged uint64    `json:"acknowledged"`
	Error        string    `json:"error,omitempty"`
	ErrorKind    string    `json:"errorKind,omitempty"`
	Retry        string    `json:"retry,omitempty"`
	PID          int       `json:"pid"`
	Log          string    `json:"log,omitempty"`
	StartedAt    time.Time `json:"startedAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (state transferState) finished() bool {
	return state.Phase == phaseVerified || state.Phase == phaseFailed
}

func holderArgs(request sendRequest, absolutePaths []string) []string {
	args := []string{holderCommand, "--json"}
	if request.progress {
		args = append(args, "--progress")
	}
	if request.linkMode {
		args = append(args, "--link")
	}
	if request.qrPath != "" {
		args = append(args, "--qr", request.qrPath)
	}
	return append(append(args, "--"), absolutePaths...)
}

// runDetachedSend starts the background holder and returns once it has
// printed the code. Named inputs are validated before starting the holder;
// the holder alone walks folders and reports problems within their contents.
func runDetachedSend(request sendRequest) int {
	fail := func(err error) int {
		reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput)
		return 1
	}
	if err := validateSourcePaths(request.files); err != nil {
		return fail(err)
	}
	if _, _, err := endpointBase(); err != nil {
		return fail(err)
	}
	absolutePaths := make([]string, len(request.files))
	for index, path := range request.files {
		absolute, err := filepath.Abs(path)
		if err != nil {
			return fail(err)
		}
		absolutePaths[index] = absolute
	}
	dir, err := stateDir()
	if err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fail(fmt.Errorf("create transfer state directory: %w", err))
	}
	pruneStates(dir, time.Now())
	executable, err := os.Executable()
	if err != nil {
		return fail(fmt.Errorf("find the cdx executable: %w", err))
	}
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	logPath := filepath.Join(dir, "send-"+hex.EncodeToString(suffix)+".log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fail(fmt.Errorf("create transfer log: %w", err))
	}
	defer logFile.Close()

	holder := exec.Command(executable, holderArgs(request, absolutePaths)...)
	holder.Env = append(os.Environ(), "CD_STATE_DIR="+dir, "CD_HOLDER_LOG="+logPath)
	holder.Stderr = logFile
	holder.SysProcAttr = detachAttributes()
	output, err := holder.StdoutPipe()
	if err != nil {
		return fail(err)
	}
	if err := holder.Start(); err != nil {
		return fail(fmt.Errorf("start the background sender: %w", err))
	}
	line := make(chan string, 1)
	go func() {
		value, _ := bufio.NewReader(output).ReadString('\n')
		line <- value
	}()
	select {
	case value := <-line:
		if strings.HasSuffix(value, "\n") {
			var ready readyOutput
			if err := json.Unmarshal([]byte(value), &ready); err != nil {
				_ = holder.Process.Kill()
				_ = holder.Wait()
				return fail(fmt.Errorf("read background sender: %w", err))
			}
			if !request.jsonOutput && isTerminal(os.Stdout) {
				writeReadyCard(os.Stdout, ready)
			} else if err := writeReady(os.Stdout, ready, request.jsonOutput); err != nil {
				_ = holder.Process.Kill()
				_ = holder.Wait()
				return fail(err)
			}
			if request.progress || (!request.jsonOutput && isTerminal(os.Stderr)) {
				fmt.Fprintln(os.Stderr, "sending in the background; `cdx wait <code>` exits 0 once the receiver has the file")
			}
			_ = holder.Process.Release()
			return 0
		}
		// The holder exited before it had a code: its log has the reason.
		_ = holder.Wait()
	case <-time.After(readyWait):
		_ = holder.Process.Kill()
		_ = holder.Wait()
		return fail(NewFailure(failureTimeout, "background sender was not ready within 30s: folder preparation or relay setup took too long; try fewer files or check your network", retrySameRequest))
	}
	reason := readHolderFailure(logPath)
	_ = os.Remove(logPath)
	_ = os.Remove(logPath + ".failure.json")
	return fail(reason)
}

// holderFailure extracts the holder's final `cdx:` error line from its log.
func holderFailure(logPath string) string {
	data, _ := os.ReadFile(logPath)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		if strings.HasPrefix(lines[index], "cdx:") {
			return lines[index]
		}
	}
	return "cdx: the background sender failed to start"
}

// runHolder is the background half of a detached send. Its stdout is the
// parent's pipe, used exactly once for the ready line.
func runHolder(args []string) int {
	request, err := parseSendArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(err.Error()))
		return 2
	}
	progressRequested = request.progress
	jsonProgress = request.jsonOutput
	dir := os.Getenv("CD_STATE_DIR")
	if dir == "" {
		fmt.Fprintln(os.Stderr, "cdx: missing transfer state directory")
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	if err := recordRequestHolder(request); err != nil {
		recordHolderFailure(err)
		fmt.Fprintln(os.Stderr, "cdx:", err)
		return 1
	}
	state := transferState{Version: 1, PID: os.Getpid(), Log: os.Getenv("CD_HOLDER_LOG"), StartedAt: time.Now().UTC()}
	lastWrite := time.Time{}
	saved := false
	save := func(force bool) error {
		if !saved || (!force && time.Since(lastWrite) < time.Second) {
			return nil
		}
		if err := writeState(dir, state); err != nil {
			fmt.Fprintln(os.Stderr, "cdx: record transfer state:", err)
			return err
		}
		lastWrite = time.Now()
		return nil
	}
	pipe := os.Stdout
	err = sendFile(ctx, request.files, request.linkMode, sendHooks{
		ready: func(value readyOutput) error {
			if err := saveReadyQR(&value, request.qrPath); err != nil {
				return err
			}
			state.Code = value.Code
			if value.TransferID == "" {
				value.TransferID = transferIDFromURL(value.URL)
			}
			state.TransferID = value.TransferID
			state.Filename = value.Filename
			state.Size = value.Size
			state.Phase = phaseWaiting
			saved = true
			// Persist identity and request replay before exposing readiness.
			if err := save(true); err != nil {
				return err
			}
			if err := recordRequestReady(value); err != nil {
				return err
			}
			if err := writeReady(pipe, value, request.jsonOutput); err != nil {
				return err
			}
			_ = pipe.Close()
			return nil
		},
		phase: func(phase string, acknowledged uint64) {
			changed := state.Phase != phase
			state.Phase = phase
			state.Acknowledged = acknowledged
			save(changed)
		},
	})
	if err != nil {
		state.Phase = phaseFailed
		if errors.Is(err, context.Canceled) {
			state.Error = "transfer canceled"
		} else {
			state.Error = strings.TrimSpace(err.Error())
		}
		state.ErrorKind = classifyFailure(err)
		state.Retry = failureGuidance(err)
		recordHolderFailure(err)
		_ = save(true)
		fmt.Fprintln(os.Stderr, "cdx:", state.Error)
		return 1
	}
	state.Phase = phaseVerified
	state.Acknowledged = state.Size
	if err := save(true); err != nil {
		recordHolderFailure(err)
		return 1
	}
	return 0
}

func transferIDFromURL(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(parsed.Path, "/s/")
}

func describeState(state transferState) string {
	name := state.Code
	if name == "" {
		name = state.TransferID
	}
	switch state.Phase {
	case phaseSending:
		percent := 100.0
		if state.Size > 0 {
			percent = float64(state.Acknowledged) / float64(state.Size) * 100
		}
		return fmt.Sprintf("%s sending %.0f%% %s", name, percent, state.Filename)
	case phaseFailed:
		return fmt.Sprintf("%s failed %s: %s", name, state.Filename, state.Error)
	default:
		return fmt.Sprintf("%s %s %s", name, state.Phase, state.Filename)
	}
}

func writeStateOutput(output io.Writer, state transferState, jsonOutput bool) {
	if jsonOutput {
		_ = json.NewEncoder(output).Encode(state)
		return
	}
	fmt.Fprintln(output, describeState(state))
}

// runStatus prints one transfer, or every recent one when no code is given.
func runStatus(args []string) int {
	jsonOutput, timeout, rest, err := parseStateArgs(args)
	if err != nil || len(rest) > 1 || timeout != 0 {
		fmt.Fprintln(os.Stderr, "usage: cdx status [--json] [code]")
		return 2
	}
	dir, err := stateDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cdx:", err)
		return 1
	}
	if len(rest) == 1 {
		state, code := lookupState(dir, rest[0], jsonOutput)
		if code != 0 {
			return code
		}
		writeStateOutput(os.Stdout, effectiveState(dir, state), jsonOutput)
		return 0
	}
	pruneStates(dir, time.Now())
	states, err := listStates(dir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "cdx:", err)
		return 1
	}
	for _, state := range states {
		writeStateOutput(os.Stdout, effectiveState(dir, state), jsonOutput)
	}
	return 0
}

// runWait blocks until the transfer finishes. Exit 0 means the receiver
// verified the file, 1 means it failed.
func runWait(args []string) int {
	jsonOutput, timeout, rest, err := parseStateArgs(args)
	if err != nil || len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "usage: cdx wait [--json] [--timeout <duration>] <code>")
		return 2
	}
	dir, err := stateDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cdx:", err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	state, code := lookupState(dir, rest[0], jsonOutput)
	if code != 0 {
		return code
	}
	var deadline <-chan time.Time
	if timeout > 0 {
		deadline = time.After(timeout)
	}
	for {
		state = effectiveState(dir, state)
		if state.finished() {
			break
		}
		select {
		case <-ctx.Done():
			return 1
		case <-deadline:
			// The send keeps going; only the wait gave up.
			writeStateOutput(os.Stdout, state, jsonOutput)
			fmt.Fprintf(os.Stderr, "cdx: %s not verified within %s (still %s)\n", rest[0], timeout, state.Phase)
			return exitTimeout
		case <-time.After(waitPollInterval):
		}
		if fresh, err := readState(dir, state.key()); err == nil {
			state = fresh
		}
	}
	writeStateOutput(os.Stdout, state, jsonOutput)
	if state.Phase == phaseVerified {
		return 0
	}
	return 1
}

func lookupState(dir, input string, jsonOutput bool) (transferState, int) {
	key, err := stateKeyFromInput(input)
	if err != nil {
		reportFailure(os.Stdout, os.Stderr, err, jsonOutput)
		return transferState{}, 2
	}
	state, err := readState(dir, key)
	if errors.Is(err, os.ErrNotExist) {
		reportFailure(os.Stdout, os.Stderr, NewFailure(failureNotFound, fmt.Sprintf("no transfer %s was sent from this machine", key), retryNever), jsonOutput)
		return transferState{}, 1
	}
	if err != nil {
		reportFailure(os.Stdout, os.Stderr, err, jsonOutput)
		return transferState{}, 1
	}
	return state, 0
}

// exitTimeout is `cdx wait --timeout` giving up while the send continues.
const exitTimeout = 3

func parseStateArgs(args []string) (bool, time.Duration, []string, error) {
	jsonOutput := false
	var timeout time.Duration
	var rest []string
	for index := 0; index < len(args); index++ {
		argument := args[index]
		switch {
		case argument == "--":
			return jsonOutput, timeout, append(rest, args[index+1:]...), nil
		case argument == "--json":
			jsonOutput = true
		case argument == "--timeout" || strings.HasPrefix(argument, "--timeout="):
			value, found := strings.CutPrefix(argument, "--timeout=")
			if !found {
				index++
				if index >= len(args) {
					return false, 0, nil, errors.New("--timeout needs a duration such as 90s or 5m")
				}
				value = args[index]
			}
			parsed, err := time.ParseDuration(value)
			if err != nil || parsed <= 0 {
				return false, 0, nil, fmt.Errorf("--timeout %q is not a duration such as 90s or 5m", value)
			}
			timeout = parsed
		case strings.HasPrefix(argument, "-"):
			return false, 0, nil, fmt.Errorf("unknown option %s", argument)
		default:
			rest = append(rest, argument)
		}
	}
	return jsonOutput, timeout, rest, nil
}

// Structured startup failures cross the detached process boundary without
// classifying human diagnostics by their wording.
func recordHolderFailure(err error) {
	log := os.Getenv("CD_HOLDER_LOG")
	if log == "" {
		return
	}
	var value failureOutput
	value.Version = 1
	value.Error.Kind = classifyFailure(err)
	value.Error.Message = err.Error()
	value.Error.Retry = failureGuidance(err)
	data, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		return
	}
	temporary, writeErr := os.CreateTemp(filepath.Dir(log), ".failure-*")
	if writeErr != nil {
		return
	}
	defer os.Remove(temporary.Name())
	if _, writeErr = temporary.Write(data); writeErr != nil {
		temporary.Close()
		return
	}
	if writeErr = temporary.Close(); writeErr != nil {
		return
	}
	_ = os.Rename(temporary.Name(), log+".failure.json")
}

func readHolderFailure(log string) error {
	path := log + ".failure.json"
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return NewFailure(failureOther, holderFailure(log), retryNever)
	}
	if err != nil {
		return NewFailure(failureLocal, "read background failure: "+err.Error(), retryNever, err)
	}
	if !info.Mode().IsRegular() || info.Size() > 65536 {
		return NewFailure(failureProtocol, "background sender failure record is invalid", retryNever)
	}
	data, err := os.ReadFile(path)
	var value failureOutput
	if err == nil {
		err = json.Unmarshal(data, &value)
	}
	if err != nil || value.Version != 1 || value.Error.Kind == "" || value.Error.Message == "" || (value.Error.Retry != retryNever && value.Error.Retry != retrySameRequest && value.Error.Retry != retryNewTransfer) {
		return NewFailure(failureProtocol, "background sender failure record is corrupt", retryNever, err)
	}
	return NewFailure(value.Error.Kind, value.Error.Message, value.Error.Retry)
}
