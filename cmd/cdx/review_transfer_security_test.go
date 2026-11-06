package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// The independent security review sender exercises receiveFile's encrypted wire and disk path.
func reviewReceive(t *testing.T, bundle bool, payload []byte, out string, accepted func()) error {
	t.Helper()
	inv := testReceiveInvitation()
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
		offer, _ := json.Marshal(fileOffer{Name: "offered.zip", MediaType: "application/zip", Size: fmtUint(uint64(len(payload))), ChunkSize: chunkSize, Bundle: bundle})
		send := func(kind messageKind, p []byte) {
			record, e := seal.sealInto(nil, kind, p)
			if e == nil {
				_ = c.WriteMessage(websocket.BinaryMessage, record)
			}
		}
		send(kindOffer, offer)
		_, record, e := c.ReadMessage()
		if e != nil {
			return
		}
		kind, _, e := open.open(record)
		if e != nil || kind != kindAccept {
			return
		}
		if accepted != nil {
			accepted()
		}
		var chunks uint32
		if len(payload) > 0 {
			send(kindChunk, payload)
			chunks = 1
		}
		send(kindEnd, encodeCounts(chunks, uint64(len(payload))))
		for {
			_, record, e = c.ReadMessage()
			if e != nil {
				return
			}
			kind, _, e = open.open(record)
			if e != nil || kind == kindComplete {
				return
			}
		}
	}))
	defer server.Close()
	t.Setenv("CD_RELAY_URL", "ws"+strings.TrimPrefix(server.URL, "http")+"/ws/v1")
	t.Setenv("CD_PUBLIC_URL", server.URL)
	t.Setenv("CD_DIRECT", "0")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return receiveFile(ctx, inv.encodedID()+"#v1."+inv.encodedKey(), out, false, nil)
}

func fmtUint(n uint64) string { return fmt.Sprintf("%d", n) }

func reviewZip(t *testing.T, names, contents []string) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for i, name := range names {
		w, e := z.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if e != nil {
			t.Fatal(e)
		}
		_, _ = w.Write([]byte(contents[i]))
	}
	if e := z.Close(); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}

func TestReviewBundleStagingMustNotFollowSymlink(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(t.TempDir(), "victim")
	_ = os.WriteFile(victim, []byte("KEEP"), 0600)
	if e := os.Symlink(victim, filepath.Join(dir, "cd-bundle.zip.cd-part")); e != nil {
		t.Fatal(e)
	}
	err := reviewReceive(t, true, reviewZip(t, []string{"ok.txt"}, []string{"hello"}), dir, nil)
	got, _ := os.ReadFile(victim)
	if string(got) != "KEEP" {
		t.Fatalf("outside file changed, receive err=%v, bytes=%d", err, len(got))
	}
}

func TestReviewExtractionMustPreserveUnrelatedStaging(t *testing.T) {
	dir := t.TempDir()
	victim := filepath.Join(dir, "a.txt.cd-part")
	_ = os.WriteFile(victim, []byte("KEEP"), 0600)
	archive := filepath.Join(t.TempDir(), "in.zip")
	_ = os.WriteFile(archive, reviewZip(t, []string{"a.txt"}, []string{"hello"}), 0600)
	_, err := unpackBundle(archive, dir, false)
	got, e := os.ReadFile(victim)
	if e != nil || string(got) != "KEEP" {
		t.Fatalf("unrelated staging changed or removed: data=%q readErr=%v unpackErr=%v", got, e, err)
	}
}

func TestReviewReceiveMustRecheckDestination(t *testing.T) {
	out := filepath.Join(t.TempDir(), "received.txt")
	err := reviewReceive(t, false, []byte("REMOTE"), out, func() { _ = os.WriteFile(out, []byte("LOCAL"), 0600) })
	got, _ := os.ReadFile(out)
	if string(got) != "LOCAL" {
		t.Fatalf("no-force receive overwrote new destination, got=%q err=%v", got, err)
	}
}

func TestReviewExtractionMustRejectAliasedTargets(t *testing.T) {
	dir := t.TempDir()
	_ = os.Mkdir(filepath.Join(dir, "real"), 0755)
	if e := os.Symlink("real", filepath.Join(dir, "alias")); e != nil {
		t.Fatal(e)
	}
	archive := filepath.Join(t.TempDir(), "in.zip")
	_ = os.WriteFile(archive, reviewZip(t, []string{"real/a.txt", "alias/a.txt"}, []string{"FIRST", "SECOND"}), 0600)
	files, err := unpackBundle(archive, dir, false)
	got, _ := os.ReadFile(filepath.Join(dir, "real/a.txt"))
	if string(got) == "SECOND" {
		t.Fatalf("second archive entry overwrote first: got=%q files=%d err=%v", got, len(files), err)
	}
}

func TestReviewExtractionMustPreserveEveryArchiveMember(t *testing.T) {
	dir := t.TempDir()
	archive := filepath.Join(t.TempDir(), "in.zip")
	_ = os.WriteFile(archive, reviewZip(t, []string{"a.txt.cd-part", "a.txt"}, []string{"FIRST", "SECOND"}), 0600)
	files, err := unpackBundle(archive, dir, false)
	got, e := os.ReadFile(filepath.Join(dir, "a.txt.cd-part"))
	if e != nil || string(got) != "FIRST" {
		t.Fatalf("archive member lost: got=%q readErr=%v files=%d unpackErr=%v", got, e, len(files), err)
	}
}

func TestReviewContainmentRejectsExternalParent(t *testing.T) {
	dir := t.TempDir()
	outside := t.TempDir()
	victim := filepath.Join(outside, "a.txt")
	_ = os.WriteFile(victim, []byte("KEEP"), 0600)
	if e := os.Symlink(outside, filepath.Join(dir, "escape")); e != nil {
		t.Fatal(e)
	}
	archive := filepath.Join(t.TempDir(), "in.zip")
	_ = os.WriteFile(archive, reviewZip(t, []string{"escape/a.txt"}, []string{"REMOTE"}), 0600)
	_, err := unpackBundle(archive, dir, true)
	got, _ := os.ReadFile(victim)
	if err == nil || string(got) != "KEEP" {
		t.Fatalf("containment failed: data=%q err=%v", got, err)
	}
}
