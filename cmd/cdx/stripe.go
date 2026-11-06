package main

import (
	"math"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Striping: once the direct path opens, a sender keeps the relay carrying
// data too, so the two paths' throughput adds up. Each path has a writer
// goroutine that takes the next data record whenever it has room, so the
// faster path naturally takes more. Receivers already merge both paths in
// sequence order and drop second copies, so this needs nothing new from
// them.
//
// Room is a per-path cap on bytes in flight, set from one number: the
// relay's share of the sender's in-flight budget. The share is tuned by
// perturb and observe: every epoch it moves a step, and when the delivery
// rate the receiver acknowledges fell, the next step goes the other way. It
// settles where the two paths deliver the most together, whatever limits
// them (a slow relay, a slow direct path, or CPU when both share it).
//
// Relay records stay held until acknowledged: if the relay fails they go
// out again on the direct path. Losing the direct path ends the transfer, as
// before.

// stripeEnabled lets tests and benchmarks keep data on the direct path
// alone (CD_STRIPE=0).
func stripeEnabled() bool {
	return os.Getenv("CD_STRIPE") != "0"
}

const (
	// stripeEpoch is how long each share is held before it is judged.
	stripeEpoch = 200 * time.Millisecond
	// stripeShareStep is how far the relay's share moves per epoch.
	stripeShareStep = 0.125
	// stripeStartShare splits the budget evenly at first.
	stripeStartShare = 0.5
	// stripeBudget is the in-flight budget the share divides. Relay
	// records sent before the switch may still sit in the relay's 32 MiB
	// per-peer buffer, so the relay's part stays at half of it; the direct
	// path's stays within its usual high-water mark. Each keeps at least
	// one record so its delivery rate stays known.
	stripeBudget = 16 * 1024 * 1024
	stripeMinCap = chunkSize + 64
	stripePoll   = 2 * time.Millisecond
	// stripeQueueRecords bounds the queues; the ack window keeps them far
	// below it.
	stripeQueueRecords = 512
)

type stripeItem struct {
	record  []byte
	release uint64
}

type striper struct {
	// data holds data records for whichever path is ready first; control
	// holds control records and re-sends, which take the direct path.
	data    chan stripeItem
	control chan []byte
	// relayRoom wakes the relay writer when an ack frees room.
	relayRoom chan struct{}

	mu        sync.Mutex
	relayCap  uint64
	directCap uint64
	// share is the relay's part of stripeBudget; step is the next move.
	share float64
	step  float64
	// epochStart, epochBytes, and lastRate measure each epoch's delivery.
	epochStart time.Time
	epochBytes uint64
	lastRate   float64
	// relayUnacked keeps relay records (to re-send) and relayBytes their
	// size; directReleases is the release offset of each direct record.
	relayUnacked   []stripeItem
	relayBytes     uint64
	directReleases []uint64
	relayDead      bool
}

func newStriper() *striper {
	s := &striper{
		data:      make(chan stripeItem, stripeQueueRecords),
		control:   make(chan []byte, stripeQueueRecords),
		relayRoom: make(chan struct{}, 1),
		step:      stripeShareStep,
	}
	s.setShare(stripeStartShare)
	return s
}

// setShare sets the relay's share and both caps from it.
func (s *striper) setShare(share float64) {
	s.share = min(max(share, 0), 1)
	s.relayCap = max(uint64(s.share*stripeBudget), stripeMinCap)
	s.directCap = min(max(uint64((1-s.share)*stripeBudget), stripeMinCap), directBufferHigh)
}

// acknowledged drops records the peer confirmed and, once per epoch,
// moves the relay's share.
func (s *striper) acknowledged(bytes uint64, previous uint64, at time.Time) {
	s.mu.Lock()
	covered := 0
	for covered < len(s.relayUnacked) && s.relayUnacked[covered].release <= bytes {
		s.relayBytes -= uint64(len(s.relayUnacked[covered].record))
		covered++
	}
	clear(s.relayUnacked[:covered])
	s.relayUnacked = s.relayUnacked[covered:]
	covered = 0
	for covered < len(s.directReleases) && s.directReleases[covered] <= bytes {
		covered++
	}
	s.directReleases = s.directReleases[covered:]
	if !s.relayDead {
		s.adjust(bytes-min(previous, bytes), at)
	}
	s.mu.Unlock()
	select {
	case s.relayRoom <- struct{}{}:
	default:
	}
}

// adjust counts delivered bytes and, at the end of each epoch, keeps the
// share moving the same way if delivery improved and turns it otherwise.
func (s *striper) adjust(delivered uint64, at time.Time) {
	if s.epochStart.IsZero() {
		s.epochStart = at
		return
	}
	s.epochBytes += delivered
	span := at.Sub(s.epochStart)
	if span < stripeEpoch {
		return
	}
	rate := float64(s.epochBytes) / span.Seconds()
	if rate < s.lastRate {
		s.step = -s.step
	}
	s.lastRate = rate
	s.epochStart, s.epochBytes = at, 0
	s.setShare(s.share + s.step)
}

// failRelay stops using the relay and returns its unacknowledged records
// for the direct path; nil if the relay had already failed.
func (s *striper) failRelay() [][]byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.relayDead {
		return nil
	}
	s.relayDead = true
	s.directCap = directBufferHigh
	records := make([][]byte, 0, len(s.relayUnacked))
	for _, item := range s.relayUnacked {
		records = append(records, item.record)
	}
	s.relayUnacked, s.relayBytes = nil, 0
	return records
}

