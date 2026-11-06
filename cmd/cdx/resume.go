package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const resumeProtocol = "cd-transfer-v2"

var errResumeSessionLimit = errors.New("resume session budget exhausted")

func resumeSessionLimitFailure() error {
	return NewFailure(failureExpired, "transfer reached its reconnect limit; start a new transfer", retryNewTransfer, errResumeSessionLimit)
}

type resumeOffer struct {
	Direct      *directOffer `json:"direct,omitempty"`
	WindowBytes int64        `json:"windowBytes,omitempty"`
	Name        string       `json:"name"`
	Size        string       `json:"size"`
	SizeValue   int64        `json:"-"`
	ChunkSize   int64        `json:"chunkSize"`
	WholeSHA256 string       `json:"wholeSha256"`
	ExpiresAt   int64        `json:"expiresAt"`
}
type resumeEvent struct {
	Protocol           string `json:"protocol"`
	Type               string `json:"type"`
	SessionNonce       string `json:"sessionNonce"`
	ReceiverNonce      string `json:"receiverNonce"`
	SenderNonceProof   string `json:"senderNonceProof"`
	ReceiverNonceProof string `json:"receiverNonceProof"`
	NonceProof         string `json:"nonceProof"`
	ExpiresAt          int64  `json:"expiresAt"`
	Reason             string `json:"reason,omitempty"`
}
type resumeSession struct {
	socket                     *websocket.Conn
	seal                       *resumeRecordSealer
	open                       *resumeRecordOpener
	senderNonce, receiverNonce string
	expiresAt                  int64
	local                      bool
	localDone                  chan struct{}
	closeOnce                  sync.Once
	onClose                    context.CancelFunc
}

func resumeRandom() ([]byte, error) {
	value := make([]byte, 32)
	_, err := io.ReadFull(rand.Reader, value)
	return value, err
}
func resumeEncoded(bytes []byte) string { return base64.RawURLEncoding.EncodeToString(bytes) }
func resumeConnect(ctx context.Context, invite invitation, role string, senderToken []byte, admission ...func(int64) error) (*resumeSession, error) {
	return resumeConnectWithExpiry(ctx, invite, role, senderToken, 0, admission...)
}

