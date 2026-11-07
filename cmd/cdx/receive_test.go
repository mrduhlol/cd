package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testReceiveInvitation() invitation {
	var value invitation
	for index := range value.id {
		value.id[index] = byte(index + 1)
	}
	for index := range value.key {
		value.key[index] = byte(index + 64)
	}
	return value
}

func TestParseInvitationInputAcceptsFullLinkAndBareCode(t *testing.T) {
	value := testReceiveInvitation()
	link := "https://cd.yash0.in/s/" + value.encodedID() + "#v1." + value.encodedKey()
	code := value.encodedID() + "#v1." + value.encodedKey()

	for _, input := range []string{link, code, "send this: " + link + " please"} {
		parsed, err := parseInvitationInput(input)
		if err != nil {
			t.Fatalf("input %q: %v", input, err)
		}
		if parsed != value {
			t.Fatalf("input %q did not round-trip", input)
		}
	}
}

func TestParseInvitationInputAcceptsLocalDevLink(t *testing.T) {
	value := testReceiveInvitation()
	link := "http://127.0.0.1:8787/s/" + value.encodedID() + "#v1." + value.encodedKey()
	if _, err := parseInvitationInput(link); err != nil {
		t.Fatalf("local link: %v", err)
	}
}

func TestParseInvitationInputRejectsGarbage(t *testing.T) {
	for _, input := range []string{"", "river-cloud", "https://cd.yash0.in/s/short#v1.key", "AAAAAAAAAAAAAAAAAAAAAA#v1.short"} {
		if _, err := parseInvitationInput(input); err == nil {
			t.Fatalf("accepted %q", input)
		}
	}
}

func TestParseReceivedOfferValidatesBrowserContract(t *testing.T) {
	offer := fileOffer{Name: "résumé final.bin", MediaType: "application/octet-stream", Size: "12345", ChunkSize: chunkSize}
	payload, err := json.Marshal(offer)
	if err != nil {
		t.Fatal(err)
	}
	parsed, size, err := parseReceivedOffer(payload)
	if err != nil || parsed.Name != offer.Name || size != 12345 {
		t.Fatalf("valid offer = %#v, %d, %v", parsed, size, err)
	}
	bad := []fileOffer{
		{Name: "../evil", MediaType: "application/octet-stream", Size: "1", ChunkSize: chunkSize},
		{Name: "ok.bin", MediaType: "", Size: "1", ChunkSize: chunkSize},
		{Name: "ok.bin", MediaType: "application/octet-stream", Size: "-5", ChunkSize: chunkSize},
		{Name: "ok.bin", MediaType: "application/octet-stream", Size: "1", ChunkSize: 1024},
	}
	for _, item := range bad {
		payload, _ := json.Marshal(item)
		if _, _, err := parseReceivedOffer(payload); err == nil {
			t.Fatalf("accepted offer %#v", item)
		}
	}
}

