package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

// relayPair connects two WebSockets through an in-memory relay that
// forwards binary frames both ways, like a paired TransferRoom.
func relayPair(t *testing.T) (*websocket.Conn, *websocket.Conn, chan int) {
	t.Helper()
	upgrader := websocket.Upgrader{}
	sockets := make(chan *websocket.Conn, 2)
	closeCodes := make(chan int, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		sockets <- connection
	}))
	t.Cleanup(server.Close)
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	left, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	right, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	serverLeft, serverRight := <-sockets, <-sockets
	forward := func(from, to *websocket.Conn) {
		for {
			kind, data, err := from.ReadMessage()
			if err != nil {
				var closeError *websocket.CloseError
				if errors.As(err, &closeError) {
					closeCodes <- closeError.Code
				}
				_ = from.Close()
				return
			}
			_ = to.WriteMessage(kind, data)
		}
	}
	go forward(serverLeft, serverRight)
	go forward(serverRight, serverLeft)
	t.Cleanup(func() { _ = left.Close(); _ = right.Close() })
	return left, right, closeCodes
}

func linkedPair(t *testing.T) (*recordLink, *recordLink, chan int) {
	t.Helper()
	value := testInvitation()
	senderSealer, _ := newSealer(value, senderDirection)
	senderOpener, _ := newOpener(value, receiverDirection)
	receiverSealer, _ := newSealer(value, receiverDirection)
	receiverOpener, _ := newOpener(value, senderDirection)
	left, right, closeCodes := relayPair(t)
	sender := newRecordLink(left, senderSealer, senderOpener, errors.New("receiver left"))
	receiver := newRecordLink(right, receiverSealer, receiverOpener, errors.New("sender left"))
	sender.start()
	receiver.start()
	t.Cleanup(func() { sender.close(); receiver.close() })
	return sender, receiver, closeCodes
}

func TestLinkMergesRecordsFromBothPathsInSequenceOrder(t *testing.T) {
	value := testInvitation()
	sealer, _ := newSealer(value, senderDirection)
	opener, _ := newOpener(value, senderDirection)
	link := &recordLink{opener: opener, items: make(chan linkItem, 8), stop: make(chan struct{}), pending: map[uint32][]byte{}}
	var records [][]byte
	for index := 0; index < 4; index++ {
		record, _ := sealer.sealInto(nil, kindChunk, []byte{byte(index)})
		records = append(records, record)
	}
	// The direct path overtakes the relay: 2 and 3 arrive before 0 and 1.
	link.items <- linkItem{record: records[2], direct: true}
	link.items <- linkItem{record: records[3], direct: true}
	link.items <- linkItem{record: records[0]}
	link.items <- linkItem{record: records[1]}
	for index := 0; index < 4; index++ {
		kind, payload, err := link.next(context.Background(), time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(payload, []byte{byte(index)}) {
			t.Fatalf("record %d = %v %v %v", index, kind, payload, err)
		}
	}
	// A second copy (the same record on the other path) is dropped.
	link.items <- linkItem{record: records[1]}
	if _, _, err := link.next(context.Background(), 50*time.Millisecond); !isTimeoutError(err) {
		t.Fatalf("duplicate copy was delivered: %v", err)
	}
}

func TestLinkPathFailuresOnlyMatterForThePathInUse(t *testing.T) {
	link := &recordLink{items: make(chan linkItem, 2), stop: make(chan struct{}), pending: map[uint32][]byte{}}
	if err := link.accept(linkItem{err: errors.New("ice failed"), direct: true}); err != nil {
		t.Fatalf("an unused direct path failing ended the transfer: %v", err)
	}
	if err := link.accept(linkItem{err: errors.New("peer left")}); err == nil {
		t.Fatal("losing the relay before the direct path carried data was ignored")
	}
	link.directUsed.Store(true)
	if err := link.accept(linkItem{err: errors.New("peer left")}); err != nil {
		t.Fatalf("losing the relay after switching ended the transfer: %v", err)
	}
	if err := link.accept(linkItem{err: errors.New("dc closed"), direct: true}); err == nil {
		t.Fatal("losing the direct path in use was ignored")
	}
}

func TestLinkRelayRoundTripAndFinish(t *testing.T) {
	sender, receiver, closeCodes := linkedPair(t)
	if err := sender.send(kindChunk, []byte("hello")); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := receiver.next(context.Background(), time.Second)
	if err != nil || kind != kindChunk || string(payload) != "hello" {
		t.Fatalf("receiver got %v %q %v", kind, payload, err)
	}
	if err := receiver.send(kindComplete, encodeCounts(1, 5)); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	receiver.finish(true)
	if time.Since(started) > time.Second {
		t.Fatal("finish waited although the relay answered the close")
	}
	if kind, _, err := sender.next(context.Background(), time.Second); err != nil || kind != kindComplete {
		t.Fatalf("sender lost COMPLETE sent right before finish: %v %v", kind, err)
	}
	select {
	case code := <-closeCodes:
		if code != websocket.CloseNormalClosure {
			t.Fatalf("close code = %d, want 1000", code)
		}
	case <-time.After(time.Second):
		t.Fatal("relay never saw a close frame")
	}
}

// TestDirectPathCarriesRecordsBetweenTwoPeers negotiates a real pion data
// channel in-process (no STUN) and moves a multi-piece record over it.
func TestDirectPathCarriesRecordsBetweenTwoPeers(t *testing.T) {
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
			t.Skip("no usable network interface for a local WebRTC connection")
		}
	}
	big := bytes.Repeat([]byte{7}, 200*1024) // spans several 64 KiB messages
	if err := sender.send(kindChunk, big); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := receiver.next(context.Background(), 5*time.Second)
	if err != nil || kind != kindChunk || !bytes.Equal(payload, big) {
		t.Fatalf("direct record = %v (%d bytes) %v", kind, len(payload), err)
	}
	if !sender.directUsed.Load() || !receiver.directUsed.Load() {
		t.Fatal("record did not travel over the direct path")
	}
	if err := receiver.send(kindAck, encodeCounts(1, uint64(len(big)))); err != nil {
		t.Fatal(err)
	}
	if kind, _, err := sender.next(context.Background(), 5*time.Second); err != nil || kind != kindAck {
		t.Fatalf("ack over direct path = %v %v", kind, err)
	}
}