func resumeConnectWithExpiry(ctx context.Context, invite invitation, role string, senderToken []byte, expiry int64, admission ...func(int64) error) (*resumeSession, error) {
	relay, _, err := endpointBase()
	if err != nil {
		return nil, err
	}
	relay = strings.TrimSuffix(relay, "/v1") + "/v2"
	nonce, err := resumeRandom()
	if err != nil {
		return nil, err
	}
	proof, err := resumeNonceProof(invite, role, nonce)
	if err != nil {
		return nil, err
	}
	token, err := resumeReceiverAdmission(invite)
	if err != nil {
		return nil, err
	}
	join := map[string]any{"type": "join", "protocol": resumeProtocol, "role": role, "nonceProof": resumeEncoded(proof)}
	if role == "sender" {
		digest := sha256.Sum256(senderToken)
		receiverDigest := sha256.Sum256(token)
		if expiry != 0 {
			join["expiresAt"] = expiry
		}
		join["senderToken"] = resumeEncoded(senderToken)
		join["senderTokenHash"] = resumeEncoded(digest[:])
		join["receiverTokenHash"] = resumeEncoded(receiverDigest[:])
		join["sessionNonce"] = resumeEncoded(nonce)
	} else {
		join["receiverToken"] = resumeEncoded(token)
		join["receiverNonce"] = resumeEncoded(nonce)
	}
	socket, _, err := websocket.DefaultDialer.DialContext(ctx, relay+"/"+invite.encodedID(), http.Header{})
	if err != nil {
		return nil, NewFailure(failureNetwork, "connect resumable relay: "+err.Error(), retrySameRequest, err)
	}
	socket.SetReadLimit(maxRecordBytes)
	socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err = socket.WriteJSON(join); err != nil {
		socket.Close()
		return nil, err
	}
	closed := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			socket.Close()
		case <-closed:
		}
	}()
	defer close(closed)
	socket.SetReadDeadline(time.Now().Add(15 * time.Minute))
	var paired resumeEvent
	admitted := false
	expiresAt := int64(0)
	for {
		kind, data, err := socket.ReadMessage()
		if err != nil {
			socket.Close()
			if websocket.IsCloseError(err, 4410) {
				return nil, resumeSessionLimitFailure()
			}
			return nil, NewFailure(failureDisconnected, "resume pairing interrupted: "+err.Error()+"; retry explicit resume", retrySameRequest, err)
		}
		if kind != websocket.TextMessage {
			socket.Close()
			return nil, resumeFailure("unexpected record before authenticated pairing")
		}
		var event resumeEvent
		if json.Unmarshal(data, &event) != nil || event.Protocol != resumeProtocol {
			socket.Close()
			return nil, resumeFailure("invalid resume relay event")
		}
		if event.Type == "exhausted" && event.Reason == "session_limit" {
			socket.Close()
			return nil, resumeSessionLimitFailure()
		}
		if event.Type == "interrupted" || event.Type == "peer-left" {
			socket.Close()
			return nil, NewFailure(failureDisconnected, "resumable peer disconnected; reconnect both clients", retrySameRequest)
		}
		if event.Type == "accepted" && !admitted {
			admitted = true
			expiresAt = event.ExpiresAt
			if len(admission) > 0 {
				if err = admission[0](event.ExpiresAt); err != nil {
					socket.Close()
					return nil, err
				}
			}
		}
		if event.SessionNonce != "" && event.ReceiverNonce != "" {
			paired = event
			break
		}
	}
	sNonce, err := resumeDecode(paired.SessionNonce, 32)
	if err != nil {
		socket.Close()
		return nil, err
	}
	rNonce, err := resumeDecode(paired.ReceiverNonce, 32)
	if err != nil {
		socket.Close()
		return nil, err
	}
	peerRole, peerNonce, peerProof := "receiver", rNonce, paired.ReceiverNonceProof
	if role == "receiver" {
		peerRole, peerNonce, peerProof = "sender", sNonce, paired.SenderNonceProof
	}
	if peerProof == "" {
		peerProof = paired.NonceProof
	}
	rawProof, err := resumeDecode(peerProof, 32)
	if err != nil {
		socket.Close()
		return nil, err
	}
	if !verifyResumeNonceProof(invite, peerRole, peerNonce, rawProof) {
		socket.Close()
		return nil, resumeFailure("peer session nonce proof failed")
	}
	own := sNonce
	if role == "receiver" {
		own = rNonce
	}
	if resumeEncoded(own) != resumeEncoded(nonce) {
		socket.Close()
		return nil, resumeFailure("relay substituted this client's fresh session nonce")
	}
	directionSend, directionRead := senderDirection, receiverDirection
	if role == "receiver" {
		directionSend, directionRead = receiverDirection, senderDirection
	}
	sealer, err := newResumeSealer(invite, sNonce, rNonce, directionSend)
	if err != nil {
		socket.Close()
		return nil, err
	}
	opener, err := newResumeOpener(invite, sNonce, rNonce, directionRead)
	if err != nil {
		socket.Close()
		return nil, err
	}
	return &resumeSession{socket: socket, seal: sealer, open: opener, senderNonce: paired.SessionNonce, receiverNonce: paired.ReceiverNonce, expiresAt: expiresAt}, nil
}
func (s *resumeSession) send(kind messageKind, payload []byte) error {
	record, err := s.seal.seal(kind, payload)
	if err != nil {
		return err
	}
	s.socket.SetWriteDeadline(time.Now().Add(90 * time.Second))
	return s.socket.WriteMessage(websocket.BinaryMessage, record)
}
func (s *resumeSession) next() (messageKind, []byte, error) {
	for {
		s.socket.SetReadDeadline(time.Now().Add(90 * time.Second))
		kind, data, err := s.socket.ReadMessage()
		if err != nil {
			if websocket.IsCloseError(err, 4410) {
				return 0, nil, resumeSessionLimitFailure()
			}
			return 0, nil, NewFailure(failureDisconnected, "transfer interrupted; retained progress is available through explicit resume", retrySameRequest, err)
		}
		if kind == websocket.BinaryMessage {
			return s.open.open(data)
		}
		var event resumeEvent
		if json.Unmarshal(data, &event) != nil || event.Protocol != resumeProtocol {
			return 0, nil, resumeFailure("invalid resumable relay event")
		}
		if event.Type == "exhausted" && event.Reason == "session_limit" {
			return 0, nil, resumeSessionLimitFailure()
		}
		if event.Type == "interrupted" || event.Type == "peer-left" {
			return 0, nil, NewFailure(failureDisconnected, "peer interrupted; reconnect both clients with the same private link", retrySameRequest)
		}
	}
}
func (s *resumeSession) close() {
	s.closeOnce.Do(func() {
		s.socket.Close()
		if s.onClose != nil {
			s.onClose()
		}
		if s.localDone != nil {
			close(s.localDone)
		}
	})
}

