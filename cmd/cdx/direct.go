package main

import (
	"encoding/binary"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

// The direct path: once sender and receiver meet in the relay room, they
// also try a WebRTC data channel (same-LAN host candidates first, then a
// STUN-discovered internet path). Signaling rides inside the encrypted
// records: the sender's SDP offer in the file offer, the receiver's answer in
// a signal record. Records keep their end-to-end encryption on the data
// channel; they are split into 64 KiB messages that every SCTP stack
// (Chrome, Firefox, Safari, pion) accepts. Transfers start on the relay and
// move to the direct path when it opens, so a direct path that never connects
// costs nothing.

const (
	directChannelID = 1
	directPieceSize = 64 * 1024
	// directGatherWait bounds ICE gathering: host candidates are immediate,
	// a STUN answer normally takes one round trip.
	directGatherWait = time.Second
	// directMinBytes skips the direct path for small files, which finish
	// on the relay before a data channel would open.
	directMinBytes   = 1024 * 1024
	directBufferHigh = 8 * 1024 * 1024
	directBufferLow  = 2 * 1024 * 1024
	// directReceiveBuffer raises pion's 1 MiB SCTP receive window, which
	// otherwise caps throughput at 1 MiB per round trip.
	directReceiveBuffer = 8 * 1024 * 1024
	// recordTagBytes is the AES-GCM tag that ends every record.
	recordTagBytes = 16
	// maxSDPBytes bounds SDP taken from the peer.
	maxSDPBytes = 64 * 1024
)

var errDirectStalled = NewFailure(failureDisconnected, "direct connection stalled", retryNewTransfer)

// directICEServers is a variable so tests can run without STUN.
var directICEServers = []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302", "stun:global.stun.twilio.com:3478"}}}

// directOffer is the optional `direct` member of the encrypted file offer.
type directOffer struct {
	SDP string `json:"sdp"`
}

// directSignal is the payload of a receiver's signal record: its answer,
// then (trickle ICE) one record per local candidate as it is discovered.
type directSignal struct {
	SDP       string                   `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`
}

// maxRemoteCandidates bounds trickled candidates taken from the peer.
const maxRemoteCandidates = 64

// directEnabled lets tests and benchmarks force the relay (CD_DIRECT=0).
func directEnabled() bool {
	return os.Getenv("CD_DIRECT") != "0"
}

type directPath struct {
	connection *webrtc.PeerConnection
	channel    *webrtc.DataChannel
	// stream, when set, is an authenticated same-network TCP connection
	// (see lan.go) that carries the records instead of a data channel.
	stream   net.Conn
	streamMu sync.Mutex
	opened   chan struct{}
	// lost closes when the data channel, the ICE connection, or the stream
	// fails.
	lost      chan struct{}
	lostOnce  sync.Once
	openOnce  sync.Once
	drained   chan struct{}
	assembler recordAssembler
	onLost    func(error)
	// retired marks a path another one replaced before it carried data;
	// its failure is not reported.
	retired atomic.Bool
}

// newDirectPath creates the peer connection and its pre-negotiated data
// channel. onRecord receives each complete record that arrives on it.
func newDirectPath(onRecord func([]byte), onLost func(error)) (*directPath, error) {
	settings := webrtc.SettingEngine{}
	quiet := logging.NewDefaultLoggerFactory()
	quiet.Writer = io.Discard
	quiet.DefaultLogLevel = logging.LogLevelDisabled
	settings.LoggerFactory = quiet
	// Browsers hide LAN addresses behind mDNS names; resolve them.
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
	settings.SetSCTPMaxReceiveBufferSize(directReceiveBuffer)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	connection, err := api.NewPeerConnection(webrtc.Configuration{ICEServers: directICEServers})
	if err != nil {
		return nil, err
	}
	negotiated := true
	id := uint16(directChannelID)
	channel, err := connection.CreateDataChannel("cd-direct", &webrtc.DataChannelInit{Negotiated: &negotiated, ID: &id})
	if err != nil {
		_ = connection.Close()
		return nil, err
	}
	path := &directPath{connection: connection, channel: channel, opened: make(chan struct{}), lost: make(chan struct{}), drained: make(chan struct{}, 1), onLost: onLost}
	lose := path.lose
	channel.OnOpen(func() { path.openOnce.Do(func() { close(path.opened) }) })
	channel.OnClose(func() { lose(NewFailure(failureDisconnected, "direct connection closed", retryNewTransfer)) })
	channel.SetBufferedAmountLowThreshold(directBufferLow)
	channel.OnBufferedAmountLow(func() {
		select {
		case path.drained <- struct{}{}:
		default:
		}
	})
	channel.OnMessage(func(message webrtc.DataChannelMessage) {
		records, err := path.assembler.push(message.Data)
		if err != nil {
			lose(err)
			_ = connection.Close()
			return
		}
		for _, record := range records {
			onRecord(record)
		}
	})
	connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
			lose(NewFailure(failureDisconnected, "direct connection "+state.String(), retryNewTransfer))
		}
	})
	return path, nil
}