func TestRecordAssemblerRejectsGarbageAndSplitsRecords(t *testing.T) {
	value := testInvitation()
	sealer, _ := newSealer(value, senderDirection)
	first, _ := sealer.sealInto(nil, kindChunk, bytes.Repeat([]byte{1}, 100_000))
	second, _ := sealer.sealInto(nil, kindEnd, encodeCounts(1, 100_000))
	stream := append(append([]byte{}, first...), second...)
	var assembler recordAssembler
	var records [][]byte
	for start := 0; start < len(stream); start += 7_000 {
		got, err := assembler.push(stream[start:min(start+7_000, len(stream))])
		if err != nil {
			t.Fatal(err)
		}
		records = append(records, got...)
	}
	if len(records) != 2 || !bytes.Equal(records[0], first) || !bytes.Equal(records[1], second) {
		t.Fatalf("reassembled %d records", len(records))
	}
	if _, err := (&recordAssembler{}).push([]byte("not a record at all")); err == nil {
		t.Fatal("accepted garbage")
	}
}

// TestLinkResendsRelayRecordsWhenTheDirectPathOpens covers the switch:
// records sent on the relay while the direct path was negotiating go out
// again on it, and the receiver keeps exactly one copy of each.
func TestLinkResendsRelayRecordsWhenTheDirectPathOpens(t *testing.T) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	t.Cleanup(func() { directICEServers = saved })
	sender, receiver, _ := linkedPair(t)
	senderPath, _ := newDirectPath(sender.directRecord, sender.directLost)
	sender.attachDirect(senderPath)
	for index := range 3 {
		if err := sender.sendReleasable(kindChunk, []byte{byte(index)}, uint64(index+1)); err != nil {
			t.Fatal(err)
		}
	}
	sender.acknowledged(1) // the receiver confirmed the first chunk
	if len(sender.retained) != 2 {
		t.Fatalf("retained %d records, want the 2 unacknowledged ones", len(sender.retained))
	}
	offer, _ := senderPath.createOffer()
	receiverPath, _ := newDirectPath(receiver.directRecord, receiver.directLost)
	receiver.attachDirect(receiverPath)
	answer, _ := receiverPath.answerOffer(offer, nil)
	if err := senderPath.acceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-senderPath.opened:
	case <-time.After(10 * time.Second):
		t.Skip("no usable network interface for a local WebRTC connection")
	}
	if err := sender.sendReleasable(kindChunk, []byte{3}, 4); err != nil {
		t.Fatal(err)
	}
	if len(sender.retained) != 0 || !sender.switched {
		t.Fatal("retained records were not flushed onto the direct path")
	}
	for index := range 4 {
		kind, payload, err := receiver.next(context.Background(), 5*time.Second)
		if err != nil || kind != kindChunk || !bytes.Equal(payload, []byte{byte(index)}) {
			t.Fatalf("record %d = %v %v %v", index, kind, payload, err)
		}
	}
	if _, _, err := receiver.next(context.Background(), 200*time.Millisecond); !isTimeoutError(err) {
		t.Fatalf("a duplicate reached the receiver: %v", err)
	}
}

