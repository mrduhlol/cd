package devices

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func localServer(t *testing.T) (Pair, *Server, string) {
	t.Helper()
	p := testPair(t)
	server, err := NewServer(p)
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server)
	t.Cleanup(func() { server.Close(); httpServer.Close() })
	return p, server, "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws/devices/v1/" + p.PairID
}
func nextEvent(t *testing.T, p *Peer, expected string) {
	t.Helper()
	select {
	case event, ok := <-p.Events:
		if !ok || event.Type != expected || event.Protocol != Protocol {
			t.Fatalf("expected %s, got %+v, open %v", expected, event, ok)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("event %s timed out", expected)
	}
}
func TestLocalAuthenticatedControlRoundTripAndLifecycle(t *testing.T) {
	p, server, endpoint := localServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sender, err := DialLocal(ctx, endpoint, p, Sender)
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	nextEvent(t, sender, "accepted")
	receiver, err := DialLocal(ctx, endpoint, p, Receiver)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	nextEvent(t, receiver, "accepted")
	nextEvent(t, receiver, "peer-joined")
	nextEvent(t, sender, "peer-joined")
	if err = receiver.Send(Message{Type: "paired", Name: "S24 Ultra"}); err != nil {
		t.Fatal(err)
	}
	got, err := sender.Receive(ctx)
	if err != nil || got.Name != "S24 Ultra" {
		t.Fatalf("pair handshake: %+v %v", got, err)
	}
	offer := testOffer(t)
	if err = sender.Send(offer); err != nil {
		t.Fatal(err)
	}
	got, err = receiver.Receive(ctx)
	if err != nil || got.Filename != "video.mp4" || got.TransferID != offer.TransferID {
		t.Fatalf("offer receive: %+v %v", got, err)
	}
	if err = receiver.Send(Message{Type: "received", TransferID: offer.TransferID}); err != nil {
		t.Fatal(err)
	}
	got, err = sender.Receive(ctx)
	if err != nil || got.Type != "received" {
		t.Fatalf("receipt: %+v %v", got, err)
	}
	receiver.Close()
	nextEvent(t, sender, "peer-left")
	// The disconnection event is emitted after role removal, so this reconnect
	// proves no stale authenticated socket survives the lifecycle.
	receiver, err = DialLocal(ctx, endpoint, p, Receiver)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	nextEvent(t, receiver, "accepted")
	nextEvent(t, receiver, "peer-joined")
	nextEvent(t, sender, "peer-joined")
	server.Close()
	if _, err = sender.Receive(ctx); err == nil {
		t.Fatal("server close did not close peer")
	}
	if _, err = DialLocal(ctx, endpoint, p, Sender); err == nil {
		t.Fatal("closed server accepted peer")
	}
}
func TestLocalAdmissionRejectsWrongTokenAndActiveRoleReplacement(t *testing.T) {
	p, _, endpoint := localServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sender, err := DialLocal(ctx, endpoint, p, Sender)
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	nextEvent(t, sender, "accepted")
	if duplicate, err := DialLocal(ctx, endpoint, p, Sender); err == nil {
		duplicate.Close()
		t.Fatal("active sender replaced")
	}
	wrong := p
	wrong.Secret = testPair(t).Secret
	if impostor, err := DialLocal(ctx, endpoint, wrong, Receiver); err == nil {
		impostor.Close()
		t.Fatal("wrong secret authorized by device name/id")
	}
	raw, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	readLocalChallenge(t, raw)
	join, _ := p.Join(Sender)
	join.ReceiverTokenHash = "tampered"
	raw.WriteJSON(join)
	raw.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err = raw.ReadMessage(); err == nil {
		t.Fatal("wrong registration hash accepted")
	}
	raw.Close()
	receiver, err := DialLocal(ctx, endpoint, p, Receiver)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	nextEvent(t, receiver, "accepted")
	nextEvent(t, receiver, "peer-joined")
	nextEvent(t, sender, "peer-joined")
	if err = sender.Send(testOffer(t)); err != nil {
		t.Fatal(err)
	}
	if _, err = receiver.Receive(ctx); err != nil {
		t.Fatalf("legitimate sender evicted: %v", err)
	}
}
func TestLocalServerRejectsOversizedAndUnjoinedFrames(t *testing.T) {
	p, _, endpoint := localServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, data := range [][]byte{make([]byte, MaxFrame+1), []byte(`{"type":"join","protocol":"cd-device-v1","role":"receiver","token":"guess"}`)} {
		socket, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint, nil)
		if err != nil {
			t.Fatal(err)
		}
		readLocalChallenge(t, socket)
		socket.WriteMessage(websocket.TextMessage, data)
		socket.SetReadDeadline(time.Now().Add(time.Second))
		if _, _, err = socket.ReadMessage(); err == nil {
			t.Fatal("invalid join accepted")
		}
		socket.Close()
	}
	socket, _, err := websocket.DefaultDialer.DialContext(ctx, endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	challenge := readLocalChallenge(t, socket)
	join, _ := p.LocalJoin(Receiver, challenge.Nonce)
	socket.WriteJSON(join)
	socket.SetReadDeadline(time.Now().Add(time.Second))
	var event Event
	if err = socket.ReadJSON(&event); err != nil || event.Type != "accepted" {
		t.Fatalf("valid admission: %+v %v", event, err)
	}
	socket.WriteMessage(websocket.BinaryMessage, make([]byte, MaxFrame+1))
	if _, _, err = socket.ReadMessage(); err == nil {
		t.Fatal("oversized authenticated control frame accepted")
	}
}
func TestPeerRejectsTamperedCiphertextFromRelay(t *testing.T) {
	p := testPair(t)
	upgrader := websocket.Upgrader{}
	badRelay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer socket.Close()
		var join Join
		if socket.ReadJSON(&join) != nil {
			return
		}
		socket.WriteJSON(Event{"accepted", Protocol})
		socket.WriteMessage(websocket.BinaryMessage, make([]byte, 28))
		time.Sleep(50 * time.Millisecond)
	}))
	defer badRelay.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	peer, err := Dial(ctx, "ws"+strings.TrimPrefix(badRelay.URL, "http"), p, Receiver)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	if _, err = peer.Receive(ctx); err == nil || !strings.Contains(err.Error(), "authentication") {
		t.Fatalf("tampered relay frame result: %v", err)
	}
}
func TestLocalServerRefusesBrowserOriginAndWrongPath(t *testing.T) {
	_, _, endpoint := localServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	header := http.Header{"Origin": []string{"https://untrusted.example"}}
	socket, response, err := websocket.DefaultDialer.DialContext(ctx, endpoint, header)
	if socket != nil {
		socket.Close()
	}
	if err == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("origin admission: %v %+v", err, response)
	}
	socket, response, err = websocket.DefaultDialer.DialContext(ctx, endpoint+"invalid", nil)
	if socket != nil {
		socket.Close()
	}
	if err == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("path admission: %v %+v", err, response)
	}
}
func TestJoinContainsHashesButNotMasterSecret(t *testing.T) {
	p := testPair(t)
	join, err := p.Join(Sender)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(join)
	if strings.Contains(string(b), p.Secret) || join.Token == p.Secret || join.SenderTokenHash == "" || join.ReceiverTokenHash == "" {
		t.Fatal("join exposed master or missing derived hashes")
	}
	token, err := base64.RawURLEncoding.DecodeString(join.Token)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(token)
	if join.SenderTokenHash != base64.RawURLEncoding.EncodeToString(hash[:]) {
		t.Fatal("sender hash does not match admission token")
	}
	r, _ := p.Join(Receiver)
	if r.Token == join.Token || r.SenderTokenHash != "" || r.ReceiverTokenHash != "" {
		t.Fatal("roles not separated")
	}
}

