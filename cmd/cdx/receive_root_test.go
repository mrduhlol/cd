package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Change the directory after acceptance, when the staging file is already open.
// A second file at its old pathname must never become the published payload.
func TestReceivePinsOutputDirectory(t *testing.T) {
	for _, bundle := range []bool{false, true} {
		name := "file"
		if bundle {
			name = "bundle"
		}
		t.Run(name, func(t *testing.T) {
			parent := t.TempDir()
			dir := filepath.Join(parent, "receive")
			moved := filepath.Join(parent, "moved")
			outside := t.TempDir()
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			payload := []byte("REMOTE")
			injected := []byte("INJECTED")
			if bundle {
				payload = reviewZip(t, []string{"offered.zip"}, []string{"REMOTE"})
				injected = reviewZip(t, []string{"offered.zip"}, []string{"INJECTED"})
			}
			err := reviewReceive(t, bundle, payload, dir, func() {
				entries, err := os.ReadDir(dir)
				if err != nil || len(entries) != 1 {
					t.Errorf("staging directory = %v, %v", entries, err)
					return
				}
				if err := os.Rename(dir, moved); err != nil {
					t.Error(err)
					return
				}
				if err := os.Symlink(outside, dir); err != nil {
					t.Error(err)
					return
				}
				if err := os.WriteFile(filepath.Join(outside, entries[0].Name()), injected, 0600); err != nil {
					t.Error(err)
				}
			})
			if err != nil {
				t.Fatalf("receive: %v", err)
			}
			if got, err := os.ReadFile(filepath.Join(moved, "offered.zip")); err != nil || string(got) != "REMOTE" {
				t.Errorf("pinned destination = %q, %v", got, err)
			}
			if _, err := os.Lstat(filepath.Join(outside, "offered.zip")); !os.IsNotExist(err) {
				t.Errorf("published outside selected directory: %v", err)
			}
		})
	}
}

func TestReceiveFilename(t *testing.T) {
	for _, name := range []string{"", ".", "..", "../evil", "/evil", `..\evil`, "a/b", "a\x00b", "line\nbreak", "delete\x7f", string([]byte{0xff})} {
		if got, err := receiveFilename(name); err == nil {
			t.Errorf("accepted %q as %q", name, got)
		}
	}
	for _, name := range []string{"résumé final.bin", "notes..txt", "...", ".hidden", "-flag", "a%2fb.txt"} {
		if got, err := receiveFilename(name); err != nil || got != name {
			t.Errorf("filename %q = %q, %v", name, got, err)
		}
	}
}

func TestReceiveExplicitOutputPath(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "chosen..name")
	if err := reviewReceive(t, false, []byte("REMOTE"), out, nil); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(out); err != nil || string(got) != "REMOTE" {
		t.Fatalf("explicit output = %q, %v", got, err)
	}
}

func TestReceivePreservesLegacyStaging(t *testing.T) {
	dir := t.TempDir()
	legacy := filepath.Join(dir, "offered.zip.cd-part")
	if err := os.WriteFile(legacy, []byte("LOCAL"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := reviewReceive(t, false, []byte("REMOTE"), dir, nil); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(legacy); err != nil || string(got) != "LOCAL" {
		t.Fatalf("legacy staging = %q, %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "offered.zip")); err != nil || string(got) != "REMOTE" {
		t.Fatalf("received file = %q, %v", got, err)
	}
}

func TestReceiveFailedBundleRetention(t *testing.T) {
	for _, collision := range []bool{false, true} {
		name := "free"
		if collision {
			name = "existing archive"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			kept := filepath.Join(dir, "cd-bundle.zip")
			if collision {
				if err := os.WriteFile(kept, []byte("LOCAL"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			payload := []byte("INVALID ZIP")
			if err := reviewReceive(t, true, payload, dir, nil); err == nil {
				t.Fatal("invalid zip was accepted")
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			retained := 0
			for _, entry := range entries {
				got, err := os.ReadFile(filepath.Join(dir, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				if string(got) == string(payload) {
					retained++
				}
			}
			if retained != 1 {
				t.Fatalf("retained %d copies of the failed archive", retained)
			}
			if collision {
				if got, err := os.ReadFile(kept); err != nil || string(got) != "LOCAL" {
					t.Fatalf("existing archive = %q, %v", got, err)
				}
			} else if got, err := os.ReadFile(kept); err != nil || string(got) != string(payload) {
				t.Fatalf("retained archive = %q, %v", got, err)
			}
		})
	}
}

func TestPublishReceivedFileReplacesSymlinkOnlyWithForce(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "victim")
	if err := os.WriteFile(outside, []byte("LOCAL"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "final")); err != nil {
		t.Skip(err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	staging, name, err := createReceiveStaging(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := staging.Write([]byte("REMOTE")); err != nil {
		t.Fatal(err)
	}
	if err := staging.Close(); err != nil {
		t.Fatal(err)
	}
	if err := publishReceivedFile(root, name, "final", false); err == nil {
		t.Fatal("replaced a symlink without force")
	}
	if err := publishReceivedFile(root, name, "final", true); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(outside); err != nil || string(got) != "LOCAL" {
		t.Fatalf("symlink target = %q, %v", got, err)
	}
	if got, err := root.ReadFile("final"); err != nil || string(got) != "REMOTE" {
		t.Fatalf("forced destination = %q, %v", got, err)
	}
}

func TestReceiveDefaultOutputDirectory(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := reviewReceive(t, false, []byte("REMOTE"), "", nil); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(dir, "offered.zip")); err != nil || string(got) != "REMOTE" {
		t.Fatalf("default output = %q, %v", got, err)
	}
}

func TestReceiveFailureCleanupPinsOutputDirectory(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "receive")
	moved := filepath.Join(parent, "moved")
	outside := t.TempDir()
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	var staging string
	err := reviewReceive(t, false, []byte("REMOTE"), dir, func() {
		entries, err := os.ReadDir(dir)
		if err != nil || len(entries) != 1 {
			t.Errorf("staging directory = %v, %v", entries, err)
			return
		}
		staging = entries[0].Name()
		if err := os.Rename(dir, moved); err != nil {
			t.Error(err)
			return
		}
		if err := os.Symlink(outside, dir); err != nil {
			t.Error(err)
			return
		}
		// The new destination makes no-force publication fail in the pinned root.
		for _, path := range []string{filepath.Join(moved, "offered.zip"), filepath.Join(outside, staging)} {
			if err := os.WriteFile(path, []byte("LOCAL"), 0600); err != nil {
				t.Error(err)
			}
		}
	})
	if err == nil {
		t.Fatal("replaced a destination that appeared after acceptance")
	}
	if got, err := os.ReadFile(filepath.Join(moved, "offered.zip")); err != nil || string(got) != "LOCAL" {
		t.Errorf("existing destination = %q, %v", got, err)
	}
	if _, err := os.Lstat(filepath.Join(moved, staging)); !os.IsNotExist(err) {
		t.Errorf("failed receive left staging behind: %v", err)
	}
	if got, err := os.ReadFile(filepath.Join(outside, staging)); err != nil || string(got) != "LOCAL" {
		t.Errorf("cleanup touched replacement directory: %q, %v", got, err)
	}
}