func (s *resumeSession) terminal(receiver bool) error {
	if receiver {
		s.socket.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := s.socket.WriteJSON(map[string]any{"type": "complete", "protocol": resumeProtocol, "sessionNonce": s.senderNonce, "receiverNonce": s.receiverNonce}); err != nil {
			return err
		}
	}
	for {
		s.socket.SetReadDeadline(time.Now().Add(10 * time.Second))
		kind, data, err := s.socket.ReadMessage()
		if err != nil {
			return err
		}
		if kind != websocket.TextMessage {
			return resumeFailure("unexpected data after completion")
		}
		var event resumeEvent
		if json.Unmarshal(data, &event) != nil || event.Protocol != resumeProtocol {
			return resumeFailure("invalid completion control")
		}
		if s.local && !receiver && event.Type == "complete" && event.SessionNonce == s.senderNonce && event.ReceiverNonce == s.receiverNonce {
			return s.socket.WriteJSON(map[string]string{"type": "completed", "protocol": resumeProtocol})
		}
		if event.Type == "completed" {
			return nil
		}
		if event.Type == "interrupted" {
			return resumeFailure("completion was interrupted; retained checkpoint is kept")
		}
	}
}
func resumeCounts(size uint64) uint32 { return uint32((size + chunkSize - 1) / chunkSize) }
func resumeEnd(size uint64, digest string) []byte {
	raw, _ := hex.DecodeString(digest)
	return append(encodeCounts(resumeCounts(size), size), raw...)
}
func resumeVerifyEnd(data []byte, size uint64, digest string) error {
	if len(data) != 44 {
		return resumeFailure("invalid resumable completion digest")
	}
	chunks, bytes, err := decodeCounts(data[:12])
	if err != nil || bytes != size || chunks != resumeCounts(size) || hex.EncodeToString(data[12:]) != digest {
		return resumeFailure("resumable completion does not match the complete file")
	}
	return nil
}
func resumeProgress(label string, total uint64, jsonOutput, requested bool) (func(uint64), func()) {
	terminal := isTerminal(os.Stderr)
	bar := newProgressBar(os.Stderr, label, total)
	bar.jsonLines = jsonOutput
	bar.plainLines = !terminal
	return func(bytes uint64) {
		if transferProgressEnabled(terminal, jsonOutput, requested) {
			bar.update(bytes)
		}
	}, bar.finish
}

