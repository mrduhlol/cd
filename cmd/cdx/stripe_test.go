package main

import (
	"bytes"
	"context"
	"fmt"
	"github.com/pion/webrtc/v4"
	"reflect"
	"testing"
	"time"
)

func TestStriperStartsAtHalfShare(t *testing.T) {
	s := newStriper()
	if s.share != stripeStartShare {
		t.Fatalf("share = %v, want %v", s.share, stripeStartShare)
	}
	if want := uint64(stripeBudget / 2); s.relayCap != want {
		t.Fatalf("relayCap = %d, want %d", s.relayCap, want)
	}
	if want := uint64(stripeBudget / 2); s.directCap != want {
		t.Fatalf("directCap = %d, want %d", s.directCap, want)
	}
}

func TestStriperSetShareClampsToUnitInterval(t *testing.T) {
	s := newStriper()
	s.setShare(-3)
	if s.share != 0 {
		t.Fatalf("share after setShare(-3) = %v, want 0", s.share)
	}
	s.setShare(7)
	if s.share != 1 {
		t.Fatalf("share after setShare(7) = %v, want 1", s.share)
	}
	s.setShare(0.25)
	if s.share != 0.25 {
		t.Fatalf("share after setShare(0.25) = %v, want 0.25", s.share)
	}
}

func TestStriperCapsStayWithinBounds(t *testing.T) {
	for _, share := range []float64{-1, 0, 0.1, 0.5, 0.9, 1, 2} {
		s := newStriper()
		s.setShare(share)
		if s.relayCap < stripeMinCap {
			t.Errorf("share %v: relayCap = %d, below stripeMinCap %d", share, s.relayCap, stripeMinCap)
		}
		if s.directCap > directBufferHigh {
			t.Errorf("share %v: directCap = %d, above directBufferHigh %d", share, s.directCap, directBufferHigh)
		}
		if s.directCap < stripeMinCap {
			t.Errorf("share %v: directCap = %d, below stripeMinCap %d", share, s.directCap, stripeMinCap)
		}
	}
}

func TestStriperAcknowledgedPrunesRelayRecords(t *testing.T) {
	s := newStriper()
	s.relayUnacked = []stripeItem{
		{record: make([]byte, 100), release: 100},
		{record: make([]byte, 100), release: 200},
		{record: make([]byte, 100), release: 300},
	}
	s.relayBytes = 300

	s.acknowledged(200, 0, time.Unix(0, 0))

	if len(s.relayUnacked) != 1 || s.relayUnacked[0].release != 300 {
		t.Fatalf("relayUnacked releases = %v, want [300]", releasesOf(s.relayUnacked))
	}
	if s.relayBytes != 100 {
		t.Fatalf("relayBytes = %d, want 100", s.relayBytes)
	}
}

func TestStriperAcknowledgedPrunesDirectReleases(t *testing.T) {
	s := newStriper()
	s.directReleases = []uint64{50, 100, 150}

	s.acknowledged(100, 0, time.Unix(0, 0))

	if want := []uint64{150}; !reflect.DeepEqual(s.directReleases, want) {
		t.Fatalf("directReleases = %v, want %v", s.directReleases, want)
	}
}

func TestStriperAdjustStartsEpochThenMovesShare(t *testing.T) {
	const mib = 1 << 20
	s := newStriper()
	t0 := time.Unix(0, 0)

	// The first call only starts the epoch; its bytes are not counted.
	s.acknowledged(1*mib, 0, t0)
	if s.share != 0.5 {
		t.Fatalf("share after first call = %v, want 0.5", s.share)
	}

	// Each step: bytes acknowledged so far, previous acknowledged, time,
	// and the share expected afterwards.
	steps := []struct {
		name      string
		bytes     uint64
		previous  uint64
		at        time.Time
		wantShare float64
		wantStep  float64
	}{
		// Epoch 1 closes at 200 ms with 1 MiB: 5 MiB/s, first rate, so up.
		{"epoch 1 closes", 2 * mib, 1 * mib, t0.Add(200 * time.Millisecond), 0.625, +stripeShareStep},
		// Inside epoch 2, not yet judged.
		{"mid epoch 2", 2*mib + mib/2, 2 * mib, t0.Add(300 * time.Millisecond), 0.625, +stripeShareStep},
		// Epoch 2 closes at 400 ms with 2 MiB total: 10 MiB/s, faster, keep going up.
		{"epoch 2 closes faster", 4 * mib, 2*mib + mib/2, t0.Add(400 * time.Millisecond), 0.75, +stripeShareStep},
		// Epoch 3 closes at 600 ms with 0.5 MiB: 2.5 MiB/s, slower, so turn back.
		{"epoch 3 closes slower", 4*mib + mib/2, 4 * mib, t0.Add(600 * time.Millisecond), 0.625, -stripeShareStep},
		// Epoch 4 closes at 800 ms with 1 MiB: 5 MiB/s, faster, keep going down.
		{"epoch 4 closes faster", 5*mib + mib/2, 4*mib + mib/2, t0.Add(800 * time.Millisecond), 0.5, -stripeShareStep},
	}
	for _, step := range steps {
		s.acknowledged(step.bytes, step.previous, step.at)
		if s.share != step.wantShare {
			t.Fatalf("%s: share = %v, want %v", step.name, s.share, step.wantShare)
		}
		if s.step != step.wantStep {
			t.Fatalf("%s: step = %v, want %v", step.name, s.step, step.wantStep)
		}
	}
}

