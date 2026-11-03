package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"testing"
	"time"
)

func reverseTestOffer() fileOffer {
	return fileOffer{ReverseLAN: true, LAN: &lanOffer{Port: 4000, Hosts: []string{"127.0.0.1"}}}
}

func TestReverseLANAcceptanceRequiresAdvertisedCapability(t *testing.T) {
	loopbackLane(t)
	payload := []byte(`{"lan":{"port":4000,"hosts":["127.0.0.1"]}}`)
	if _, err := acceptedTransfer(payload, 0, false, ""); err == nil {
		t.Fatal("accepted reverse listener without advertised capability")
	}
	selection, err := acceptedTransfer(payload, 0, true, "")
	if err != nil || selection.ChunkSize != chunkSize || selection.LAN == nil {
		t.Fatalf("selection=%+v,%v", selection, err)
	}
	for _, invalid := range []string{
		`{"lan":{"port":22,"hosts":["127.0.0.1"]}}`,
		`{"lan":{"port":4000,"hosts":["8.8.8.8"]}}`,
		`{"chunkSize":1048576,"lan":{"port":4000,"hosts":["127.0.0.1"]}}`,
		`{"lan":{"port":4000,"hosts":["localhost"]}}`,
	} {
		if _, err := acceptedTransfer([]byte(invalid), largeChunkSize, true, ""); err == nil {
			t.Fatalf("accepted %s", invalid)
		}
	}
	// Older receivers send their unchanged empty acceptance, even when a
	// newer sender advertises reverse support.
	selection, err = acceptedTransfer(nil, largeChunkSize, true, "")
	if err != nil || selection.LAN != nil || selection.ChunkSize != chunkSize {
		t.Fatalf("legacy acceptance=%+v,%v", selection, err)
	}
}

func TestReverseLANIsCapabilityGatedAndListenerFailureFallsBack(t *testing.T) {
	loopbackLane(t)
	sender, _, _ := linkedPair(t)
	reverse, err := prepareReverseLAN(sender, testInvitation(), fileOffer{})
	if err != nil || reverse != nil {
		t.Fatal("started reverse listener for old sender")
	}
	t.Setenv("CD_LAN", "0")
	reverse, err = prepareReverseLAN(sender, testInvitation(), reverseTestOffer())
	if err != nil || reverse != nil {
		t.Fatal("started disabled reverse listener")
	}
	t.Setenv("CD_LAN", "1")
	saved := lanInterfaceAddrs
	calls := 0
	lanInterfaceAddrs = func() ([]net.Addr, error) {
		calls++
		if calls == 1 {
			return []net.Addr{&net.IPNet{IP: net.ParseIP("127.0.0.1"), Mask: net.CIDRMask(8, 32)}}, nil
		}
		return nil, nil
	}
	defer func() { lanInterfaceAddrs = saved }()
	reverse, err = prepareReverseLAN(sender, testInvitation(), reverseTestOffer())
	if err == nil || reverse != nil {
		t.Fatal("listener failure did not leave forward/WebRTC fallback available")
	}
}