func readLocalChallenge(t *testing.T, socket *websocket.Conn) Challenge {
	t.Helper()
	socket.SetReadDeadline(time.Now().Add(time.Second))
	var challenge Challenge
	if err := socket.ReadJSON(&challenge); err != nil {
		t.Fatal(err)
	}
	if challenge.Type != "challenge" || challenge.Protocol != Protocol {
		t.Fatalf("invalid challenge: %+v", challenge)
	}
	if _, err := decode(challenge.Nonce, 32); err != nil {
		t.Fatal(err)
	}
	return challenge
}

func TestLocalProofCannotReplayOnAnotherConnection(t *testing.T) {
	pair, _, endpoint := localServer(t)
	first, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	challenge := readLocalChallenge(t, first)
	stolen, err := pair.LocalJoin(Receiver, challenge.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	first.Close()
	second, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	nextChallenge := readLocalChallenge(t, second)
	if challenge.Nonce == nextChallenge.Nonce {
		t.Fatal("challenge reused between sockets")
	}
	if err = second.WriteJSON(stolen); err != nil {
		t.Fatal(err)
	}
	if _, _, err = second.ReadMessage(); err == nil {
		t.Fatal("harvested proof authorized another connection")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	peer, err := DialLocal(ctx, endpoint, pair, Receiver)
	if err != nil {
		t.Fatalf("replayed proof occupied the receiver role: %v", err)
	}
	peer.Close()
}

func TestLocalProofBindsRoleAndPair(t *testing.T) {
	pair, _, endpoint := localServer(t)
	for _, mutate := range []func(Challenge) (LocalJoin, error){
		func(c Challenge) (LocalJoin, error) {
			join, err := pair.LocalJoin(Sender, c.Nonce)
			join.Role = Receiver
			return join, err
		},
		func(c Challenge) (LocalJoin, error) { return testPair(t).LocalJoin(Receiver, c.Nonce) },
	} {
		socket, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
		if err != nil {
			t.Fatal(err)
		}
		challenge := readLocalChallenge(t, socket)
		join, err := mutate(challenge)
		if err != nil {
			t.Fatal(err)
		}
		socket.WriteJSON(join)
		if _, _, err = socket.ReadMessage(); err == nil {
			t.Fatal("proof from a different role/pair accepted")
		}
		socket.Close()
	}
}

func TestSpoofedLocalEndpointNeverReceivesRelayBearerToken(t *testing.T) {
	pair := testPair(t)
	captured := make(chan map[string]json.RawMessage, 1)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		socket, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer socket.Close()
		nonce, _ := randomID(32)
		socket.WriteJSON(Challenge{Type: "challenge", Protocol: Protocol, Nonce: nonce})
		var fields map[string]json.RawMessage
		if socket.ReadJSON(&fields) != nil {
			return
		}
		captured <- fields
		socket.WriteJSON(Event{"accepted", Protocol})
		// Keep the connection alive until the test closes its client.
		_, _, _ = socket.ReadMessage()
	}))
	defer endpoint.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	peer, err := DialLocal(ctx, "ws"+strings.TrimPrefix(endpoint.URL, "http"), pair, Receiver)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	select {
	case fields := <-captured:
		for _, key := range []string{"token", "senderTokenHash", "receiverTokenHash", "secret"} {
			if _, present := fields[key]; present {
				t.Fatalf("local join leaked %s", key)
			}
		}
		if len(fields) != 4 {
			t.Fatalf("unexpected local join fields: %+v", fields)
		}
		data, _ := json.Marshal(fields)
		relayJoin, _ := pair.Join(Receiver)
		if strings.Contains(string(data), relayJoin.Token) || strings.Contains(string(data), pair.Secret) {
			t.Fatal("local endpoint harvested a reusable credential")
		}
		var proof string
		if json.Unmarshal(fields["localProof"], &proof) != nil {
			t.Fatal("missing local proof")
		}
		if _, err := decode(proof, 32); err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("local endpoint did not capture join")
	}
}