func TestResolveReceiveDestRefusesOverwriteWithoutForce(t *testing.T) {
	dir := t.TempDir()
	existing := filepath.Join(dir, "file.bin")
	if err := os.WriteFile(existing, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, out := range []string{existing, dir} {
		if dest, err := resolveReceiveDest("file.bin", out, false); err == nil {
			_ = dest.root.Close()
			t.Fatalf("%q overwrote without --force", out)
		}
		dest, err := resolveReceiveDest("file.bin", out, true)
		if err != nil {
			t.Fatal(err)
		}
		defer dest.root.Close()
		if dest.dir != dir || dest.name != "file.bin" {
			t.Fatalf("force destination = %q / %q", dest.dir, dest.name)
		}
	}
}

func TestParseReceiveArgsSupportsOutAndForce(t *testing.T) {
	request, err := parseReceiveArgs([]string{"--out", "dir/", "--force", "code#v1.key"})
	if err != nil || request.out != "dir/" || !request.force || request.code != "code#v1.key" {
		t.Fatalf("request = %#v, %v", request, err)
	}
	request, err = parseReceiveArgs([]string{"--out=dir/", "code#v1.key", "--json"})
	if err != nil || request.out != "dir/" || !request.jsonOutput {
		t.Fatalf("equals form = %#v, %v", request, err)
	}
	if _, err := parseReceiveArgs([]string{}); err == nil {
		t.Fatal("missing code was accepted")
	}
	if _, err := parseReceiveArgs([]string{"a", "b"}); err == nil {
		t.Fatal("two codes were accepted")
	}
	if _, err := parseReceiveArgs([]string{"--out"}); err == nil {
		t.Fatal("bare --out was accepted")
	}
	if help, err := parseReceiveArgs([]string{"--help"}); err != nil || !help.help {
		t.Fatalf("help = %#v, %v", help, err)
	}
}

func TestRunReceiveRejectsUsageErrorsWithStatus2(t *testing.T) {
	if status := run([]string{"receive"}); status != 2 {
		t.Fatalf("status = %d", status)
	}
	if status := run([]string{"receive", "a", "b"}); status != 2 {
		t.Fatalf("status = %d", status)
	}
}

func TestIsShortCodeAcceptsFourOrFiveDigits(t *testing.T) {
	for _, code := range []string{"4829", "48291", "  48291  "} {
		if !isShortCode(code) {
			t.Fatalf("rejected %q", code)
		}
	}
	for _, bad := range []string{"", "482", "123456", "48a91", "river-cloud", "https://cd.yash0.in/s/AAAAAAAAAAAAAAAAAAAAAA#v1." + strings.Repeat("A", 43)} {
		if isShortCode(bad) {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func testCodeDirectory(t *testing.T, value invitation) *httptest.Server {
	t.Helper()
	handler := http.NewServeMux()
	handler.HandleFunc("/api/codes", func(writer http.ResponseWriter, request *http.Request) {
		var claim codeClaimRequest
		if err := json.NewDecoder(request.Body).Decode(&claim); err != nil {
			t.Error(err)
		}
		if claim.TransferID != value.encodedID() || claim.Key != value.encodedKey() {
			http.Error(writer, "invalid claim", http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(writer).Encode(codeClaimResponse{Code: "48291"})
	})
	handler.HandleFunc("/api/codes/48291", func(writer http.ResponseWriter, request *http.Request) {
		_ = json.NewEncoder(writer).Encode(codeLookupResponse{TransferID: value.encodedID(), Key: value.encodedKey()})
	})
	return httptest.NewServer(handler)
}

func TestClaimAndLookupShareCodeRoundTrip(t *testing.T) {
	value := testReceiveInvitation()
	server := testCodeDirectory(t, value)
	defer server.Close()
	ctx := context.Background()
	code, err := claimShareCode(ctx, server.URL, value.encodedID(), value.encodedKey())
	if err != nil || code != "48291" {
		t.Fatalf("claim = %q, %v", code, err)
	}
	found, err := lookupShareCode(ctx, server.URL, code)
	if err != nil || found != value {
		t.Fatalf("lookup = %#v, %v", found, err)
	}
}

func TestLookupShareCodeMapsMissingToBadCode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Error(writer, "code unavailable", http.StatusNotFound)
	}))
	defer server.Close()
	if _, err := lookupShareCode(context.Background(), server.URL, "00000"); err == nil ||
		!strings.Contains(err.Error(), "Bad code") && !strings.Contains(err.Error(), "bad code") {
		t.Fatalf("missing code = %v", err)
	}
}

func TestShortCodeFromLink(t *testing.T) {
	for input, want := range map[string]string{
		"https://cd.yash0.in/#48291":  "48291",
		" https://cd.yash0.in#4829 ":  "4829",
		"https://cd.yash0.in/#abcde":  "",
		"https://cd.yash0.in/s/#4829": "",
		"48291":                       "",
	} {
		if got := shortCodeFromLink(input); got != want {
			t.Errorf("shortCodeFromLink(%q) = %q, want %q", input, got, want)
		}
	}
}
