package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCompressedChunksRoundTripAndRawFallback(t *testing.T) {
	text, err := os.ReadFile("sender.go")
	if err != nil {
		t.Fatal(err)
	}
	random := make([]byte, largeChunkSize)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	var packed bytes.Buffer
	zip := gzip.NewWriter(&packed)
	_, _ = zip.Write(bytes.Repeat(text, 30))
	_ = zip.Close()
	for name, raw := range map[string][]byte{"source": bytes.Repeat(text, 10), "random": random, "archive": packed.Bytes(), "tail": []byte("a")} {
		t.Run(name, func(t *testing.T) {
			var compressor chunkCompressor
			var decompressor chunkDecompressor
			defer decompressor.close()
			for i := 0; i < 2; i++ {
				framed := append([]byte{0}, raw...)
				encoded, err := compressor.encode(framed)
				if err != nil {
					t.Fatal(err)
				}
				if name == "source" && encoded[0] != 1 {
					t.Fatal("did not compress source")
				}
				if name == "random" && (encoded[0] != 0 || &encoded[0] != &framed[0]) {
					t.Fatal("random data did not retain raw storage")
				}
				got, err := decompressor.decode(encoded, largeChunkSize)
				if err != nil || !bytes.Equal(got, raw) {
					t.Fatalf("roundtrip: %v", err)
				}
			}
		})
	}
}

func TestCompressedChunksRejectInvalidAndOversizedData(t *testing.T) {
	var compressor chunkCompressor
	good, _ := compressor.encode(append([]byte{0}, bytes.Repeat([]byte("source file contents\n"), 10000)...))
	if good[0] != 1 {
		t.Fatal("fixture uncompressed")
	}
	changed := func(size uint32) []byte {
		b := append([]byte(nil), good...)
		binary.BigEndian.PutUint32(b[1:5], size)
		return b
	}
	cases := [][]byte{nil, {0}, {1}, {2, 3}, {1, 0, 0, 0, 1, 0}, good[:len(good)-1], append(append([]byte(nil), good...), 0), changed(largeChunkSize + 1), changed(1), changed(210001), changed(0), append([]byte{0}, make([]byte, largeChunkSize+1)...)}
	for i, b := range cases {
		var decoder chunkDecompressor
		if _, err := decoder.decode(b, largeChunkSize); err == nil {
			t.Errorf("invalid case %d accepted", i)
		}
		decoder.close()
	}
	// A rejected stream must not leave stale bytes in a subsequent valid record.
	var decoder chunkDecompressor
	defer decoder.close()
	_, _ = decoder.decode(good[:len(good)-1], largeChunkSize)
	got, err := decoder.decode(good, largeChunkSize)
	if err != nil || len(got) != 210000 {
		t.Fatalf("recovery after malformed record: %d %v", len(got), err)
	}
}

func TestCompressionNegotiationRejectsUnadvertisedAndUnknown(t *testing.T) {
	payload := []byte(`{"chunkSize":262144,"compression":"deflate-v1"}`)
	if _, err := acceptedTransfer(payload, 0, false, ""); err == nil {
		t.Fatal("accepted unoffered compression")
	}
	if _, err := acceptedTransfer(payload, 0, false, transferCompression); err != nil {
		t.Fatal(err)
	}
	if _, err := acceptedTransfer([]byte(`{"chunkSize":262144,"compression":"other"}`), 0, false, transferCompression); err == nil {
		t.Fatal("accepted unknown compression")
	}
	selection, err := acceptedTransfer(nil, largeChunkSize, false, transferCompression)
	if err != nil || selection.Compression != "" {
		t.Fatal("legacy acceptance changed")
	}
}