func TestLocalServerRejectsLegacyRelayBearerJoin(t *testing.T) {
	pair, _, endpoint := localServer(t)
	socket, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	readLocalChallenge(t, socket)
	legacy, _ := pair.Join(Receiver)
	socket.WriteJSON(legacy)
	if _, _, err = socket.ReadMessage(); err == nil {
		t.Fatal("local server accepted reusable relay token")
	}
}

func TestLocalApplicationPingPongPreservesEncryptedControl(t *testing.T) {
	pair, _, endpoint := localServer(t)
	sender, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	challenge := readLocalChallenge(t, sender)
	join, err := pair.LocalJoin(Sender, challenge.Nonce)
	if err != nil {
		t.Fatal(err)
	}
	sender.WriteJSON(join)
	var event Event
	if err = sender.ReadJSON(&event); err != nil || event.Type != "accepted" {
		t.Fatalf("sender acceptance: %+v %v", event, err)
	}
	if err = sender.WriteJSON(Event{Type: "ping", Protocol: Protocol}); err != nil {
		t.Fatal(err)
	}
	if err = sender.ReadJSON(&event); err != nil || event.Type != "pong" || event.Protocol != Protocol {
		t.Fatalf("application pong: %+v %v", event, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	receiver, err := DialLocal(ctx, endpoint, pair, Receiver)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	nextEvent(t, receiver, "accepted")
	nextEvent(t, receiver, "peer-joined")
	if err = sender.ReadJSON(&event); err != nil || event.Type != "peer-joined" {
		t.Fatalf("peer discovery after ping: %+v %v", event, err)
	}
	codec, err := NewCodec(pair, Sender)
	if err != nil {
		t.Fatal(err)
	}
	offer := testOffer(t)
	frame, err := codec.Seal(offer)
	if err != nil {
		t.Fatal(err)
	}
	if err = sender.WriteMessage(websocket.BinaryMessage, frame); err != nil {
		t.Fatal(err)
	}
	actual, err := receiver.Receive(ctx)
	if err != nil || actual.TransferID != offer.TransferID {
		t.Fatalf("encrypted offer after ping: %+v %v", actual, err)
	}
}

func TestPeerIgnoresApplicationPongAndContinuesReceiving(t *testing.T) {
	pair := testPair(t)
	codec, err := NewCodec(pair, Sender)
	if err != nil {
		t.Fatal(err)
	}
	offer := testOffer(t)
	frame, err := codec.Seal(offer)
	if err != nil {
		t.Fatal(err)
	}
	relay := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		socket, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer socket.Close()
		var join Join
		if socket.ReadJSON(&join) != nil {
			return
		}
		socket.WriteJSON(Event{Type: "accepted", Protocol: Protocol})
		socket.WriteJSON(Event{Type: "pong", Protocol: Protocol})
		socket.WriteMessage(websocket.BinaryMessage, frame)
		_, _, _ = socket.ReadMessage()
	}))
	defer relay.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	receiver, err := Dial(ctx, "ws"+strings.TrimPrefix(relay.URL, "http"), pair, Receiver)
	if err != nil {
		t.Fatal(err)
	}
	defer receiver.Close()
	nextEvent(t, receiver, "accepted")
	actual, err := receiver.Receive(ctx)
	if err != nil || actual.TransferID != offer.TransferID {
		t.Fatalf("offer after relay pong: %+v %v", actual, err)
	}
	select {
	case event := <-receiver.Events:
		t.Fatalf("application pong escaped into peer events: %+v", event)
	default:
	}
}

