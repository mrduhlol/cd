package main

import (
	"archive/zip"
	"crypto/rand"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// resolveBundleDir picks the folder a multi-file send unpacks into: --out
// when given (created if missing), else the current directory.
func resolveBundleDir(out string) (string, error) {
	if out == "" {
		return ".", nil
	}
	info, err := os.Stat(out)
	if err == nil {
		if !info.IsDir() {
			return "", failuref(failureExists, retryNever, "%q is a file: several files are coming, so pass a folder to --out", out)
		}
		return out, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return "", failuref(failureLocal, retryNever, "cannot use %q: %s", out, underlyingReason(err))
	}
	if err := os.MkdirAll(out, 0o755); err != nil {
		return "", failuref(failureLocal, retryNever, "cannot create %q: %s", out, underlyingReason(err))
	}
	return out, nil
}

// bundleEntryPath validates a zip entry name and returns it as a local,
// slash-separated path. Senders only produce plain relative names, so
// anything else is refused rather than repaired.
func bundleEntryPath(name string) (string, bool) {
	if name == "" || !utf8.ValidString(name) || strings.Contains(name, `\`) {
		return "", false
	}
	for _, character := range name {
		if character < 0x20 || character == 0x7f {
			return "", false
		}
	}
	clean := strings.TrimSuffix(name, "/")
	if clean == "" || path.Clean(clean) != clean || !filepath.IsLocal(filepath.FromSlash(clean)) {
		return "", false
	}
	for _, part := range strings.Split(clean, "/") {
		if len(part) > 255 {
			return "", false
		}
	}
	return clean, true
}

// unpackBundle extracts a received bundle into dir, one file at a time.
// Preflight rejects known name clashes before extraction. Each file is
// published without replacement unless force is set. os.Root confines writes.
func unpackBundle(archivePath, dir string, force bool) ([]receivedFile, error) {
	archive, err := os.Open(archivePath)
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, failuref(failureLocal, retryNever, "cannot write to %q: %s", dir, underlyingReason(err))
	}
	defer root.Close()
	return unpackBundleFile(archive, root, dir, force)
}

// The receiver passes its open staging file and output root so a directory
// rename cannot redirect archive reads or extraction to a different directory.
func unpackBundleFile(file *os.File, root *os.Root, dir string, force bool) ([]receivedFile, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	archive, err := zip.NewReader(file, info.Size())
	if err != nil {
		return nil, NewFailure(failureProtocol, "the sender's files could not be unpacked", retryNever)
	}
	if len(archive.File) > 10_000 {
		return nil, NewFailure(failureProtocol, "the sender offered too many files", retryNever)
	}

	type target struct {
		file *zip.File
		name string
	}
	var files []target
	var folders []string
	seen := map[string]bool{}
	var expanded uint64
	for _, entry := range archive.File {
		name, ok := bundleEntryPath(entry.Name)
		key := strings.ToLower(name)
		if !ok || seen[key] || strings.Count(name, "/") > 64 {
			return nil, NewFailure(failureProtocol, "the sender offered an unsafe filename", retryNever)
		}
		seen[key] = true
		mode := entry.Mode()
		switch {
		case mode.IsDir():
			folders = append(folders, name)
		case mode.IsRegular():
			if entry.Method != zip.Store || entry.CompressedSize64 != entry.UncompressedSize64 || entry.UncompressedSize64 > uint64(info.Size())-expanded {
				return nil, NewFailure(failureProtocol, "the sender's files could not be unpacked", retryNever)
			}
			expanded += entry.UncompressedSize64
			if !force {
				if _, err := root.Lstat(filepath.FromSlash(name)); err == nil {
					return nil, failuref(failureExists, retryNever, "%q already exists in %s: use --out <folder> or --force to overwrite", name, dir)
				}
			}
			files = append(files, target{file: entry, name: name})
		default:
			return nil, NewFailure(failureProtocol, "the sender offered an unsupported file type", retryNever)
		}
	}

	for _, folder := range folders {
		if err := root.MkdirAll(filepath.FromSlash(folder), 0o755); err != nil {
			return nil, failuref(failureLocal, retryNever, "cannot create %q: %s", folder, underlyingReason(err))
		}
	}
	absolute, _ := filepath.Abs(dir)
	received := make([]receivedFile, 0, len(files))
	for _, item := range files {
		local := filepath.FromSlash(item.name)
		if parent := filepath.Dir(local); parent != "." {
			if err := root.MkdirAll(parent, 0o755); err != nil {
				return received, failuref(failureLocal, retryNever, "cannot create %q: %s", parent, underlyingReason(err))
			}
		}
		if err := extractEntry(root, item.file, local, force); err != nil {
			return received, err
		}
		received = append(received, receivedFile{Filename: item.name, Size: item.file.UncompressedSize64, Path: filepath.Join(absolute, local)})
	}
	return received, nil
}

func extractEntry(root *os.Root, entry *zip.File, local string, force bool) error {
	source, err := entry.Open()
	if err != nil {
		return NewFailure(failureProtocol, "the sender's files could not be unpacked", retryNever)
	}
	defer source.Close()
	permissions := fs.FileMode(0o644)
	if entry.Mode()&0o111 != 0 {
		permissions = 0o755
	}
	staging := filepath.Join(filepath.Dir(local), ".cd-"+rand.Text()+".part")
	output, err := root.OpenFile(staging, os.O_CREATE|os.O_EXCL|os.O_WRONLY, permissions)
	if err != nil {
		return failuref(failureLocal, retryNever, "cannot write %q: %s", local, underlyingReason(err))
	}
	// zip's reader checks each entry's size and CRC as it reaches EOF.
	written, copyErr := io.Copy(output, io.LimitReader(source, int64(entry.UncompressedSize64)+1))
	if copyErr == nil && uint64(written) != entry.UncompressedSize64 {
		copyErr = zip.ErrFormat
	}
	closeErr := output.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil {
		if force {
			copyErr = root.Rename(staging, local)
		} else {
			copyErr = root.Link(staging, local)
			if copyErr == nil {
				_ = root.Remove(staging)
			}
		}
	}
	if copyErr != nil {
		_ = root.Remove(staging)
		if errors.Is(copyErr, zip.ErrChecksum) || errors.Is(copyErr, zip.ErrFormat) {
			return NewFailure(failureProtocol, "the sender's files could not be unpacked", retryNever)
		}
		return failuref(failureLocal, retryNever, "save %q: %s", local, underlyingReason(copyErr))
	}
	return nil
}
