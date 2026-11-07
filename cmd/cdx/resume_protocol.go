package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
)

const resumeVersion = 2

func resumeDerive(secret, salt []byte, info string) ([]byte, error) {
	return derive(secret, salt, info)
}

func resumeReceiverAdmission(value invitation) ([]byte, error) {
	return resumeDerive(value.key[:], value.id[:], "cd-transfer-v2 receiver join")
}

func resumeNonceProof(value invitation, role string, nonce []byte) ([]byte, error) {
	if role != "sender" && role != "receiver" {
		return nil, errors.New("invalid resume role")
	}
	if len(nonce) != 32 {
		return nil, errors.New("resume nonce must be 32 bytes")
	}
	mac := hmac.New(sha256.New, value.key[:])
	_, _ = mac.Write([]byte("cd-transfer-v2 " + role + " nonce"))
	_, _ = mac.Write(value.id[:])
	_, _ = mac.Write(nonce)
	return mac.Sum(nil), nil
}

func verifyResumeNonceProof(value invitation, role string, nonce, proof []byte) bool {
	expected, err := resumeNonceProof(value, role, nonce)
	return err == nil && hmac.Equal(expected, proof)
}

type resumeRecordSealer struct {
	aead              cipher.AEAD
	id                [16]byte
	session, receiver [32]byte
	direction         direction
	sequence          uint64
}
type resumeRecordOpener struct {
	aead              cipher.AEAD
	id                [16]byte
	session, receiver [32]byte
	direction         direction
	sequence          uint64
}

func resumeAEAD(value invitation, sessionNonce, receiverNonce []byte, dir direction) (cipher.AEAD, error) {
	if dir != senderDirection && dir != receiverDirection {
		return nil, errors.New("invalid resume direction")
	}
	if len(sessionNonce) != 32 || len(receiverNonce) != 32 {
		return nil, errors.New("resume nonces must be 32 bytes")
	}
	salt := append(append(append([]byte{}, value.id[:]...), sessionNonce...), receiverNonce...)
	info := "cd-transfer-v2 sender frames"
	if dir == receiverDirection {
		info = "cd-transfer-v2 receiver frames"
	}
	key, err := resumeDerive(value.key[:], salt, info)
	if err != nil {
		return nil, err
	}
	b, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}