func runResumableSend(request sendRequest) int {
	ctx, cancel := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer cancel()
	err := sendResumable(ctx, request)
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput)
		return 1
	}
	return 0
}
func sendResumable(ctx context.Context, request sendRequest) error {
	resumeCleanupCapabilities(time.Now())
	source, err := prepareSource(request.files)
	if err != nil {
		return err
	}
	if source.size > 1<<53-1 {
		return resumeFailure("resumable file exceeds cross-client size limits")
	}
	digest, err := resumeSourceDigest(source)
	if err != nil {
		return err
	}
	var cap resumeCapability
	var invite invitation
	var senderToken []byte
	if request.resumeID != "" {
		cap, invite, senderToken, err = resumeLoadCapability(request.resumeID)
		if err != nil {
			return err
		}
		if cap.Checkpoint.Filename != source.name || cap.Checkpoint.Size != int64(source.size) || cap.Checkpoint.WholeSHA256 != digest {
			return resumeFailure("resume source changed; retained progress cannot be accepted")
		}
	} else {
		invite, err = newInvitation(rand.Reader)
		if err != nil {
			return err
		}
		senderToken, err = resumeRandom()
		if err != nil {
			return err
		}
		prior, err := resumeRandom()
		if err != nil {
			return err
		}
		cap = resumeCapability{Version: 2, Master: invite.encodedKey(), SenderToken: resumeEncoded(senderToken), Checkpoint: ResumeCheckpoint{Version: 2, Role: "sender", RootID: invite.encodedID(), Filename: source.name, Size: int64(source.size), ChunkSize: chunkSize, WholeSHA256: digest, Offset: 0, PrefixSHA256: hex.EncodeToString(sha256.New().Sum(nil)), StagingID: "sender", Destination: "sender", ExpiresAt: time.Now().Add(24 * time.Hour).UnixMilli(), PriorSessionNonce: resumeEncoded(prior)}}
		if err = signResumeCheckpoint(&cap.Checkpoint, senderToken); err != nil {
			return err
		}
		path, err := resumeCapabilityPath(invite.encodedID())
		if err != nil {
			return err
		}
		if err = resumeAtomicJSON(path, cap); err != nil {
			return err
		}
	}
	_, public, err := endpointBase()
	if err != nil {
		return err
	}
	ready := readyOutput{Version: 2, Mode: "foreground", TransferID: invite.encodedID(), URL: public + "/s/" + invite.encodedID() + "#v2." + invite.encodedKey(), Filename: source.name, Size: source.size}
	// Private capability exists before the link is exposed; v2 deliberately runs
	// foreground, preserving the established v1 detached sender behavior.
	admit := func(expiry int64) error {
		if expiry <= time.Now().UnixMilli() {
			return resumeFailure("relay supplied invalid root expiry")
		}
		if request.resumeID != "" && cap.Checkpoint.ExpiresAt != expiry {
			return resumeFailure("saved root expiry differs from authenticated relay root")
		}
		cap.Checkpoint.ExpiresAt = expiry
		if err := signResumeCheckpoint(&cap.Checkpoint, senderToken); err != nil {
			return err
		}
		path, err := resumeCapabilityPath(invite.encodedID())
		if err != nil {
			return err
		}
		if err = resumeAtomicJSON(path, cap); err != nil {
			return err
		}
		if err = saveReadyQR(&ready, request.qrPath); err != nil {
			return err
		}
		return writeReady(os.Stdout, ready, request.jsonOutput)
	}
	var session *resumeSession
	if request.deviceConnect != nil {
		session, err = request.deviceConnect(ctx, invite, senderToken, cap.Checkpoint.ExpiresAt, ready, digest)
	} else {
		session, err = resumeConnect(ctx, invite, "sender", senderToken, admit)
	}
	if err != nil {
		return err
	}
	defer session.close()
	stop := context.AfterFunc(ctx, func() { session.socket.Close() })
	defer stop()
	cap.Checkpoint.PriorSessionNonce = session.senderNonce
	if session.expiresAt <= time.Now().UnixMilli() || session.expiresAt != cap.Checkpoint.ExpiresAt {
		return resumeFailure("relay supplied invalid root expiry")
	}
	cap.Checkpoint.ExpiresAt = session.expiresAt
	if err = signResumeCheckpoint(&cap.Checkpoint, senderToken); err != nil {
		return err
	}
	path, _ := resumeCapabilityPath(invite.encodedID())
	if err = resumeAtomicJSON(path, cap); err != nil {
		return err
	}
	direct, directOffer := newResumeDirect(ctx, session, source.size)
	if direct != nil {
		defer direct.close()
	}
	offer := resumeOffer{Direct: directOffer, WindowBytes: 4 * 1024 * 1024, Name: source.name, Size: strconv.FormatUint(source.size, 10), ChunkSize: chunkSize, WholeSHA256: digest, ExpiresAt: cap.Checkpoint.ExpiresAt}
	encoded, _ := json.Marshal(offer)
	if err = session.send(kindOffer, encoded); err != nil {
		return err
	}
	kind, data, err := nextResumeControl(session, direct)
	if err != nil {
		return err
	}
	var accept struct {
		AckEveryBytes int64  `json:"ackEveryBytes"`
		Offset        string `json:"offset"`
		Prefix        string `json:"prefixSha256"`
	}
	if kind != kindAccept || json.Unmarshal(data, &accept) != nil {
		return resumeFailure("invalid resume acceptance")
	}
	offset, err := strconv.ParseUint(accept.Offset, 10, 53)
	if err != nil || offset > source.size || (offset%chunkSize != 0 && offset != source.size) {
		return resumeFailure("invalid retained resume offset")
	}
	reader, err := source.open()
	if err != nil {
		return err
	}
	defer reader.Close()
	whole := sha256.New()
	if _, err = io.CopyN(whole, reader, int64(offset)); err != nil {
		return err
	}
	if hex.EncodeToString(whole.Sum(nil)) != accept.Prefix {
		return resumeFailure("receiver retained prefix does not match the unchanged source")
	}
	ackEvery := uint64(chunkSize)
	if accept.AckEveryBytes != 0 {
		if accept.AckEveryBytes < chunkSize || accept.AckEveryBytes > 4*1024*1024 || accept.AckEveryBytes%chunkSize != 0 {
			return resumeFailure("invalid durable ACK interval")
		}
		ackEvery = uint64(accept.AckEveryBytes)
	}
	sent, acknowledged := offset, offset
	directUsed := false
	draining := false
	switchDirect := func() {
		direct.used.Store(true)
		directUsed = true
		if request.jsonOutput {
			json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 2, "phase": "sending", "transferId": invite.encodedID(), "route": "peer-to-peer", "transport": "webrtc", "network": direct.path.route()})
		} else {
			transferInfo("switched resumable chunks to peer-to-peer (%s)", direct.path.route())
		}
	}
	report, finish := resumeProgress("sending", source.size, request.jsonOutput, request.progress)
	defer finish()
	report(offset)
	buffer := make([]byte, chunkSize)
	const window = 4 * 1024 * 1024
	for acknowledged < source.size {
		if !directUsed {
			if !direct.ready() {
				draining = false
			} else if (sent-offset)%ackEvery == 0 || sent == source.size {
				draining = true
			}
			if draining && sent == acknowledged {
				switchDirect()
				draining = false
			}
		}
		for sent < source.size && sent-acknowledged < window && !draining {
			limit := min(uint64(chunkSize), source.size-sent)
			n, readErr := io.ReadFull(reader, buffer[:limit])
			if readErr != nil {
				return readErr
			}
			whole.Write(buffer[:n])
			if directUsed {
				err = direct.sendChunk(buffer[:n])
			} else {
				err = session.send(kindChunk, buffer[:n])
			}
			if err != nil {
				return err
			}
			sent += uint64(n)
			if !directUsed && direct.ready() && ((sent-offset)%ackEvery == 0 || sent == source.size) {
				draining = true
				break
			}
		}
		kind, data, err = nextResumeControl(session, direct)
		if err != nil {
			return err
		}
		chunks, ack, parseErr := decodeCounts(data)
		if kind != kindAck || parseErr != nil || ack <= acknowledged || ack > sent || (ack%chunkSize != 0 && ack != source.size) || chunks != resumeCounts(ack) {
			return resumeFailure("receiver acknowledged invalid resume progress")
		}
		acknowledged = ack
		report(acknowledged)
	}
	extra := make([]byte, 1)
	if n, _ := reader.Read(extra); n != 0 || hex.EncodeToString(whole.Sum(nil)) != digest {
		return resumeFailure("source content changed during transfer; no completion was accepted")
	}
	if err = session.send(kindEnd, resumeEnd(sent, digest)); err != nil {
		return err
	}
	kind, data, err = nextResumeControl(session, direct)
	if err != nil {
		return err
	}
	if kind != kindComplete {
		return resumeFailure("receiver did not verify the whole resumed file")
	}
	if err = resumeVerifyEnd(data, sent, digest); err != nil {
		return err
	}
	if err = session.terminal(false); err != nil {
		return err
	}
	_ = os.Remove(path)
	return nil
}

