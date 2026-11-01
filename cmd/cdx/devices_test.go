package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/YashasVM/cd/internal/devices"
	"github.com/gorilla/websocket"
)

func TestDeviceSendFlagsAndHelp(t *testing.T) {
	for _, args := range [][]string{{"--to", "phone", "file.bin"}, {"file.bin", "--to=phone", "--json"}, {"--to", "phone", "--wait", "file.bin"}} {
		request, err := parseSendArgs(args)
		if err != nil || request.to != "phone" || len(request.files) != 1 {
			t.Fatalf("target flags %v: %+v %v", args, request, err)
		}
	}
	for _, args := range [][]string{{"--to"}, {"--to=", "file.bin"}, {"--to", "--json", "file.bin"}} {
		if _, err := parseSendArgs(args); err == nil {
			t.Errorf("invalid target flags accepted: %v", args)
		}
	}
	var help bytes.Buffer
	sendUsage(&help)
	if !strings.Contains(help.String(), "--to <name>") || !strings.Contains(help.String(), "paired Android") {
		t.Fatal("send help omits trusted-device flow")
	}
	request, err := parseSendArgs([]string{"--help"})
	if err != nil || !request.help {
		t.Fatal("help failed")
	}
	request, err = parseSendArgs([]string{"--", "--to"})
	if err != nil || request.to != "" || len(request.files) != 1 || request.files[0] != "--to" {
		t.Fatal("flag terminator lost filename")
	}
}

// Tests remain serial while replacing process stdout. Every transfer goroutine
// finishes before the caller reads output or the cleanup restores stdout.
func deviceTestOutput(t *testing.T) *os.File {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "stdout")
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stdout
	os.Stdout = file
	t.Cleanup(func() { os.Stdout = original; file.Close() })
	return file
}
func deviceOutputBytes(t *testing.T, file *os.File) []byte {
	t.Helper()
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestDevicesCLIListsNoSecretsAndForgetsCredential(t *testing.T) {
	t.Setenv("CD_DEVICE_DIR", filepath.Join(t.TempDir(), "devices"))
	output := deviceTestOutput(t)
	pair, err := devices.NewPair("S24 Ultra", "wss://cd.yash0.in", nil, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	store, err := deviceStore()
	if err != nil {
		t.Fatal(err)
	}
	if err = store.Save("phone", pair); err != nil {
		t.Fatal(err)
	}
	if code := runDevices([]string{"--json"}); code != 0 {
		t.Fatalf("devices exit %d", code)
	}
	b := deviceOutputBytes(t, output)
	if bytes.Contains(b, []byte(pair.Secret)) || bytes.Contains(b, []byte("secret")) || bytes.Contains(b, []byte("qr")) {
		t.Fatal("device listing exposes pairing material")
	}
	var listing struct {
		Version int                     `json:"version"`
		Devices []devices.DeviceSummary `json:"devices"`
	}
	if err = json.Unmarshal(b, &listing); err != nil || listing.Version != 1 || len(listing.Devices) != 1 || listing.Devices[0].Name != "phone" || listing.Devices[0].DeviceName != "S24 Ultra" {
		t.Fatalf("wrong device listing: %s %v", b, err)
	}
	if code := runDevices([]string{"forget", "phone", "--json"}); code != 0 {
		t.Fatalf("forget exit %d", code)
	}
	if _, err = store.Load("phone"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("forgotten credential remains: %v", err)
	}
	if code := runDevices([]string{"forget"}); code != 2 {
		t.Fatalf("missing name exit %d", code)
	}
	if code := runDeviceSend(sendRequest{to: "phone", files: []string{"unused"}, jsonOutput: true}); code != 1 {
		t.Fatalf("unpaired target exit %d", code)
	}
}

type deviceTransferHarness struct {
	mu     sync.Mutex
	active *localResume
	server *httptest.Server
}

func newDeviceTransferHarness(t *testing.T) *deviceTransferHarness {
	t.Helper()
	h := &deviceTransferHarness{}
	h.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		active := h.active
		h.mu.Unlock()
		if active == nil {
			http.NotFound(w, r)
			return
		}
		active.ServeHTTP(w, r)
	}))
	t.Cleanup(func() {
		h.mu.Lock()
		if h.active != nil {
			h.active.Close()
		}
		h.mu.Unlock()
		h.server.Close()
	})
	return h
}
func (h *deviceTransferHarness) arm(invite invitation, expiry int64) *localResume {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.active != nil {
		h.active.Close()
	}
	h.active = newLocalResume(invite, expiry)
	return h.active
}
func deviceTransferEnvironment(t *testing.T, origin string) {
	t.Helper()
	t.Setenv("CD_STATE_DIR", t.TempDir())
	t.Setenv("CD_RELAY_URL", "ws"+strings.TrimPrefix(origin, "http")+"/ws/v1")
	t.Setenv("CD_PUBLIC_URL", origin)
}
func deviceSource(t *testing.T, size int) (string, []byte) {
	t.Helper()
	contents := make([]byte, size)
	for i := range contents {
		contents[i] = byte((i*31 + i/251) % 256)
	}
	path := filepath.Join(t.TempDir(), "payload.bin")
	if err := os.WriteFile(path, contents, 0600); err != nil {
		t.Fatal(err)
	}
	return path, contents
}
func waitDeviceResult(t *testing.T, ctx context.Context, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-ctx.Done():
		t.Fatalf("transfer goroutine exceeded deadline: %v", ctx.Err())
		return ctx.Err()
	}
}