func TestLocalServerRejectsUnexpectedApplicationText(t *testing.T) {
	pair, _, endpoint := localServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	observer, err := DialLocal(ctx, endpoint, pair, Sender)
	if err != nil {
		t.Fatal(err)
	}
	defer observer.Close()
	nextEvent(t, observer, "accepted")
	for _, event := range []Event{{Type: "ping", Protocol: "wrong-protocol"}, {Type: "pong", Protocol: Protocol}, {Type: "join", Protocol: Protocol}} {
		socket, _, err := websocket.DefaultDialer.Dial(endpoint, nil)
		if err != nil {
			t.Fatal(err)
		}
		challenge := readLocalChallenge(t, socket)
		join, _ := pair.LocalJoin(Receiver, challenge.Nonce)
		socket.WriteJSON(join)
		var accepted Event
		if err = socket.ReadJSON(&accepted); err != nil || accepted.Type != "accepted" {
			t.Fatalf("receiver admission: %+v %v", accepted, err)
		}
		var joined Event
		if err = socket.ReadJSON(&joined); err != nil || joined.Type != "peer-joined" {
			t.Fatalf("receiver pairing: %+v %v", joined, err)
		}
		nextEvent(t, observer, "peer-joined")
		socket.WriteJSON(event)
		if _, _, err = socket.ReadMessage(); err == nil {
			t.Fatalf("unexpected application text accepted: %+v", event)
		}
		socket.Close()
		// A client-side close does not guarantee server teardown has run.
		// peer-left is emitted after removing the authenticated receiver role.
		nextEvent(t, observer, "peer-left")
	}
}
