package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestBundleRefusesCompressedEntries(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "bundle.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	writer, err := archive.CreateHeader(&zip.FileHeader{Name: "inflated.txt", Method: zip.Deflate})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = writer.Write(bytes.Repeat([]byte{0}, 1024*1024))
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	dest := t.TempDir()
	if _, err := unpackBundle(archivePath, dest, false); err == nil {
		t.Fatal("compressed bundle was extracted automatically")
	}
	entries, _ := os.ReadDir(dest)
	if len(entries) != 0 {
		t.Fatalf("rejected archive wrote %d entries", len(entries))
	}
}

func TestBundlePreservesUserStagingFile(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "bundle.zip")
	writeTestZip(t, archivePath, map[string]string{"notes.txt": "received"})
	dest := t.TempDir()
	userFile := filepath.Join(dest, "notes.txt.cd-part")
	_ = os.WriteFile(userFile, []byte("USER DATA"), 0600)
	if _, err := unpackBundle(archivePath, dest, false); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(userFile); err != nil || string(data) != "USER DATA" {
		t.Fatalf("user staging file = %q, %v", data, err)
	}
}

func TestBundleRejectsCaseAliasesBeforeWriting(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "bundle.zip")
	writeTestZip(t, archivePath, map[string]string{"README": "first", "readme": "second"})
	dest := t.TempDir()
	if _, err := unpackBundle(archivePath, dest, false); err == nil {
		t.Fatal("case aliases accepted")
	}
	entries, _ := os.ReadDir(dest)
	if len(entries) != 0 {
		t.Fatalf("rejected archive wrote %d entries", len(entries))
	}
}

func TestPublishReceivedFilePreservesDestinationThatAppears(t *testing.T) {
	dir := t.TempDir()
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	staging := filepath.Join(dir, "received.part")
	dest := filepath.Join(dir, "notes.txt")
	_ = os.WriteFile(staging, []byte("received"), 0600)
	_ = os.WriteFile(dest, []byte("USER DATA"), 0600)
	if err := publishReceivedFile(root, "received.part", "notes.txt", false); err == nil {
		t.Fatal("replaced a newly appeared destination")
	}
	if data, _ := os.ReadFile(dest); string(data) != "USER DATA" {
		t.Fatalf("destination = %q", data)
	}
	if err := publishReceivedFile(root, "received.part", "notes.txt", true); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(dest); string(data) != "received" {
		t.Fatalf("forced destination = %q", data)
	}
}

func TestBundleRejectsSymlinkEscape(t *testing.T) {
	dest := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(dest, "linked")); err != nil {
		t.Skip(err)
	}
	archivePath := filepath.Join(t.TempDir(), "bundle.zip")
	writeTestZip(t, archivePath, map[string]string{"linked/escape": "payload"})
	if _, err := unpackBundle(archivePath, dest, true); err == nil {
		t.Fatal("extracted through outside symlink")
	}
	entries, _ := os.ReadDir(outside)
	if len(entries) != 0 {
		t.Fatal("wrote outside output root")
	}
}

func TestBundleRejectsInflatedStoredSizeBeforeWriting(t *testing.T) {
	archivePath := filepath.Join(t.TempDir(), "bundle.zip")
	file, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	archive := zip.NewWriter(file)
	writer, err := archive.CreateRaw(&zip.FileHeader{Name: "inflated.txt", Method: zip.Store, CompressedSize64: 1, UncompressedSize64: 1 << 40})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = writer.Write([]byte{0})
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	dest := t.TempDir()
	if _, err := unpackBundle(archivePath, dest, false); err == nil {
		t.Fatal("inflated stored size accepted")
	}
	entries, _ := os.ReadDir(dest)
	if len(entries) != 0 {
		t.Fatal("invalid archive wrote files")
	}
}