func TestStriperFailRelayReturnsUnacknowledgedInOrder(t *testing.T) {
	s := newStriper()
	s.setShare(1)
	s.relayUnacked = []stripeItem{
		{record: []byte("a"), release: 10},
		{record: []byte("bb"), release: 20},
		{record: []byte("ccc"), release: 30},
	}
	s.relayBytes = 6

	got := s.failRelay()

	want := [][]byte{[]byte("a"), []byte("bb"), []byte("ccc")}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("failRelay() = %q, want %q", got, want)
	}
	if !s.relayDead {
		t.Fatal("relayDead = false after failRelay")
	}
	if s.directCap != directBufferHigh {
		t.Fatalf("directCap = %d, want directBufferHigh %d", s.directCap, directBufferHigh)
	}
	if again := s.failRelay(); again != nil {
		t.Fatalf("second failRelay() = %q, want nil", again)
	}
}

func TestStriperAcknowledgedAfterRelayFailureKeepsShare(t *testing.T) {
	const mib = 1 << 20
	s := newStriper()
	s.failRelay()
	t0 := time.Unix(0, 0)

	s.acknowledged(1*mib, 0, t0)
	s.acknowledged(2*mib, 1*mib, t0.Add(200*time.Millisecond))
	s.acknowledged(4*mib, 2*mib, t0.Add(400*time.Millisecond))

	if s.share != stripeStartShare {
		t.Fatalf("share after relay failure = %v, want unchanged %v", s.share, stripeStartShare)
	}
}

func TestStriperAcknowledgedSignalsRoomWithoutBlocking(t *testing.T) {
	s := newStriper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		t0 := time.Unix(0, 0)
		for i := range 5 {
			s.acknowledged(uint64(i+1)<<20, uint64(i)<<20, t0.Add(time.Duration(i)*stripeEpoch))
		}
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("acknowledged blocked on relayRoom")
	}
	if n := len(s.relayRoom); n != 1 {
		t.Fatalf("relayRoom holds %d signals, want 1 pending", n)
	}
}

func releasesOf(items []stripeItem) []uint64 {
	var out []uint64
	for _, item := range items {
		out = append(out, item.release)
	}
	return out
}

func TestStripedTransferSurvivesRelayLoss(t *testing.T) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	t.Cleanup(func() { directICEServers = saved })
	sender, receiver, _ := linkedPair(t)
	senderPath, err := newDirectPath(sender.directRecord, sender.directLost)
	if err != nil {
		t.Fatal(err)
	}
	sender.attachDirect(senderPath)
	offer, err := senderPath.createOffer()
	if err != nil {
		t.Fatal(err)
	}
	receiverPath, err := newDirectPath(receiver.directRecord, receiver.directLost)
	if err != nil {
		t.Fatal(err)
	}
	receiver.attachDirect(receiverPath)
	answer, err := receiverPath.answerOffer(offer, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := senderPath.acceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	for _, path := range []*directPath{senderPath, receiverPath} {
		select {
		case <-path.opened:
		case <-time.After(10 * time.Second):
			t.Fatal("local direct path did not open")
		}
	}
	sender.striping = true
	if err := sender.send(kindOffer, []byte("ready")); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := receiver.next(context.Background(), 5*time.Second); err != nil || kind != kindOffer {
		t.Fatalf("direct setup = %v %v", kind, err)
	}
	received := make(chan error, 1)
	go func() {
		for index := range 32 {
			kind, payload, err := receiver.next(context.Background(), 5*time.Second)
			if err != nil {
				received <- err
				return
			}
			if kind != kindChunk || !bytes.Equal(payload, bytes.Repeat([]byte{byte(index)}, chunkSize)) {
				received <- fmt.Errorf("record %d differs", index)
				return
			}
			if index == 7 {
				_ = sender.connection.Close()
			}
		}
		received <- nil
	}()
	for index := range 32 {
		if err := sender.sendReleasable(kindChunk, bytes.Repeat([]byte{byte(index)}, chunkSize), uint64(index+1)*chunkSize); err != nil {
			t.Fatal(err)
		}
		// Poll to observe a relay failure and schedule its held records again.
		if _, _, _, err := sender.poll(); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.After(10 * time.Second)
	for {
		select {
		case err := <-received:
			if err != nil {
				t.Fatal(err)
			}
			return
		case <-deadline:
			t.Fatal("striped transfer stalled after relay loss")
		default:
			if _, _, _, err := sender.poll(); err != nil {
				t.Fatal(err)
			}
			time.Sleep(time.Millisecond)
		}
	}
}
