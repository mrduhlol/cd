package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type resumeCapability struct {
	Version     int              `json:"version"`
	Master      string           `json:"master"`
	SenderToken string           `json:"senderToken"`
	Checkpoint  ResumeCheckpoint `json:"checkpoint"`
}

func resumeFailure(message string) error { return NewFailure(failureProtocol, message, retryNever) }

func resumeAtomicJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) > 16384 {
		return resumeFailure("resume metadata exceeds 16 KiB")
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".cd-resume-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if _, err = temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err = temp.Close(); err != nil {
		return err
	}
	if err = os.Rename(temp.Name(), path); err != nil {
		return err
	}
	return resumeSyncDir(filepath.Dir(path))
}
func resumeSyncDir(dir string) error {
	file, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}
func resumeReadJSON(path string, value any) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 16384 || info.Mode().Perm()&0077 != 0 {
		return resumeFailure("resume metadata must be a private regular file of at most 16 KiB")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err = json.Unmarshal(data, value); err != nil {
		return resumeFailure("resume metadata is corrupt")
	}
	return nil
}
func resumeCapabilityPath(id string) (string, error) {
	if !validTransferID(id) {
		return "", resumeFailure("invalid resumable transfer ID")
	}
	dir, err := stateDir()
	if err != nil {
		return "", err
	}
	dir = filepath.Join(dir, "resume")
	if err = os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	return filepath.Join(dir, id+".sender.json"), nil
}
func resumeSourceDigest(source shareSource) (string, error) {
	reader, err := source.open()
	if err != nil {
		return "", err
	}
	defer reader.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(reader, int64(source.size)+1))
	if err != nil {
		return "", err
	}
	if uint64(size) != source.size {
		return "", resumeFailure("source changed while hashing; choose a new transfer")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
func resumeDecode(value string, size int) ([]byte, error) {
	bytes, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(bytes) != size || base64.RawURLEncoding.EncodeToString(bytes) != value {
		return nil, resumeFailure("resume secret or nonce is malformed")
	}
	return bytes, nil
}
func resumeLoadCapability(id string) (resumeCapability, invitation, []byte, error) {
	var cap resumeCapability
	var invite invitation
	path, err := resumeCapabilityPath(id)
	if err != nil {
		return cap, invite, nil, err
	}
	if err = resumeReadJSON(path, &cap); err != nil {
		if os.IsNotExist(err) {
			err = NewFailure(failureNotFound, "local resume capability is unavailable or expired; start a new --resumable transfer", retryNewTransfer, err)
		}
		return cap, invite, nil, err
	}
	master, err := resumeDecode(cap.Master, 32)
	if err != nil {
		return cap, invite, nil, err
	}
	token, err := resumeDecode(cap.SenderToken, 32)
	if err != nil {
		return cap, invite, nil, err
	}
	rawID, err := resumeDecode(id, 16)
	if err != nil {
		return cap, invite, nil, err
	}
	copy(invite.id[:], rawID)
	copy(invite.key[:], master)
	if cap.Version != 2 || cap.Checkpoint.Role != "sender" || cap.Checkpoint.RootID != id {
		return cap, invite, nil, resumeFailure("sender resume identity is inconsistent")
	}
	if err = verifyResumeCheckpoint(cap.Checkpoint, token, time.Now().UnixMilli()); err != nil {
		return cap, invite, nil, err
	}
	return cap, invite, token, nil
}

func resumeDest(name, out, id string) (string, string, error) {
	if !filepath.IsLocal(name) {
		return "", "", resumeFailure("resumable offer filename is unsafe")
	}
	safe, err := safeFilename(name)
	if err != nil || safe != name {
		return "", "", resumeFailure("resumable offer filename is unsafe")
	}
	dest := out
	if dest == "" {
		dest = name
	}
	if info, err := os.Stat(dest); err == nil && info.IsDir() {
		dest = filepath.Join(dest, name)
	}
	absolute, err := filepath.Abs(dest)
	if err != nil {
		return "", "", err
	}
	dir, err := filepath.EvalSymlinks(filepath.Dir(absolute))
	if err != nil {
		return "", "", err
	}
	dest = filepath.Join(dir, filepath.Base(absolute))
	if info, err := os.Lstat(dest); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return "", "", resumeFailure("resume destination is not a regular file")
	}
	return dest, filepath.Join(dir, ".cd-"+id+".checkpoint.json"), nil
}

func resumeStage(checkpoint ResumeCheckpoint, path string) (*os.File, error) {
	if filepath.Base(checkpoint.StagingID) != checkpoint.StagingID || strings.ContainsAny(checkpoint.StagingID, "/\\") || !strings.HasPrefix(checkpoint.StagingID, ".cd-stage-") {
		return nil, resumeFailure("checkpoint staging identity is unsafe")
	}
	stage := filepath.Join(filepath.Dir(path), checkpoint.StagingID)
	info, err := os.Lstat(stage)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, resumeFailure("resume staging is not a private regular file")
	}
	file, err := os.OpenFile(stage, os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		file.Close()
		return nil, resumeFailure("resume staging was replaced")
	}
	if info.Size() < checkpoint.Offset {
		file.Close()
		return nil, resumeFailure("resume staging is truncated")
	}
	hash := sha256.New()
	if _, err = io.CopyN(hash, file, checkpoint.Offset); err != nil {
		file.Close()
		return nil, err
	}
	if hex.EncodeToString(hash.Sum(nil)) != checkpoint.PrefixSHA256 {
		file.Close()
		return nil, resumeFailure("resume staging prefix does not match its authenticated checkpoint")
	}
	if err = file.Truncate(checkpoint.Offset); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}

func resumeRemove(checkpoint ResumeCheckpoint, path string) {
	if filepath.Base(checkpoint.StagingID) == checkpoint.StagingID && strings.HasPrefix(checkpoint.StagingID, ".cd-stage-") {
		_ = os.Remove(filepath.Join(filepath.Dir(path), checkpoint.StagingID))
	}
	_ = os.Remove(path)
}

func resumeCheckOffer(checkpoint ResumeCheckpoint, offer resumeOffer) error {
	if checkpoint.Filename != offer.Name || checkpoint.Size != offer.SizeValue || checkpoint.WholeSHA256 != offer.WholeSHA256 || checkpoint.ExpiresAt != offer.ExpiresAt {
		return resumeFailure("source identity changed; retained progress cannot be resumed")
	}
	return nil
}

// Bounded cleanup validates the sender MAC before deleting expired secrets.
func resumeCleanupCapabilities(now time.Time) {
	dir, err := stateDir()
	if err != nil {
		return
	}
	dir = filepath.Join(dir, "resume")
	directory, err := os.Open(dir)
	if err != nil {
		return
	}
	defer directory.Close()
	entries, _ := directory.ReadDir(128)
	checked := 0
	for _, entry := range entries {
		if checked >= 128 {
			return
		}
		id, ok := strings.CutSuffix(entry.Name(), ".sender.json")
		if !ok || !validTransferID(id) {
			continue
		}
		checked++
		path := filepath.Join(dir, entry.Name())
		var cap resumeCapability
		if resumeReadJSON(path, &cap) != nil || cap.Version != 2 || cap.Checkpoint.RootID != id || cap.Checkpoint.Role != "sender" || cap.Checkpoint.ExpiresAt > now.UnixMilli() {
			continue
		}
		token, err := resumeDecode(cap.SenderToken, 32)
		if err != nil {
			continue
		}
		if verifyResumeCheckpoint(cap.Checkpoint, token, cap.Checkpoint.ExpiresAt-1) == nil {
			_ = os.Remove(path)
		}
	}
}