// TestDirectPathConnectsWithTrickledCandidates answers without waiting for
// gathering and delivers candidates one by one, as receivers do.
func TestDirectPathConnectsWithTrickledCandidates(t *testing.T) {
	saved := directICEServers
	directICEServers = []webrtc.ICEServer{}
	t.Cleanup(func() { directICEServers = saved })
	sender, receiver, _ := linkedPair(t)
	senderPath, _ := newDirectPath(sender.directRecord, sender.directLost)
	sender.attachDirect(senderPath)
	offer, _ := senderPath.createOffer()
	receiverPath, _ := newDirectPath(receiver.directRecord, receiver.directLost)
	receiver.attachDirect(receiverPath)
	trickled := make(chan webrtc.ICECandidateInit, 16)
	answer, err := receiverPath.answerOffer(offer, func(candidate webrtc.ICECandidateInit) { trickled <- candidate })
	if err != nil {
		t.Fatal(err)
	}
	if err := senderPath.acceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	go func() {
		for candidate := range trickled {
			_ = senderPath.addCandidate(candidate)
		}
	}()
	select {
	case <-senderPath.opened:
	case <-time.After(10 * time.Second):
		t.Skip("no usable network interface for a local WebRTC connection")
	}
	if err := sender.send(kindChunk, []byte("trickled candidates")); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := receiver.next(context.Background(), 5*time.Second)
	if err != nil || kind != kindChunk || !bytes.Equal(payload, []byte("trickled candidates")) {
		t.Fatalf("trickled transfer = %v %q %v", kind, payload, err)
	}
	if !sender.directUsed.Load() || !receiver.directUsed.Load() {
		t.Fatal("trickled transfer did not use the direct path at both ends")
	}
}

// TestPeerLeftRightAfterCompleteIsNotAFailure reproduces production: the
// relay forwards COMPLETE and then peer-left back to back.
func TestPeerLeftRightAfterCompleteIsNotAFailure(t *testing.T) {
	value := testInvitation()
	receiverSealer, _ := newSealer(value, receiverDirection)
	senderOpener, _ := newOpener(value, receiverDirection)
	link := &recordLink{opener: senderOpener, items: make(chan linkItem, 8), stop: make(chan struct{}), pending: map[uint32][]byte{}}
	complete, _ := receiverSealer.sealInto(nil, kindComplete, encodeCounts(0, 0))
	link.items <- linkItem{record: complete}
	link.items <- linkItem{err: errors.New("receiver disconnected")}
	progress := &senderProgress{ended: true}
	for !progress.completed {
		kind, payload, ok, err := link.poll()
		if err != nil || !ok {
			t.Fatalf("poll before COMPLETE = %v %v", ok, err)
		}
		if err := progress.handle(kind, payload); err != nil {
			t.Fatal(err)
		}
	}
}

func TestRecordLinkBoundsHeldBytes(t *testing.T) {
	link := &recordLink{pending: map[uint32][]byte{}}
	for sequence := uint32(1); sequence <= 32; sequence++ {
		record := make([]byte, maxRecordBytes)
		binary.BigEndian.PutUint32(record[4:8], sequence)
		if err := link.accept(linkItem{record: record}); err != nil {
			t.Fatal(err)
		}
	}
	record := make([]byte, headerBytes)
	binary.BigEndian.PutUint32(record[4:8], 33)
	if err := link.accept(linkItem{record: record}); err == nil {
		t.Fatal("accepted more than 32 MiB while sequence 0 is missing")
	}
}

func TestLinkClearsAdmissionReadDeadline(t *testing.T) {
	value := testInvitation()
	senderSealer, _ := newSealer(value, senderDirection)
	senderOpener, _ := newOpener(value, receiverDirection)
	receiverSealer, _ := newSealer(value, receiverDirection)
	receiverOpener, _ := newOpener(value, senderDirection)
	left, right, _ := relayPair(t)
	_ = left.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	_ = right.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	sender := newRecordLink(left, senderSealer, senderOpener, errors.New("receiver left"))
	receiver := newRecordLink(right, receiverSealer, receiverOpener, errors.New("sender left"))
	sender.start()
	receiver.start()
	defer sender.close()
	defer receiver.close()
	time.Sleep(100 * time.Millisecond)
	if err := sender.send(kindChunk, []byte("after admission deadline")); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := receiver.next(context.Background(), time.Second)
	if err != nil || kind != kindChunk || string(payload) != "after admission deadline" {
		t.Fatalf("delayed record = %v %q %v", kind, payload, err)
	}
}