// startStriping hands both paths to writer goroutines. Call with writeMu
// held, when the direct path first opens.
func (link *recordLink) startStriping(path *directPath) {
	link.stripe = newStriper()
	go link.writeDirect(path)
	go link.writeRelay()
}

// sendReleasableStriped queues a sealed record: data records for either
// path, control records (math.MaxUint64 release) for the direct path.
func (link *recordLink) sendReleasableStriped(record []byte, release uint64) error {
	if release == math.MaxUint64 {
		link.enqueueControl(record)
	} else {
		link.enqueueData(record, release)
	}
	return nil
}

func (link *recordLink) enqueueControl(record []byte) {
	select {
	case link.stripe.control <- record:
	case <-link.stop:
	}
}

func (link *recordLink) enqueueData(record []byte, release uint64) {
	select {
	case link.stripe.data <- stripeItem{record: record, release: release}:
	case <-link.stop:
	}
}

// directHasRoom reports whether the data channel's buffer is under the
// direct path's cap.
func (link *recordLink) directHasRoom(path *directPath) bool {
	link.stripe.mu.Lock()
	limit := link.stripe.directCap
	link.stripe.mu.Unlock()
	return path.channel.BufferedAmount() < limit
}

func (link *recordLink) writeDirect(path *directPath) {
	s := link.stripe
	idleSince := time.Now()
	for {
		var record []byte
		select {
		case <-link.stop:
			return
		case <-path.lost:
			return // directLost already reported it
		case record = <-s.control:
		default:
			if !link.directHasRoom(path) {
				if time.Since(idleSince) > transferIdle {
					link.deliver(linkItem{err: errDirectStalled, direct: true})
					return
				}
				select {
				case <-link.stop:
					return
				case <-path.drained:
				case <-time.After(stripePoll):
				}
				continue
			}
			select {
			case <-link.stop:
				return
			case <-path.lost:
				return
			case record = <-s.control:
			case item := <-s.data:
				record = item.record
				s.mu.Lock()
				s.directReleases = append(s.directReleases, item.release)
				s.mu.Unlock()
			}
		}
		idleSince = time.Now()
		if err := path.send(record); err != nil {
			link.deliver(linkItem{err: err, direct: true})
			return
		}
		link.directBytes.Add(uint64(len(record)))
	}
}

func (link *recordLink) writeRelay() {
	s := link.stripe
	for {
		s.mu.Lock()
		dead, room := s.relayDead, s.relayBytes < s.relayCap
		s.mu.Unlock()
		if dead {
			return
		}
		if !room {
			select {
			case <-link.stop:
				return
			case <-s.relayRoom:
			}
			continue
		}
		var item stripeItem
		select {
		case <-link.stop:
			return
		case item = <-s.data:
		}
		s.mu.Lock()
		if s.relayDead {
			s.mu.Unlock()
			link.enqueueControl(item.record)
			return
		}
		s.relayUnacked = append(s.relayUnacked, item)
		s.relayBytes += uint64(len(item.record))
		s.mu.Unlock()
		err := link.connection.SetWriteDeadline(time.Now().Add(transferIdle))
		if err == nil {
			err = link.connection.WriteMessage(websocket.BinaryMessage, item.record)
		}
		if err != nil {
			link.relayFailed()
			return
		}
		link.relayBytes.Add(uint64(len(item.record)))
	}
}

// relayFailed moves the relay's unacknowledged records to the direct path.
func (link *recordLink) relayFailed() {
	if link.stripe == nil {
		return
	}
	for _, record := range link.stripe.failRelay() {
		link.enqueueControl(record)
	}
}