func newResumeSealer(value invitation, sessionNonce, receiverNonce []byte, dir direction) (*resumeRecordSealer, error) {
	a, err := resumeAEAD(value, sessionNonce, receiverNonce, dir)
	if err != nil {
		return nil, err
	}
	r := &resumeRecordSealer{aead: a, id: value.id, direction: dir}
	copy(r.session[:], sessionNonce)
	copy(r.receiver[:], receiverNonce)
	return r, nil
}
func newResumeOpener(value invitation, sessionNonce, receiverNonce []byte, dir direction) (*resumeRecordOpener, error) {
	a, err := resumeAEAD(value, sessionNonce, receiverNonce, dir)
	if err != nil {
		return nil, err
	}
	r := &resumeRecordOpener{aead: a, id: value.id, direction: dir}
	copy(r.session[:], sessionNonce)
	copy(r.receiver[:], receiverNonce)
	return r, nil
}
func resumeNonce(dir direction, seq uint64) []byte {
	n := make([]byte, 12)
	copy(n, "CDS2")
	if dir == receiverDirection {
		copy(n, "CDR2")
	}
	binary.BigEndian.PutUint64(n[4:], seq)
	return n
}
func resumeAAD(header []byte, id [16]byte, s, r [32]byte) []byte {
	out := make([]byte, 0, len(header)+80)
	out = append(out, header...)
	out = append(out, id[:]...)
	out = append(out, s[:]...)
	return append(out, r[:]...)
}
func (s *resumeRecordSealer) seal(kind messageKind, plain []byte) ([]byte, error) {
	if !validKind(s.direction, kind) {
		return nil, NewFailure(failureProtocol, "message kind is invalid for direction", retryNever)
	}
	if s.sequence > uint64(^uint32(0)) {
		return nil, NewFailure(failureProtocol, "record sequence exhausted", retryNever)
	}
	if len(plain) > maxRecordBytes-headerBytes-s.aead.Overhead() {
		return nil, NewFailure(failureProtocol, "record is too large", retryNever)
	}
	h := make([]byte, headerBytes, headerBytes+len(plain)+s.aead.Overhead())
	copy(h, "CD")
	h[2] = 2
	h[3] = byte(kind)
	binary.BigEndian.PutUint32(h[4:8], uint32(s.sequence))
	binary.BigEndian.PutUint32(h[8:12], uint32(len(plain)))
	out := s.aead.Seal(h, resumeNonce(s.direction, s.sequence), plain, resumeAAD(h, s.id, s.session, s.receiver))
	s.sequence++
	return out, nil
}
func (o *resumeRecordOpener) open(record []byte) (messageKind, []byte, error) {
	bad := func(msg string) (messageKind, []byte, error) {
		return 0, nil, NewFailure(failureProtocol, msg, retryNever)
	}
	if len(record) < headerBytes+o.aead.Overhead() || len(record) > maxRecordBytes {
		return bad("record length is invalid")
	}
	h := record[:headerBytes]
	if string(h[:2]) != "CD" || h[2] != 2 {
		return bad("record protocol is invalid")
	}
	kind := messageKind(h[3])
	if !validKind(o.direction, kind) {
		return bad("message kind is invalid for direction")
	}
	seq := binary.BigEndian.Uint32(h[4:8])
	if uint64(seq) != o.sequence {
		return 0, nil, failuref(failureProtocol, retryNever, "record sequence %d, expected %d", seq, o.sequence)
	}
	if uint64(binary.BigEndian.Uint32(h[8:12]))+uint64(headerBytes+o.aead.Overhead()) != uint64(len(record)) {
		return bad("record plaintext length is invalid")
	}
	p, err := o.aead.Open(nil, resumeNonce(o.direction, uint64(seq)), record[headerBytes:], resumeAAD(h, o.id, o.session, o.receiver))
	if err != nil {
		return bad("record authentication failed")
	}
	o.sequence++
	return kind, p, nil
}

type ResumeCheckpoint struct {
	Version           int    `json:"version"`
	Role              string `json:"role"`
	RootID            string `json:"rootId"`
	Filename          string `json:"filename"`
	Size              int64  `json:"size"`
	ChunkSize         int64  `json:"chunkSize"`
	WholeSHA256       string `json:"wholeSha256"`
	Offset            int64  `json:"offset"`
	PrefixSHA256      string `json:"prefixSha256"`
	StagingID         string `json:"stagingId"`
	Destination       string `json:"destination"`
	ExpiresAt         int64  `json:"expiresAt"`
	PriorSessionNonce string `json:"priorSessionNonce"`
	MAC               string `json:"mac"`
}

