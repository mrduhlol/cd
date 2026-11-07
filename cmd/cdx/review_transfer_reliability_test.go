package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

func reliabilityDirectPair(t *testing.T, onSenderRecord func([]byte)) (*recordLink, *recordLink) {
	t.Helper()
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	t.Cleanup(func() { directICEServers = saved })
	sender, receiver, _ := linkedPair(t)
	sp, err := newDirectPath(func(record []byte) {
		sender.directRecord(record)
		if onSenderRecord != nil {
			onSenderRecord(record)
		}
	}, sender.directLost)
	if err != nil {
		t.Fatal(err)
	}
	sender.attachDirect(sp)
	offer, err := sp.createOffer()
	if err != nil {
		t.Fatal(err)
	}
	rp, err := newDirectPath(receiver.directRecord, receiver.directLost)
	if err != nil {
		t.Fatal(err)
	}
	receiver.attachDirect(rp)
	answer, err := rp.answerOffer(offer, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := sp.acceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	for _, path := range []*directPath{sp, rp} {
		select {
		case <-path.opened:
		case <-time.After(5 * time.Second):
			t.Fatal("direct path did not open")
		}
	}
	sender.striping = true
	return sender, receiver
}

type reliabilityReader struct {
	reads  int
	total  int
	ack    chan struct{}
	cancel context.CancelFunc
}

func (r *reliabilityReader) Read(p []byte) (int, error) {
	if r.reads == r.total {
		return 0, io.EOF
	}
	if r.reads > 0 {
		select {
		case <-r.ack:
		case <-time.After(3 * time.Second):
			return 0, fmt.Errorf("receiver stopped acknowledging")
		}
	} else {
		r.cancel()
	}
	for i := range p {
		p[i] = byte(r.reads)
	}
	r.reads++
	return len(p), nil
}

func TestReliabilityCancelledDirectTransferStopsReadingSource(t *testing.T) {
	acks := make(chan struct{}, 128)
	sender, receiver := reliabilityDirectPair(t, func(record []byte) {
		if messageKind(record[3]) == kindAck {
			acks <- struct{}{}
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// sendFile uses this exact cancellation action on its relay socket.
	stop := context.AfterFunc(ctx, func() { _ = sender.connection.Close() })
	defer stop()
	received := make(chan error, 1)
	go func() {
		kind, _, err := receiver.next(context.Background(), 3*time.Second)
		if err != nil || kind != kindOffer {
			received <- fmt.Errorf("offer: %v %v", kind, err)
			return
		}
		if err := receiver.send(kindAccept, nil); err != nil {
			received <- err
			return
		}
		var chunks uint32
		var count uint64
		for {
			kind, payload, err := receiver.next(context.Background(), 3*time.Second)
			if err != nil {
				received <- err
				return
			}
			if kind == kindEnd {
				received <- receiver.send(kindComplete, payload)
				return
			}
			if kind != kindChunk {
				received <- fmt.Errorf("unexpected kind %v", kind)
				return
			}
			chunks++
			count += uint64(len(payload))
			if err := receiver.send(kindAck, encodeCounts(chunks, count)); err != nil {
				received <- err
				return
			}
		}
	}()
	source := &reliabilityReader{total: 64, ack: acks, cancel: cancel}
	err := transfer(ctx, sender, source, readyOutput{Filename: "cancel.bin", Size: 64 * chunkSize}, nil, sendHooks{})
	t.Logf("cancelled in first Read: source_reads=%d bytes=%d transfer_error=%v", source.reads, source.reads*chunkSize, err)
	if source.reads > 2 {
		t.Errorf("continued consuming source after cancellation: %d chunks", source.reads)
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("error = %v, want context.Canceled", err)
	}
	select {
	case <-sender.direct.Load().lost:
	case <-time.After(time.Second):
		t.Error("cancelled transfer left the direct connection open")
	}
}

func TestReliabilityRetryCopiesMergeWithoutChangingBytes(t *testing.T) {
	sender, receiver := reliabilityDirectPair(t, nil)
	const count = 48
	done := make(chan error, 1)
	go func() {
		for i := range count {
			want := bytes.Repeat([]byte{byte(i)}, chunkSize)
			kind, payload, err := receiver.next(context.Background(), 5*time.Second)
			if err != nil || kind != kindChunk || !bytes.Equal(payload, want) {
				done <- fmt.Errorf("chunk %d: kind=%v bytes=%d err=%v", i, kind, len(payload), err)
				return
			}
		}
		done <- nil
	}()
	for i := range count {
		want := bytes.Repeat([]byte{byte(i)}, chunkSize)
		if err := sender.sendReleasable(kindChunk, want, uint64(i+1)*chunkSize); err != nil {
			t.Fatal(err)
		}
	}
	// Replay held relay copies even though their originals can still arrive.
	// failRelay is idempotent; a simultaneous read/write failure must not enqueue twice.
	sender.relayFailed()
	sender.relayFailed()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, _, err := receiver.next(context.Background(), 100*time.Millisecond); !isTimeoutError(err) {
		t.Fatalf("extra delivery after duplicate replays: %v", err)
	}
}

func TestReliabilityReceiveFailureNeverPublishes(t *testing.T) {
	for _, failure := range []string{"short-end", "corrupted-record", "disconnect", "cancel"} {
		t.Run(failure, func(t *testing.T) {
			inv := testReceiveInvitation()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			upgrader := websocket.Upgrader{}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer conn.Close()
				_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				var join map[string]string
				if conn.ReadJSON(&join) != nil {
					return
				}
				_ = conn.WriteJSON(map[string]string{"type": "accepted", "protocol": "cd-transfer-v1"})
				seal, _ := newSealer(inv, senderDirection)
				send := func(kind messageKind, payload []byte, corrupt bool) {
					record, err := seal.sealInto(nil, kind, payload)
					if err != nil {
						return
					}
					if corrupt {
						record[len(record)-1] ^= 1
					}
					_ = conn.WriteMessage(websocket.BinaryMessage, record)
				}
				offer, _ := json.Marshal(fileOffer{Name: "failure.bin", MediaType: "application/octet-stream", Size: "6", ChunkSize: chunkSize})
				send(kindOffer, offer, false)
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
				send(kindChunk, []byte("abc"), failure == "corrupted-record")
				if failure == "disconnect" {
					return
				}
				if failure == "cancel" {
					cancel()
				} else {
					send(kindEnd, encodeCounts(1, 6), false)
				}
				for {
					if _, _, err := conn.ReadMessage(); err != nil {
						return
					}
				}
			}))
			defer server.Close()
			t.Setenv("CD_RELAY_URL", "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/v1")
			t.Setenv("CD_PUBLIC_URL", server.URL)
			t.Setenv("CD_DIRECT", "0")
			dir := t.TempDir()
			out := filepath.Join(dir, "failure.bin")
			completed := false
			err := receiveFile(ctx, inv.encodedID()+"#v1."+inv.encodedKey(), out, false, func(receiveResult) error { completed = true; return nil })
			if err == nil || completed {
				t.Fatalf("invalid receive reported success: %v", err)
			}
			if failure == "cancel" && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel error = %v", err)
			}
			if failure == "short-end" && !strings.Contains(err.Error(), "before the complete file arrived") {
				t.Fatalf("did not reach truncation check: %v", err)
			}
			if failure == "corrupted-record" && !strings.Contains(err.Error(), "authentication") {
				t.Fatalf("did not reach authentication check: %v", err)
			}
			if failure == "disconnect" && classifyFailure(err) != failureDisconnected {
				t.Fatalf("did not reach disconnect check: %v", err)
			}
			entries, readErr := os.ReadDir(dir)
			if readErr != nil || len(entries) != 0 {
				t.Fatalf("failed receive left files: %v %v", entries, readErr)
			}
			t.Logf("rejected %s; no final/staging file: %v", failure, err)
		})
	}
}
