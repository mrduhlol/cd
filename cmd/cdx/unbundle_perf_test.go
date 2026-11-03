package main

import (
	"crypto/sha256"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// CD_UNPACK_SOURCE points at a frozen real directory, never generated padding.
func BenchmarkUnpackSourceTree(b *testing.B) {
	source := os.Getenv("CD_UNPACK_SOURCE")
	if source == "" {
		b.Skip("set CD_UNPACK_SOURCE to a real source directory")
	}
	bundle, err := prepareBundle([]string{source})
	if err != nil {
		b.Fatal(err)
	}
	reader, err := bundle.open()
	if err != nil {
		b.Fatal(err)
	}
	archivePath := filepath.Join(b.TempDir(), "source.zip")
	archive, err := os.Create(archivePath)
	if err != nil {
		b.Fatal(err)
	}
	if _, err := io.Copy(archive, reader); err != nil {
		b.Fatal(err)
	}
	_ = reader.Close()
	if err := archive.Close(); err != nil {
		b.Fatal(err)
	}
	want := map[string][32]byte{}
	if err := filepath.WalkDir(source, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(filepath.Dir(source), path)
		want[relative] = sha256.Sum256(data)
		return err
	}); err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		b.StopTimer()
		dest := b.TempDir()
		b.StartTimer()
		files, err := unpackBundle(archivePath, dest, false)
		b.StopTimer()
		if err != nil || len(files) != len(want) {
			b.Fatalf("extract: %d files, %v", len(files), err)
		}
		for _, file := range files {
			data, err := os.ReadFile(file.Path)
			if err != nil || sha256.Sum256(data) != want[filepath.FromSlash(file.Filename)] {
				b.Fatalf("file mismatch: %s: %v", file.Filename, err)
			}
		}
		if err := os.RemoveAll(dest); err != nil {
			b.Fatal(err)
		}
		b.StartTimer()
	}
}

func TestUnpackReusesBufferAcrossLargeAndSmallEntries(t *testing.T) {
	contents := map[string]string{"large.go": strings.Repeat("package source\n", 5000), "tail.txt": "tail"}
	archivePath := filepath.Join(t.TempDir(), "files.zip")
	writeTestZip(t, archivePath, contents)
	dest := t.TempDir()
	files, err := unpackBundle(archivePath, dest, false)
	if err != nil || len(files) != len(contents) {
		t.Fatalf("extract: %d files, %v", len(files), err)
	}
	for name, want := range contents {
		got, err := os.ReadFile(filepath.Join(dest, name))
		if err != nil || string(got) != want {
			t.Fatalf("extracted %s differs: %v", name, err)
		}
	}
}
