package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestRelaySendReusesUnretainedStorage(t *testing.T) {
	sender, receiver, _ := linkedPair(t)
	var previous []byte
	for _, value := range []byte{1, 2, 3} {
		want := bytes.Repeat([]byte{value}, chunkSize)
		if err := sender.send(kindChunk, want); err != nil {
			t.Fatal(err)
		}
		if len(sender.sendBuffer) == 0 {
			t.Fatal("relay send discarded reusable storage")
		}
		if previous != nil && &previous[0] != &sender.sendBuffer[0] {
			t.Fatal("relay send allocated new storage")
		}
		previous = sender.sendBuffer
		kind, got, err := receiver.next(context.Background(), time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(got, want) {
			t.Fatalf("relay payload corrupted: %v", err)
		}
	}
}

func TestRelaySendPreservesRecordsWhileDirectNegotiates(t *testing.T) {
	sender, receiver, _ := linkedPair(t)
	sender.direct.Store(&directPath{opened: make(chan struct{}), lost: make(chan struct{})})
	defer sender.direct.Store(nil)
	for _, value := range []byte{1, 2, 3} {
		want := bytes.Repeat([]byte{value}, chunkSize)
		if err := sender.send(kindChunk, want); err != nil {
			t.Fatal(err)
		}
		if _, got, err := receiver.next(context.Background(), time.Second); err != nil || !bytes.Equal(got, want) {
			t.Fatalf("relay delivery: %v", err)
		}
	}
	opener, _ := newOpener(testInvitation(), senderDirection)
	if len(sender.retained) != 3 {
		t.Fatalf("retained %d records", len(sender.retained))
	}
	for i, entry := range sender.retained {
		_, got, err := opener.open(entry.record)
		if err != nil || !bytes.Equal(got, bytes.Repeat([]byte{byte(i + 1)}, chunkSize)) {
			t.Fatalf("retained record corrupted: %v", err)
		}
	}
}

func BenchmarkRelaySend(b *testing.B) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			_, reader, err := conn.NextReader()
			if err != nil {
				return
			}
			if _, err := io.Copy(io.Discard, reader); err != nil {
				return
			}
		}
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		b.Fatal(err)
	}
	defer conn.Close()
	sealer, _ := newSealer(testInvitation(), senderDirection)
	link := &recordLink{connection: conn, sealer: sealer}
	payload := make([]byte, largeChunkSize)
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		if err := link.send(kindChunk, payload); err != nil {
			b.Fatal(err)
		}
	}
}
