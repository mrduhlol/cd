package main

import (
	"bytes"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	qrcode "github.com/skip2/go-qrcode"
)

func TestSendQRArgs(t *testing.T) {
	for _, args := range [][]string{
		{"--qr", "receive.png", "file.txt"},
		{"file.txt", "--qr=receive.png", "--json"},
	} {
		request, err := parseSendArgs(args)
		if err != nil || request.qrPath != "receive.png" || len(request.files) != 1 || request.files[0] != "file.txt" {
			t.Fatalf("parse %v = %#v, %v", args, request, err)
		}
	}
	for _, args := range [][]string{{"file.txt", "--qr"}, {"file.txt", "--qr="}, {"file.txt", "--qr", "--json"}} {
		if _, err := parseSendArgs(args); err == nil {
			t.Fatalf("accepted missing QR path: %v", args)
		}
	}
	request, err := parseSendArgs([]string{"--", "--qr"})
	if err != nil || request.qrPath != "" || request.files[0] != "--qr" {
		t.Fatalf("double dash: %#v, %v", request, err)
	}
}

func TestQRContainsReceiveLinkAndQuietZone(t *testing.T) {
	t.Setenv("CD_PUBLIC_URL", "https://custom.example/")
	for _, code := range []string{"48291", ""} {
		ready := readyOutput{Code: code, URL: "https://custom.example/s/id#v1.secret"}
		wantLink := ready.URL
		if code != "" {
			wantLink = "https://custom.example/#48291"
		}
		if got := receiveLink(ready); got != wantLink {
			t.Fatalf("QR link = %q, want %q", got, wantLink)
		}
		path := filepath.Join(t.TempDir(), "receive.png")
		if err := saveReadyQR(&ready, path); err != nil {
			t.Fatal(err)
		}
		if ready.QRPath != path {
			t.Fatalf("QR path = %q", ready.QRPath)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		img, err := png.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		qr, err := qrcode.New(wantLink, qrcode.Medium)
		if err != nil {
			t.Fatal(err)
		}
		bitmap := qr.Bitmap()
		if img.Bounds().Dx() != len(bitmap)*8 || img.Bounds().Dy() != len(bitmap)*8 {
			t.Fatalf("unexpected PNG size: %v", img.Bounds())
		}
		for y, row := range bitmap {
			for x, black := range row {
				r, _, _, _ := img.At(x*8+4, y*8+4).RGBA()
				if (r == 0) != black {
					t.Fatalf("PNG module %d,%d differs from receive link", x, y)
				}
			}
		}
		if err := saveReadyQR(&ready, path); err == nil {
			t.Fatal("overwrote an existing QR")
		}
		after, _ := os.ReadFile(path)
		if !bytes.Equal(after, data) {
			t.Fatal("existing QR changed")
		}
		var terminal bytes.Buffer
		writeTerminalQR(&terminal, ready)
		if !strings.Contains(terminal.String(), "Scan to receive") || !strings.Contains(terminal.String(), "▀") {
			t.Fatalf("terminal QR missing: %q", terminal.String())
		}
	}
}

func TestQRSaveFailureAndOptOut(t *testing.T) {
	ready := readyOutput{Code: "48291"}
	if err := saveReadyQR(&ready, ""); err != nil || ready.QRPath != "" {
		t.Fatalf("without --qr: %#v, %v", ready, err)
	}
	if err := saveReadyQR(&ready, filepath.Join(t.TempDir(), "missing", "qr.png")); err == nil || ready.QRPath != "" {
		t.Fatalf("bad output directory: %#v, %v", ready, err)
	}
}
