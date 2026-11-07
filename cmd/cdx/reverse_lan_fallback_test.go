package main

import (
	"bytes"
	"context"
	"net"
	"sync/atomic"
	"testing"
	"time"
)

func TestReverseLANFallsBackToWorkingForwardListener(t *testing.T) {
	loopbackLane(t)
	t.Setenv("CD_DIRECT", "1")
	t.Setenv("CD_LAN", "1")
	sender, receiver, _ := linkedPair(t)
	forward, err := listenLAN(testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	defer forward.close()
	adopted := make(chan bool, 1)
	go forward.serve(func(stream net.Conn, confirm func() error) bool {
		ok := sender.adoptStreamConfirmed(stream, confirm)
		adopted <- ok
		return ok
	})
	offer := fileOffer{ReverseLAN: true, LAN: &forward.offer}
	reverse, err := prepareReverseLAN(receiver, testInvitation(), offer)
	if err != nil || reverse == nil {
		t.Fatalf("prepare reverse listener: %v", err)
	}
	defer reverse.close()
	// A closed target models a receiver firewall rejecting inbound TCP.
	blocked, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := blocked.Addr().(*net.TCPAddr).Port
	_ = blocked.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	dialReverseLAN(ctx, sender, testInvitation(), &lanOffer{Port: port, Hosts: []string{"127.0.0.1"}})
	reverse.await(ctx, receiver, offer)
	select {
	case ok := <-adopted:
		if !ok {
			t.Fatal("sender rejected forward fallback")
		}
	case <-ctx.Done():
		t.Fatal("sender did not finish adopting forward fallback")
	}
	if sender.direct.Load() == nil || receiver.direct.Load() == nil {
		t.Fatal("failed reverse dial did not fall back to forward TCP")
	}
	if sender.direct.Load().stream == nil || receiver.direct.Load().stream == nil {
		t.Fatal("fallback selected a non-TCP path")
	}
	payload := []byte("authenticated forward fallback")
	if err := sender.send(kindChunk, payload); err != nil {
		t.Fatal(err)
	}
	kind, received, err := receiver.next(ctx, time.Second)
	if err != nil || kind != kindChunk || !bytes.Equal(received, payload) {
		t.Fatalf("forward fallback changed encrypted payload: kind=%d err=%v", kind, err)
	}
	if _, err := dialLAN(ctx, &reverse.lane.offer, testInvitation()); err == nil {
		t.Fatal("reverse listener remained available after forward selection")
	}
}

func TestReverseLANSuccessDoesNotDialForwardListener(t *testing.T) {
	loopbackLane(t)
	t.Setenv("CD_DIRECT", "1")
	t.Setenv("CD_LAN", "1")
	sender, receiver, _ := linkedPair(t)
	forward, err := listenLAN(testInvitation())
	if err != nil {
		t.Fatal(err)
	}
	defer forward.close()
	var forwardConnections atomic.Uint32
	go forward.serve(func(stream net.Conn, confirm func() error) bool {
		forwardConnections.Add(1)
		return sender.adoptStreamConfirmed(stream, confirm)
	})
	offer := fileOffer{ReverseLAN: true, LAN: &forward.offer}
	reverse, err := prepareReverseLAN(receiver, testInvitation(), offer)
	if err != nil || reverse == nil {
		t.Fatalf("prepare reverse listener: %v", err)
	}
	defer reverse.close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	dialReverseLAN(ctx, sender, testInvitation(), &reverse.lane.offer)
	reverse.await(ctx, receiver, offer)
	if !reverse.adopted || sender.direct.Load() == nil || receiver.direct.Load() == nil {
		t.Fatal("working reverse connection was not adopted")
	}
	if forwardConnections.Load() != 0 {
		t.Fatal("working reverse connection also attempted forward TCP")
	}
	payload := []byte("authenticated reverse connection")
	if err := sender.send(kindChunk, payload); err != nil {
		t.Fatal(err)
	}
	kind, received, err := receiver.next(ctx, time.Second)
	if err != nil || kind != kindChunk || !bytes.Equal(received, payload) {
		t.Fatalf("reverse path changed encrypted payload: kind=%d err=%v", kind, err)
	}
}
