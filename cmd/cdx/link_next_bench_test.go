package main

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestLinkNextCancellationPrecedesAvailableRecords(t *testing.T) {
	for _, placement := range []string{"queued", "ready"} {
		t.Run(placement, func(t *testing.T) {
			sealer, _ := newSealer(testInvitation(), receiverDirection)
			opener, _ := newOpener(testInvitation(), receiverDirection)
			record, err := sealer.sealInto(nil, kindAccept, nil)
			if err != nil {
				t.Fatal(err)
			}
			link := &recordLink{opener: opener, items: make(chan linkItem, 1), pending: map[uint32][]byte{}}
			if placement == "queued" {
				link.items <- linkItem{record: record}
			} else {
				link.pending[0] = record
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			kind, payload, err := link.next(ctx, time.Second)
			if !errors.Is(err, context.Canceled) || kind != 0 || payload != nil {
				t.Fatalf("canceled read = %v, %v, %v", kind, payload, err)
			}
			if link.expected != 0 || opener.sequence != 0 || len(link.items)+len(link.pending) != 1 {
				t.Fatal("canceled read consumed an available record")
			}
		})
	}
}

func TestLinkNextDeliversReadyRecordBeforeQueuedError(t *testing.T) {
	sealer, _ := newSealer(testInvitation(), receiverDirection)
	opener, _ := newOpener(testInvitation(), receiverDirection)
	record, err := sealer.sealInto(nil, kindAccept, nil)
	if err != nil {
		t.Fatal(err)
	}
	link := &recordLink{opener: opener, items: make(chan linkItem, 1), pending: map[uint32][]byte{0: record}}
	wantErr := errors.New("peer closed")
	link.items <- linkItem{err: wantErr}
	if kind, _, err := link.next(context.Background(), time.Second); err != nil || kind != kindAccept {
		t.Fatalf("ready ACCEPT = %v, %v", kind, err)
	}
	if _, _, err := link.next(context.Background(), time.Second); err != wantErr {
		t.Fatalf("queued error = %v, want %v", err, wantErr)
	}
}

func BenchmarkLinkNextQueued(b *testing.B) {
	sealer, _ := newSealer(testInvitation(), receiverDirection)
	opener, _ := newOpener(testInvitation(), receiverDirection)
	record, err := sealer.sealInto(nil, kindAccept, nil)
	if err != nil {
		b.Fatal(err)
	}
	link := &recordLink{opener: opener, items: make(chan linkItem, 1), pending: map[uint32][]byte{}}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		link.expected = 0
		opener.sequence = 0
		link.items <- linkItem{record: record}
		kind, payload, err := link.next(context.Background(), time.Second)
		if err != nil || kind != kindAccept || len(payload) != 0 {
			b.Fatalf("queued ACCEPT = %v %v %v", kind, payload, err)
		}
	}
}