// newStreamPath wraps an authenticated same-network connection as an open
// direct path. onRecord receives each complete record read from it.
func newStreamPath(stream net.Conn, onRecord func([]byte), onLost func(error)) *directPath {
	path := &directPath{stream: stream, opened: make(chan struct{}), lost: make(chan struct{}), drained: make(chan struct{}, 1), onLost: onLost}
	close(path.opened)
	go path.readStream(onRecord)
	return path
}

func (path *directPath) readStream(onRecord func([]byte)) {
	for {
		var header [headerBytes]byte
		if _, err := io.ReadFull(path.stream, header[:]); err != nil {
			path.lose(NewFailure(failureDisconnected, "direct connection closed", retryNewTransfer))
			return
		}
		length := uint64(headerBytes) + uint64(binary.BigEndian.Uint32(header[8:12])) + recordTagBytes
		if header[0] != 'C' || header[1] != 'D' || header[2] != path.assembler.protocol() || length > maxRecordBytes {
			path.lose(NewFailure(failureProtocol, "direct connection sent an invalid record", retryNever))
			_ = path.stream.Close()
			return
		}
		record := make([]byte, int(length))
		copy(record, header[:])
		if _, err := io.ReadFull(path.stream, record[headerBytes:]); err != nil {
			path.lose(NewFailure(failureDisconnected, "direct connection interrupted", retryNewTransfer))
			return
		}
		onRecord(record)
	}
}

type directPathError struct {
	path *directPath
	err  error
}

func (err *directPathError) Error() string { return err.err.Error() }
func (err *directPathError) Unwrap() error { return err.err }

func (path *directPath) lose(err error) {
	path.lostOnce.Do(func() {
		close(path.lost)
		if !path.retired.Load() {
			path.onLost(&directPathError{path: path, err: err})
		}
	})
}

// retire closes a path that another one replaced, without reporting it.
func (path *directPath) retire() {
	path.retired.Store(true)
	path.close()
}

// localDescription waits for ICE gathering (bounded) and returns the SDP.
func (path *directPath) localDescription() string {
	select {
	case <-webrtc.GatheringCompletePromise(path.connection):
	case <-time.After(directGatherWait):
	}
	return path.connection.LocalDescription().SDP
}

func (path *directPath) createOffer() (string, error) {
	offer, err := path.connection.CreateOffer(nil)
	if err != nil {
		return "", err
	}
	if err := path.connection.SetLocalDescription(offer); err != nil {
		return "", err
	}
	return path.localDescription(), nil
}

func (path *directPath) acceptAnswer(sdp string) error {
	if len(sdp) == 0 || len(sdp) > maxSDPBytes {
		return NewFailure(failureProtocol, "invalid direct answer", retryNever)
	}
	return path.connection.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp})
}

// answerOffer applies the sender's offer and returns the answer SDP. With
// onCandidate set it returns at once and trickles local candidates to it;
// otherwise it waits for gathering and embeds them in the SDP.
func (path *directPath) answerOffer(sdp string, onCandidate func(webrtc.ICECandidateInit)) (string, error) {
	if len(sdp) == 0 || len(sdp) > maxSDPBytes {
		return "", NewFailure(failureProtocol, "invalid direct offer", retryNever)
	}
	if err := path.connection.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: sdp}); err != nil {
		return "", err
	}
	answer, err := path.connection.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	if onCandidate != nil {
		path.connection.OnICECandidate(func(candidate *webrtc.ICECandidate) {
			if candidate != nil {
				onCandidate(candidate.ToJSON())
			}
		})
	}
	if err := path.connection.SetLocalDescription(answer); err != nil {
		return "", err
	}
	if onCandidate != nil {
		return path.connection.LocalDescription().SDP, nil
	}
	return path.localDescription(), nil
}