func TestReverseLANTransfersEncryptedRecords(t *testing.T) {
	loopbackLane(t)
	t.Setenv("CD_LAN", "1")
	t.Setenv("CD_DIRECT", "1")
	t.Setenv("CD_LARGE_RECORDS", "1")
	t.Setenv("CD_LAN_GRACE", "1")
	sender, receiver, _ := linkedPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sender.lanOffer = reverseTestOffer().LAN
	sender.reverseLAN = func(offer *lanOffer) <-chan struct{} {
		connected := make(chan struct{})
		go func() {
			defer close(connected)
			time.Sleep(10 * time.Millisecond)
			dialReverseLAN(ctx, sender, testInvitation(), offer)
		}()
		return connected
	}
	original := bytes.Repeat([]byte("reverse-lane"), 8*1024*1024/12+19)
	reader := bytes.NewReader(original)
	done := make(chan error, 1)
	go func() {
		done <- transfer(ctx, sender, reader, readyOutput{Filename: "reverse.bin", Size: uint64(len(original))}, nil, sendHooks{})
	}()
	kind, payload, err := receiver.next(ctx, time.Second)
	if err != nil || kind != kindOffer {
		t.Fatalf("offer=%d,%v", kind, err)
	}
	offerRelayBytes := uint64(headerBytes + len(payload) + recordTagBytes)
	offer, size, err := parseReceivedOffer(payload)
	if err != nil || !offer.ReverseLAN {
		t.Fatalf("reverse capability missing: %+v,%v", offer, err)
	}
	reverse, err := prepareReverseLAN(receiver, testInvitation(), offer)
	if err != nil || reverse == nil {
		t.Fatalf("listener=%v", err)
	}
	defer reverse.close()
	selected, _ := receiveChunkSelection(offer)
	acceptance, _ := json.Marshal(chunkAcceptance{ChunkSize: selected, LAN: &reverse.lane.offer})
	if err := receiver.send(kindAccept, acceptance); err != nil {
		t.Fatal(err)
	}
	go reverse.await(ctx, receiver, offer)
	select {
	case <-reverse.ready:
	case <-ctx.Done():
		t.Fatal("receiver reverse path did not open")
	}
	deadline := time.Now().Add(time.Second)
	for sender.direct.Load() == nil {
		if time.Now().After(deadline) {
			t.Fatal("sender reverse path did not open")
		}
		time.Sleep(time.Millisecond)
	}
	if sender.direct.Load().stream == nil || receiver.direct.Load().stream == nil {
		t.Fatal("reverse transfer did not select TCP")
	}
	var received bytes.Buffer
	var chunks uint32
	for {
		kind, payload, err = receiver.next(ctx, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if kind == kindEnd {
			break
		}
		if kind != kindChunk {
			t.Fatalf("unexpected kind %d", kind)
		}
		if err := validateReceivedChunk(payload, selected, uint64(received.Len()), size); err != nil {
			t.Fatal(err)
		}
		received.Write(payload)
		chunks++
		if err := receiver.send(kindAck, encodeCounts(chunks, uint64(received.Len()))); err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(received.Bytes(), original) {
		t.Fatal("reverse encrypted transfer changed payload")
	}
	endChunks, endBytes, err := decodeCounts(payload)
	if err != nil || endChunks != chunks || endBytes != size {
		t.Fatal("reverse transfer end counts differ")
	}
	if err := receiver.send(kindComplete, encodeCounts(chunks, size)); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if sender.directBytes.Load() == 0 || receiver.directBytes.Load() == 0 {
		t.Fatal("records did not cross reverse TCP in both directions")
	}
	if sender.relayBytes.Load() != offerRelayBytes {
		t.Fatal("quick reverse connection sent bulk data on the relay")
	}
}

func TestReverseLANClosePreventsLateAdoption(t *testing.T) {
	loopbackLane(t)
	sender, _, _ := linkedPair(t)
	reverse, err := prepareReverseLAN(sender, testInvitation(), reverseTestOffer())
	if err != nil {
		t.Fatal(err)
	}
	reverse.close()
	if _, err := dialLAN(context.Background(), &reverse.lane.offer, testInvitation()); err == nil {
		t.Fatal("closed reverse listener accepted a peer")
	}
	if sender.direct.Load() != nil {
		t.Fatal("closed reverse listener attached a path")
	}
}

func TestReverseLANLinkCancellationStopsListener(t *testing.T) {
	loopbackLane(t)
	sender, _, _ := linkedPair(t)
	reverse, err := prepareReverseLAN(sender, testInvitation(), reverseTestOffer())
	if err != nil {
		t.Fatal(err)
	}
	defer reverse.close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		reverse.await(context.Background(), sender, fileOffer{Direct: &directOffer{SDP: "unused"}})
	}()
	sender.close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("reverse setup survived link close")
	}
	if _, err := dialLAN(context.Background(), &reverse.lane.offer, testInvitation()); err == nil {
		t.Fatal("canceled reverse listener remained open")
	}
	if sender.direct.Load() != nil {
		t.Fatal("canceled reverse setup attached fallback")
	}
}

func TestReverseLANConcurrentConnectionsSelectOneSharedPath(t *testing.T) {
	loopbackLane(t)
	for iteration := range 25 {
		sender, receiver, _ := linkedPair(t)
		reverse, err := prepareReverseLAN(receiver, testInvitation(), reverseTestOffer())
		if err != nil {
			t.Fatal(err)
		}
		// Two simultaneous connections to the offered listener must agree on
		// the same authenticated winner before either peer reads records.
		offer := reverse.lane.offer
		offer.Hosts = append(append([]string{}, offer.Hosts...), offer.Hosts...)
		stream, err := dialLAN(context.Background(), &offer, testInvitation())
		if err != nil {
			reverse.close()
			t.Fatalf("iteration %d: %v", iteration, err)
		}
		if !sender.adoptStream(stream) {
			_ = stream.Close()
			reverse.close()
			t.Fatal("sender rejected selected reverse stream")
		}
		payload := []byte("one shared reverse path")
		if err := sender.send(kindChunk, payload); err != nil {
			t.Fatal(err)
		}
		kind, received, err := receiver.next(context.Background(), time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(received, payload) {
			t.Fatalf("iteration %d mismatched paths: %v %v", iteration, kind, err)
		}
		reverse.close()
		sender.close()
		receiver.close()
	}
}

func TestReverseLANDoesNotDelayUnsharedInternetNetworks(t *testing.T) {
	loopbackLane(t)
	sender, _, _ := linkedPair(t)
	for _, offer := range []fileOffer{
		{ReverseLAN: true},
		{ReverseLAN: true, LAN: &lanOffer{Port: 4000, Hosts: []string{"10.24.0.8"}}},
	} {
		reverse, err := prepareReverseLAN(sender, testInvitation(), offer)
		if err != nil || reverse != nil {
			t.Fatalf("unshared network started reverse listener: %v", err)
		}
	}
	if sender.direct.Load() != nil {
		t.Fatal("unshared reverse offer attached a path")
	}
}