func TestDeviceLocalSendAndReceivePublishExactMultipleChunks(t *testing.T) {
	h := newDeviceTransferHarness(t)
	deviceTransferEnvironment(t, h.server.URL)
	deviceTestOutput(t)
	path, want := deviceSource(t, 6*1024*1024+137)
	destination := filepath.Join(t.TempDir(), "received.bin")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	received := make(chan error, 1)
	var transferID string
	request := sendRequest{files: []string{path}, jsonOutput: true}
	request.deviceConnect = func(callCtx context.Context, invite invitation, _ []byte, expiry int64, ready readyOutput, _ string) (*resumeSession, error) {
		transferID = invite.encodedID()
		local := h.arm(invite, expiry)
		go func() {
			received <- receiveResumable(callCtx, receiveRequest{resume: true, code: ready.URL, out: destination, jsonOutput: true})
		}()
		select {
		case session := <-local.Sessions:
			return session, nil
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
	}
	if err := sendResumable(ctx, request); err != nil {
		t.Fatal(err)
	}
	if err := waitDeviceResult(t, ctx, received); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("published bytes differ: length %d wanted %d error %v", len(got), len(want), err)
	}
	capability, _ := resumeCapabilityPath(transferID)
	if _, err = os.Stat(capability); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("verified sender retained private capability")
	}
	entries, err := os.ReadDir(filepath.Dir(destination))
	if err != nil || len(entries) != 1 || entries[0].Name() != "received.bin" {
		t.Fatalf("receiver retained staging/checkpoint: %+v %v", entries, err)
	}
}