func (path *directPath) addCandidate(candidate webrtc.ICECandidateInit) error {
	if len(candidate.Candidate) > 1024 {
		return NewFailure(failureProtocol, "invalid direct candidate", retryNever)
	}
	return path.connection.AddICECandidate(candidate)
}

func (path *directPath) isLost() bool {
	select {
	case <-path.lost:
		return true
	default:
		return false
	}
}

func (path *directPath) isOpen() bool {
	select {
	case <-path.lost:
		return false
	case <-path.opened:
		return true
	default:
		return false
	}
}

// send writes one record as 64 KiB messages, waiting while the channel's
// send buffer is full.
func (path *directPath) send(record []byte) error {
	if path.stream != nil {
		path.streamMu.Lock()
		defer path.streamMu.Unlock()
		if err := path.stream.SetWriteDeadline(time.Now().Add(transferIdle)); err != nil {
			return err
		}
		if n, err := path.stream.Write(record); err != nil {
			if isTimeoutError(err) {
				return NewFailure(failureDisconnected, "direct connection stalled", retryNewTransfer)
			}
			return err
		} else if n != len(record) {
			return io.ErrShortWrite
		}
		return nil
	}
	for path.channel.BufferedAmount() > directBufferHigh {
		select {
		case <-path.drained:
		case <-path.lost:
			return NewFailure(failureDisconnected, "direct connection lost", retryNewTransfer)
		case <-time.After(transferIdle):
			return NewFailure(failureDisconnected, "direct connection stalled", retryNewTransfer, errDirectStalled)
		}
	}
	for start := 0; start < len(record); start += directPieceSize {
		if err := path.channel.Send(record[start:min(start+directPieceSize, len(record))]); err != nil {
			return err
		}
	}
	return nil
}

// route names the network path ICE chose, for the progress log. A private,
// loopback, or link-local remote address means both ends share a network.
func (path *directPath) route() string {
	var remote string
	if path.stream != nil {
		remote, _, _ = net.SplitHostPort(path.stream.RemoteAddr().String())
	} else if pair, err := path.connection.SCTP().Transport().ICETransport().GetSelectedCandidatePair(); err == nil && pair != nil {
		remote = pair.Remote.Address
	}
	address := net.ParseIP(remote)
	if address == nil {
		return "direct"
	}
	if address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() || isInterfaceAddress(address) {
		return "same network"
	}
	return "direct internet path"
}

func isInterfaceAddress(address net.IP) bool {
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, candidate := range addresses {
		if network, ok := candidate.(*net.IPNet); ok && network.IP.Equal(address) {
			return true
		}
	}
	return false
}

func (path *directPath) close() {
	if path.stream != nil {
		_ = path.stream.Close()
		return
	}
	_ = path.connection.Close()
}

// recordAssembler rebuilds records from data-channel messages using each
// record's plaintext header: 12 header bytes, the plaintext, a 16-byte tag.
type recordAssembler struct {
	version byte
	buffer  []byte
}

func (assembler *recordAssembler) push(piece []byte) ([][]byte, error) {
	assembler.buffer = append(assembler.buffer, piece...)
	var records [][]byte
	for len(assembler.buffer) >= headerBytes {
		header := assembler.buffer[:headerBytes]
		if header[0] != 'C' || header[1] != 'D' || header[2] != assembler.protocol() {
			return nil, NewFailure(failureProtocol, "direct connection sent an invalid record", retryNever)
		}
		length := headerBytes + int(binary.BigEndian.Uint32(header[8:12])) + recordTagBytes
		if length > maxRecordBytes {
			return nil, NewFailure(failureProtocol, "direct connection sent an oversized record", retryNever)
		}
		if len(assembler.buffer) < length {
			break
		}
		record := make([]byte, length)
		copy(record, assembler.buffer[:length])
		records = append(records, record)
		assembler.buffer = assembler.buffer[length:]
	}
	if len(assembler.buffer) == 0 {
		assembler.buffer = nil
	}
	return records, nil
}

func (assembler *recordAssembler) protocol() byte {
	if assembler.version == 0 {
		return protocolVersion
	}
	return assembler.version
}
