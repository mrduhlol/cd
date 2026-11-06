package main

import (
	"bytes"
	"context"
	"testing"
	"time"
)

func TestSealIntoReusesStorageAndPreservesWireBytes(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), senderDirection)
	reference, _ := newSealer(testInvitation(), senderDirection)
	opener, _ := newOpener(testInvitation(), senderDirection)
	buffer := make([]byte, 0, maxRecordBytes)
	for _, size := range []int{largeChunkSize, 0, 17, chunkSize, largeChunkSize} {
		payload := bytes.Repeat([]byte{byte(size + 1)}, size)
		record, err := sealer.sealInto(buffer, kindChunk, payload)
		if err != nil {
			t.Fatal(err)
		}
		want, _ := reference.sealInto(nil, kindChunk, payload)
		if !bytes.Equal(record, want) || &record[0] != &buffer[:cap(buffer)][0] {
			t.Fatal("wire bytes changed or buffer was not reused")
		}
		if _, got, err := opener.open(record); err != nil || !bytes.Equal(got, payload) {
			t.Fatalf("invalid plaintext: %v", err)
		}
		buffer = record
	}
}

func TestTCPSendBufferDoesNotOverwriteQueuedRecords(t *testing.T) {
	sender, receiver := laneLinks(t)
	sender.striping = true
	for _, value := range []byte{1, 2, 3} {
		if err := sender.send(kindChunk, bytes.Repeat([]byte{value}, chunkSize)); err != nil {
			t.Fatal(err)
		}
	}
	if sender.stripe != nil {
		t.Fatal("TCP records entered the asynchronous WebRTC striper")
	}
	for _, value := range []byte{1, 2, 3} {
		kind, payload, err := receiver.next(context.Background(), time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(payload, bytes.Repeat([]byte{value}, chunkSize)) {
			t.Fatalf("record %d was overwritten: %v", value, err)
		}
	}
}

func BenchmarkRecordSealStorage(b *testing.B) {
	for _, reuse := range []bool{false, true} {
		name := "allocate"
		if reuse {
			name = "reuse"
		}
		b.Run(name, func(b *testing.B) {
			sealer, _ := newSealer(testInvitation(), senderDirection)
			payload := make([]byte, largeChunkSize)
			var buffer []byte
			b.SetBytes(int64(len(payload)))
			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				record, err := sealer.sealInto(buffer, kindChunk, payload)
				if err != nil {
					b.Fatal(err)
				}
				if reuse {
					buffer = record
				}
			}
		})
	}
}