// A real WebSocket proxy interrupts only the first session after forwarding two
// durable ACKs. Neither endpoint gets a context cancellation, so retained state
// must survive as it would during a Wi-Fi interruption.
func deviceDropProxy(t *testing.T, upstream string) *httptest.Server {
	t.Helper()
	var connected atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		downstream, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer downstream.Close()
		remote, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(upstream, "http")+r.URL.Path, nil)
		if err != nil {
			return
		}
		defer remote.Close()
		drop := connected.Add(1) == 1
		done := make(chan struct{}, 2)
		forward := func(to, from *websocket.Conn, intercept bool) {
			defer func() { done <- struct{}{} }()
			acks := 0
			for {
				kind, data, err := from.ReadMessage()
				if err != nil {
					return
				}
				if err = to.WriteMessage(kind, data); err != nil {
					return
				}
				if intercept && drop && kind == websocket.BinaryMessage && len(data) >= headerBytes && messageKind(data[3]) == kindAck {
					acks++
					if acks == 2 {
						return
					}
				}
			}
		}
		go forward(remote, downstream, true)
		go forward(downstream, remote, false)
		<-done
		downstream.Close()
		remote.Close()
		<-done
	}))
	t.Cleanup(server.Close)
	return server
}
func TestDeviceLocalResumeRecoversDurableProgressAfterNetworkLoss(t *testing.T) {
	h := newDeviceTransferHarness(t)
	proxy := deviceDropProxy(t, h.server.URL)
	deviceTransferEnvironment(t, proxy.URL)
	output := deviceTestOutput(t)
	path, want := deviceSource(t, 8*1024*1024+31)
	destination := filepath.Join(t.TempDir(), "recovered.bin")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	received := make(chan error, 1)
	var transferID string
	var senderNonces []string
	request := sendRequest{files: []string{path}, jsonOutput: true}
	request.deviceConnect = func(callCtx context.Context, invite invitation, _ []byte, expiry int64, ready readyOutput, _ string) (*resumeSession, error) {
		transferID = invite.encodedID()
		local := h.arm(invite, expiry)
		go func() {
			received <- receiveResumable(callCtx, receiveRequest{resume: true, code: ready.URL, out: destination, jsonOutput: true})
		}()
		select {
		case session := <-local.Sessions:
			senderNonces = append(senderNonces, session.senderNonce)
			return session, nil
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
	}
	if err := sendResumable(ctx, request); err == nil {
		t.Fatal("interrupted send claimed verification")
	}
	if err := waitDeviceResult(t, ctx, received); err == nil {
		t.Fatal("interrupted receiver claimed completion")
	}
	if _, err := os.Stat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("interrupted receiver published incomplete file")
	}
	_, checkpointPath, err := resumeDest("payload.bin", destination, transferID)
	if err != nil {
		t.Fatal(err)
	}
	var checkpoint ResumeCheckpoint
	if err = resumeReadJSON(checkpointPath, &checkpoint); err != nil {
		t.Fatal(err)
	}
	if checkpoint.Offset < 2*chunkSize || checkpoint.Offset >= int64(len(want)) {
		t.Fatalf("expected retained durable prefix, got %d", checkpoint.Offset)
	}
	retained := checkpoint.Offset
	request.resumeID = transferID
	if err = sendResumable(ctx, request); err != nil {
		t.Fatal(err)
	}
	if err = waitDeviceResult(t, ctx, received); err != nil {
		t.Fatal(err)
	}
	if len(senderNonces) != 2 || senderNonces[0] == senderNonces[1] {
		t.Fatal("resumption reused sender nonce")
	}
	got, err := os.ReadFile(destination)
	if err != nil || !bytes.Equal(got, want) {
		t.Fatalf("recovered bytes differ: %d %v", len(got), err)
	}
	var result struct {
		ResumedBytes int64 `json:"resumedBytes"`
	}
	if err = json.Unmarshal(bytes.TrimSpace(deviceOutputBytes(t, output)), &result); err != nil || result.ResumedBytes != retained {
		t.Fatalf("receiver did not reuse its exact durable prefix: %+v %v expected %d", result, err, retained)
	}
}