func runResumableReceive(request receiveRequest) int {
	ctx, cancel := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer cancel()
	err := receiveResumable(ctx, request)
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput)
		return 1
	}
	return 0
}
func resumeInvitation(input string) (invitation, error) {
	parsed, err := url.Parse(strings.TrimSpace(input))
	if err != nil {
		return invitation{}, err
	}
	if !strings.HasPrefix(parsed.Fragment, "v2.") {
		return invitation{}, resumeFailure("resume requires a private #v2 link; numeric codes and v1 links cannot resume")
	}
	return parseInvitationParts(strings.TrimPrefix(parsed.Path, "/s/"), strings.TrimPrefix(parsed.Fragment, "v2."))
}
func receiveResumable(ctx context.Context, request receiveRequest) (resultErr error) {
	invite, err := resumeInvitation(request.code)
	if err != nil {
		return err
	}
	session, err := resumeConnect(ctx, invite, "receiver", nil)
	if err != nil {
		return err
	}
	defer session.close()
	stop := context.AfterFunc(ctx, func() { session.socket.Close() })
	defer stop()
	kind, data, err := session.next()
	if err != nil {
		return err
	}
	var offer resumeOffer
	if kind != kindOffer || json.Unmarshal(data, &offer) != nil {
		return resumeFailure("invalid resumable file offer")
	}
	offer.SizeValue, err = strconv.ParseInt(offer.Size, 10, 64)
	if err != nil || offer.SizeValue < 0 || offer.SizeValue > 1<<53-1 || offer.ChunkSize != chunkSize || len(offer.WholeSHA256) != 64 || offer.ExpiresAt <= time.Now().UnixMilli() || offer.ExpiresAt > time.Now().Add(24*time.Hour).UnixMilli() {
		return resumeFailure("invalid resumable source identity or expiry")
	}
	if offer.ExpiresAt != session.expiresAt {
		return resumeFailure("offered expiry does not match the fixed relay root expiry")
	}
	final, checkpointPath, err := resumeDest(offer.Name, request.out, invite.encodedID())
	if err != nil {
		return err
	}
	var checkpoint ResumeCheckpoint
	err = resumeReadJSON(checkpointPath, &checkpoint)
	var stage *os.File
	if err == nil {
		if checkpoint.ExpiresAt <= time.Now().UnixMilli() {
			if verifyResumeCheckpoint(checkpoint, invite.key[:], checkpoint.ExpiresAt-1) == nil {
				resumeRemove(checkpoint, checkpointPath)
			}
			return NewFailure(failureExpired, "resume checkpoint expired after 24 hours; start a new transfer", retryNewTransfer)
		}
		if err = verifyResumeCheckpoint(checkpoint, invite.key[:], time.Now().UnixMilli()); err != nil {
			return err
		}
		if checkpoint.Role != "receiver" || checkpoint.RootID != invite.encodedID() || checkpoint.Destination != final {
			return resumeFailure("checkpoint is bound to another root or destination")
		}
		if checkpoint.PriorSessionNonce == session.senderNonce {
			return resumeFailure("stale sender session cannot resume retained progress")
		}
		if err = resumeCheckOffer(checkpoint, offer); err != nil {
			return err
		}
		stage, err = resumeStage(checkpoint, checkpointPath)
		if err != nil {
			return err
		}
	} else if errors.Is(err, os.ErrNotExist) {
		if _, err = os.Lstat(final); err == nil {
			return NewFailure(failureExists, "resume destination already exists; choose another --out path", retryNever)
		}
		stage, err = os.CreateTemp(filepath.Dir(final), ".cd-stage-*.part")
		if err != nil {
			return err
		}
		checkpoint = ResumeCheckpoint{Version: 2, Role: "receiver", RootID: invite.encodedID(), Filename: offer.Name, Size: offer.SizeValue, ChunkSize: chunkSize, WholeSHA256: offer.WholeSHA256, Offset: 0, PrefixSHA256: hex.EncodeToString(sha256.New().Sum(nil)), StagingID: filepath.Base(stage.Name()), Destination: final, ExpiresAt: offer.ExpiresAt, PriorSessionNonce: session.senderNonce}
	} else {
		return err
	}
	defer stage.Close()
	defer func() {
		if ctx.Err() != nil {
			resumeRemove(checkpoint, checkpointPath)
		}
	}()
	resumedBytes := checkpoint.Offset
	report, finish := resumeProgress("receiving", uint64(checkpoint.Size), request.jsonOutput, request.progress)
	defer finish()
	report(uint64(checkpoint.Offset))
	checkpoint.PriorSessionNonce = session.senderNonce
	whole := sha256.New()
	if _, err = stage.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if _, err = io.CopyN(whole, stage, checkpoint.Offset); err != nil {
		return err
	}
	persist := func() error {
		if err := stage.Sync(); err != nil {
			return err
		}
		checkpoint.PrefixSHA256 = hex.EncodeToString(whole.Sum(nil))
		if err := signResumeCheckpoint(&checkpoint, invite.key[:]); err != nil {
			return err
		}
		return resumeAtomicJSON(checkpointPath, checkpoint)
	}
	if err = persist(); err != nil {
		return err
	}
	accept, _ := json.Marshal(map[string]string{"offset": strconv.FormatInt(checkpoint.Offset, 10), "prefixSha256": checkpoint.PrefixSHA256})
	if err = session.send(kindAccept, accept); err != nil {
		return err
	}
	for {
		kind, data, err = session.next()
		if err != nil {
			return err
		}
		if kind == kindChunk {
			if len(data) == 0 || len(data) > chunkSize || checkpoint.Offset+int64(len(data)) > checkpoint.Size || (len(data) != chunkSize && checkpoint.Offset+int64(len(data)) != checkpoint.Size) {
				return resumeFailure("sender sent invalid resumable chunk bounds")
			}
			if _, err = stage.Write(data); err != nil {
				return err
			}
			whole.Write(data)
			checkpoint.Offset += int64(len(data))
			if err = persist(); err != nil {
				return err
			}
			if err = session.send(kindAck, encodeCounts(resumeCounts(uint64(checkpoint.Offset)), uint64(checkpoint.Offset))); err != nil {
				return err
			}
			report(uint64(checkpoint.Offset))
			continue
		}
		if kind != kindEnd || checkpoint.Offset != checkpoint.Size {
			return resumeFailure("sender ended before complete verified content arrived")
		}
		if hex.EncodeToString(whole.Sum(nil)) != checkpoint.WholeSHA256 {
			return resumeFailure("whole resumed payload digest did not match")
		}
		if err = resumeVerifyEnd(data, uint64(checkpoint.Size), checkpoint.WholeSHA256); err != nil {
			return err
		}
		if err = stage.Sync(); err != nil {
			return err
		}
		info, err := os.Lstat(stage.Name())
		if err != nil {
			return err
		}
		opened, _ := stage.Stat()
		if !os.SameFile(info, opened) {
			return resumeFailure("resume staging changed before publication")
		}
		finalInfo, finalErr := os.Lstat(final)
		if finalErr == nil {
			if !os.SameFile(finalInfo, opened) {
				return NewFailure(failureExists, "destination appeared during transfer; retained staging was kept", retryNever)
			}
		} else if !errors.Is(finalErr, os.ErrNotExist) {
			return finalErr
		} else if err = os.Link(stage.Name(), final); err != nil {
			return err
		}
		if err = resumeSyncDir(filepath.Dir(final)); err != nil {
			return err
		}
		if err = session.send(kindComplete, resumeEnd(uint64(checkpoint.Size), checkpoint.WholeSHA256)); err != nil {
			return err
		}
		if err = session.terminal(true); err != nil {
			return err
		}
		if err = stage.Close(); err != nil {
			return err
		}
		resumeRemove(checkpoint, checkpointPath)
		if request.jsonOutput {
			return json.NewEncoder(os.Stdout).Encode(struct {
				Version      int    `json:"version"`
				Filename     string `json:"filename"`
				Size         uint64 `json:"size"`
				Path         string `json:"path"`
				ResumedBytes int64  `json:"resumedBytes"`
			}{2, checkpoint.Filename, uint64(checkpoint.Size), final, resumedBytes})
		}
		return writeReceived(os.Stdout, receiveResult{Version: 2, Filename: checkpoint.Filename, Size: uint64(checkpoint.Size), Path: final}, false)
	}
}