func checkpointKey(secret []byte, rootID, role string) ([]byte, error) {
	id, err := base64.RawURLEncoding.DecodeString(rootID)
	if err != nil || len(id) != 16 {
		return nil, errors.New("invalid rootId")
	}
	info := "cd-transfer-v2 " + role + " checkpoint"
	return resumeDerive(secret, id, info)
}
func checkpointFields(c ResumeCheckpoint) []string {
	return []string{fmt.Sprint(c.Version), c.Role, c.RootID, c.Filename, fmt.Sprint(c.Size), fmt.Sprint(c.ChunkSize), c.WholeSHA256, fmt.Sprint(c.Offset), c.PrefixSHA256, c.StagingID, c.Destination, fmt.Sprint(c.ExpiresAt), c.PriorSessionNonce}
}
func checkpointBytes(c ResumeCheckpoint) []byte {
	fields := checkpointFields(c)
	out := make([]byte, 0)
	for _, f := range fields {
		b := []byte(f)
		var n [4]byte
		binary.BigEndian.PutUint32(n[:], uint32(len(b)))
		out = append(out, n[:]...)
		out = append(out, b...)
	}
	return out
}
func (c ResumeCheckpoint) validate(now int64) error {
	if c.Version != 2 || (c.Role != "sender" && c.Role != "receiver") || len(c.RootID) != 22 {
		return errors.New("invalid checkpoint identity")
	}
	id, e := base64.RawURLEncoding.DecodeString(c.RootID)
	if e != nil || len(id) != 16 || base64.RawURLEncoding.EncodeToString(id) != c.RootID {
		return errors.New("invalid checkpoint rootId")
	}
	if c.Size < 0 || c.Size > 1<<53-1 || c.Offset < 0 || c.Offset > c.Size || c.ChunkSize != 256*1024 || c.Offset%c.ChunkSize != 0 && c.Offset != c.Size {
		return errors.New("invalid checkpoint offset or size")
	}
	for _, s := range []string{c.WholeSHA256, c.PrefixSHA256} {
		if len(s) != 64 || strings.ToLower(s) != s {
			return errors.New("invalid checkpoint digest")
		}
		if _, e := hex.DecodeString(s); e != nil {
			return errors.New("invalid checkpoint digest")
		}
	}
	if c.ExpiresAt <= now || c.ExpiresAt > 1<<53-1 || len(c.PriorSessionNonce) != 43 {
		return errors.New("expired or invalid checkpoint session")
	}
	nonce, e := base64.RawURLEncoding.DecodeString(c.PriorSessionNonce)
	if e != nil || len(nonce) != 32 || base64.RawURLEncoding.EncodeToString(nonce) != c.PriorSessionNonce {
		return errors.New("invalid checkpoint session nonce")
	}
	if c.Filename == "" || path.Base(c.Filename) != c.Filename || strings.ContainsAny(c.Filename, `/\\`) || c.Filename == "." || c.Filename == ".." {
		return errors.New("invalid checkpoint filename")
	}
	if c.StagingID == "" || path.Base(c.StagingID) != c.StagingID || strings.ContainsAny(c.StagingID, `/\\`) || c.StagingID == "." || c.StagingID == ".." {
		return errors.New("invalid checkpoint stagingId")
	}
	if c.Destination == "" || len(c.Destination) > 8192 || len(c.Filename) > 255 || len(c.StagingID) > 255 {
		return errors.New("invalid checkpoint binding")
	}
	encoded, _ := json.Marshal(c)
	if len(encoded) > 16*1024 {
		return errors.New("checkpoint metadata is too large")
	}
	return nil
}
func signResumeCheckpoint(c *ResumeCheckpoint, secret []byte) error {
	if c == nil {
		return errors.New("nil checkpoint")
	}
	if len(secret) != 32 {
		return errors.New("checkpoint secret must be 32 bytes")
	}
	c.Version = 2
	key, e := checkpointKey(secret, c.RootID, c.Role)
	if e != nil {
		return e
	}
	m := hmac.New(sha256.New, key)
	_, _ = m.Write(checkpointBytes(*c))
	c.MAC = base64.RawURLEncoding.EncodeToString(m.Sum(nil))
	return nil
}
func verifyResumeCheckpoint(c ResumeCheckpoint, secret []byte, now int64) error {
	if len(secret) != 32 {
		return errors.New("checkpoint secret must be 32 bytes")
	}
	if e := c.validate(now); e != nil {
		return e
	}
	key, e := checkpointKey(secret, c.RootID, c.Role)
	if e != nil {
		return e
	}
	m := hmac.New(sha256.New, key)
	_, _ = m.Write(checkpointBytes(c))
	got, e := base64.RawURLEncoding.DecodeString(c.MAC)
	if e != nil || len(got) != sha256.Size || base64.RawURLEncoding.EncodeToString(got) != c.MAC || !hmac.Equal(got, m.Sum(nil)) {
		return errors.New("checkpoint authentication failed")
	}
	return nil
}