func TestDeviceSenderPipelinesChunksAndRejectsInvalidACK(t *testing.T) {
	h := newDeviceTransferHarness(t)
	deviceTransferEnvironment(t, h.server.URL)
	deviceTestOutput(t)
	path, want := deviceSource(t, 3*chunkSize+17)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	receiverResult := make(chan error, 1)
	var transferID string
	request := sendRequest{files: []string{path}, jsonOutput: true}
	request.deviceConnect = func(callCtx context.Context, invite invitation, _ []byte, expiry int64, _ readyOutput, _ string) (*resumeSession, error) {
		transferID = invite.encodedID()
		local := h.arm(invite, expiry)
		endpoint := "ws" + strings.TrimPrefix(h.server.URL, "http") + "/ws/v2/" + transferID
		go func() {
			socket, _, err := websocket.DefaultDialer.DialContext(callCtx, endpoint, nil)
			if err != nil {
				receiverResult <- err
				return
			}
			defer socket.Close()
			socket.SetReadDeadline(time.Now().Add(3 * time.Second))
			nonce, _ := resumeRandom()
			token, _ := resumeReceiverAdmission(invite)
			proof, _ := resumeNonceProof(invite, "receiver", nonce)
			join := localReceiverJoin{"join", resumeProtocol, "receiver", resumeEncoded(token), resumeEncoded(nonce), resumeEncoded(proof)}
			if err = socket.WriteJSON(join); err != nil {
				receiverResult <- err
				return
			}
			var accepted, paired resumeEvent
			if err = socket.ReadJSON(&accepted); err != nil {
				receiverResult <- err
				return
			}
			if err = socket.ReadJSON(&paired); err != nil {
				receiverResult <- err
				return
			}
			sNonce, err := resumeDecode(paired.SessionNonce, 32)
			if err != nil {
				receiverResult <- err
				return
			}
			seal, _ := newResumeSealer(invite, sNonce, nonce, receiverDirection)
			open, _ := newResumeOpener(invite, sNonce, nonce, senderDirection)
			receiver := &resumeSession{socket: socket, seal: seal, open: open}
			kind, _, err := receiver.next()
			if err != nil || kind != kindOffer {
				receiverResult <- fmt.Errorf("expected offer: %v", err)
				return
			}
			empty := sha256.Sum256(nil)
			accept, _ := json.Marshal(map[string]string{"offset": "0", "prefixSha256": hex.EncodeToString(empty[:])})
			if err = receiver.send(kindAccept, accept); err != nil {
				receiverResult <- err
				return
			}
			var actual []byte
			// Hold every ACK until all four chunks arrive. A per-chunk stop-and-wait
			// sender cannot pass this assertion before the context deadline.
			for range 4 {
				kind, data, err := receiver.next()
				if err != nil || kind != kindChunk {
					receiverResult <- fmt.Errorf("expected pipelined chunk: %v", err)
					return
				}
				actual = append(actual, data...)
			}
			if !bytes.Equal(actual, want) {
				receiverResult <- errors.New("pipelined payload differs")
				return
			}
			receiverResult <- receiver.send(kindAck, encodeCounts(1, uint64(len(want)+1)))
		}()
		select {
		case session := <-local.Sessions:
			return session, nil
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
	}
	err := sendResumable(ctx, request)
	if err == nil || !strings.Contains(err.Error(), "invalid resume progress") {
		t.Fatalf("invalid ACK result: %v", err)
	}
	if err = waitDeviceResult(t, ctx, receiverResult); err != nil {
		t.Fatal(err)
	}
	capability, _ := resumeCapabilityPath(transferID)
	if _, err = os.Stat(capability); err != nil {
		t.Fatal("rejected ACK discarded sender resume state")
	}
}

func TestDeviceTargetedSendValidatesBackgroundRequestsBeforeNetwork(t *testing.T) {
	output := deviceTestOutput(t)
	for _, request := range []sendRequest{{to: "phone", detach: true, jsonOutput: true}, {to: "phone", requestID: "stable", jsonOutput: true}} {
		if code := runDeviceSend(request); code != 1 {
			t.Fatalf("unsupported background option returned %d", code)
		}
	}
	data := deviceOutputBytes(t, output)
	if !bytes.Contains(data, []byte("missing file to send")) || !bytes.Contains(data, []byte("targeted sends do not support --request-id")) {
		t.Fatalf("missing actionable option errors: %s", data)
	}
}

func TestPairedDeviceNames(t *testing.T) {
	existing := []devices.DeviceSummary{{Name: "phone"}, {Name: "Galaxy-S24"}, {Name: "Galaxy-S24-2"}}
	for _, test := range []struct{ model, want string }{
		{"Pixel 9 Pro", "Pixel-9-Pro"}, {"Galaxy S24", "Galaxy-S24-3"}, {"../../", "Android"}, {"", "Android"},
	} {
		if got := pairedDeviceName(test.model, existing); got != test.want {
			t.Errorf("%q: got %q, want %q", test.model, got, test.want)
		}
	}
}