func TestNegotiatedCompressionAcrossEncryptedRelay(t *testing.T) {
	t.Setenv("CD_COMPRESSION", "1")
	sender, receiver, _ := linkedPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	text, err := os.ReadFile("sender.go")
	if err != nil {
		t.Fatal(err)
	}
	original := bytes.Repeat(text, 50)
	done := make(chan error, 1)
	go func() {
		done <- transfer(ctx, sender, bytes.NewReader(original), readyOutput{Filename: "source.go", Size: uint64(len(original))}, nil, sendHooks{})
	}()
	kind, payload, err := receiver.next(ctx, time.Second)
	if err != nil || kind != kindOffer {
		t.Fatalf("offer: %v", err)
	}
	offer, size, err := parseReceivedOffer(payload)
	if err != nil || offer.Compression != transferCompression {
		t.Fatalf("offer: %v", err)
	}
	selected, _ := receiveChunkSelection(offer)
	acceptance, _ := json.Marshal(chunkAcceptance{ChunkSize: selected, Compression: transferCompression})
	if err := receiver.send(kindAccept, acceptance); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	var chunks uint32
	compressed := false
	var decoder chunkDecompressor
	defer decoder.close()
	for {
		kind, payload, err = receiver.next(ctx, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if kind == kindEnd {
			break
		}
		if kind != kindChunk {
			t.Fatalf("kind %d", kind)
		}
		compressed = compressed || payload[0] == 1
		raw, err := decoder.decode(payload, selected)
		if err != nil {
			t.Fatal(err)
		}
		if err := validateReceivedChunk(raw, selected, uint64(output.Len()), size); err != nil {
			t.Fatal(err)
		}
		output.Write(raw)
		chunks++
		if err := receiver.send(kindAck, encodeCounts(chunks, uint64(output.Len()))); err != nil {
			t.Fatal(err)
		}
	}
	endChunks, endBytes, err := decodeCounts(payload)
	if err != nil || endChunks != chunks || endBytes != size || !compressed || !bytes.Equal(output.Bytes(), original) {
		t.Fatal("compressed transfer changed bytes or counts")
	}
	if err := receiver.send(kindComplete, encodeCounts(chunks, size)); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func BenchmarkChunkCompression(b *testing.B) {
	text, err := os.ReadFile("sender.go")
	if err != nil {
		b.Fatal(err)
	}
	source := bytes.Repeat(text, 1+largeChunkSize/len(text))[:largeChunkSize]
	random := make([]byte, largeChunkSize)
	_, _ = rand.Read(random)
	var packed bytes.Buffer
	zip := gzip.NewWriter(&packed)
	_, _ = zip.Write(source)
	_ = zip.Close()
	for name, raw := range map[string][]byte{"source": source, "random": random, "archive": packed.Bytes()} {
		b.Run(name, func(b *testing.B) {
			var c chunkCompressor
			framed := append([]byte{0}, raw...)
			b.SetBytes(int64(len(raw)))
			b.ReportAllocs()
			b.ResetTimer()
			var total int64
			for range b.N {
				encoded, err := c.encode(framed)
				if err != nil {
					b.Fatal(err)
				}
				total += int64(len(encoded))
			}
			b.ReportMetric(float64(total)/float64(b.N*len(raw)), "wire/raw")
		})
	}
}

func TestReceiveCompressedFileAndRejectInflatedLimit(t *testing.T) {
	t.Setenv("CD_COMPRESSION", "1")
	for _, invalid := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid", true: "oversized"}[invalid], func(t *testing.T) {
			inv := testReceiveInvitation()
			raw := bytes.Repeat([]byte("a real text file line with some repeated words\n"), 4000)
			var compressor chunkCompressor
			encoded, err := compressor.encode(append([]byte{0}, raw...))
			if err != nil || encoded[0] != 1 {
				t.Fatal("fixture")
			}
			if invalid {
				binary.BigEndian.PutUint32(encoded[1:5], chunkSize+1)
			}
			upgrader := websocket.Upgrader{}
			done := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(done)
				c, err := upgrader.Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer c.Close()
				_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
				var join map[string]string
				if c.ReadJSON(&join) != nil {
					return
				}
				_ = c.WriteJSON(map[string]string{"type": "accepted", "protocol": "cd-transfer-v1"})
				seal, _ := newSealer(inv, senderDirection)
				open, _ := newOpener(inv, receiverDirection)
				send := func(kind messageKind, p []byte) {
					record, e := seal.sealInto(nil, kind, p)
					if e == nil {
						_ = c.WriteMessage(websocket.BinaryMessage, record)
					}
				}
				offer, _ := json.Marshal(fileOffer{Name: "text.txt", MediaType: "text/plain", Size: fmtUint(uint64(len(raw))), ChunkSize: chunkSize, Compression: transferCompression})
				send(kindOffer, offer)
				_, record, e := c.ReadMessage()
				if e != nil {
					return
				}
				kind, p, e := open.open(record)
				if e != nil || kind != kindAccept {
					t.Error("missing acceptance")
					return
				}
				var selection chunkAcceptance
				if json.Unmarshal(p, &selection) != nil || selection.Compression != transferCompression {
					t.Error("receiver did not negotiate compression")
					return
				}
				send(kindChunk, encoded)
				send(kindEnd, encodeCounts(1, uint64(len(raw))))
				for {
					_, record, e = c.ReadMessage()
					if e != nil {
						return
					}
					kind, p, e = open.open(record)
					if e != nil {
						return
					}
					if kind == kindComplete {
						chunks, n, e := decodeCounts(p)
						if e != nil || chunks != 1 || n != uint64(len(raw)) {
							t.Error("completion used compressed byte counts")
						}
						return
					}
				}
			}))
			defer server.Close()
			t.Setenv("CD_RELAY_URL", "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/v1")
			t.Setenv("CD_PUBLIC_URL", server.URL)
			t.Setenv("CD_DIRECT", "0")
			out := filepath.Join(t.TempDir(), "received.txt")
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			err = receiveFile(ctx, inv.encodedID()+"#v1."+inv.encodedKey(), out, false, nil)
			<-done
			if invalid {
				if err == nil {
					t.Fatal("received oversized compressed record")
				}
				if _, e := os.Stat(out); !os.IsNotExist(e) {
					t.Fatal("published invalid transfer")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(out)
			if err != nil || !bytes.Equal(got, raw) {
				t.Fatalf("saved file differs: %v", err)
			}
		})
	}
}
