package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func TestResumeV2FixtureAndProofs(t *testing.T) {
	var f struct {
		Invitation struct {
			RootID    string `json:"rootId"`
			MasterKey string `json:"masterKey"`
		} `json:"invitation"`
		SessionNonce, ReceiverNonce, Plaintext, Record, ReceiverRecord string
		Checkpoint                                                     ResumeCheckpoint `json:"checkpoint"`
	}
	b, err := os.ReadFile("../../fixtures/resume-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	id, _ := base64.RawURLEncoding.DecodeString(f.Invitation.RootID)
	key, _ := base64.RawURLEncoding.DecodeString(f.Invitation.MasterKey)
	sn, _ := base64.RawURLEncoding.DecodeString(f.SessionNonce)
	rn, _ := base64.RawURLEncoding.DecodeString(f.ReceiverNonce)
	var inv invitation
	copy(inv.id[:], id)
	copy(inv.key[:], key)
	sealer, err := newResumeSealer(inv, sn, rn, senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	record, err := sealer.seal(kindOffer, []byte(f.Plaintext))
	if err != nil {
		t.Fatal(err)
	}
	if got := base64.RawURLEncoding.EncodeToString(record); got != f.Record {
		t.Fatalf("record fixture mismatch: %s", got)
	}
	receiverSealer, err := newResumeSealer(inv, sn, rn, receiverDirection)
	if err != nil {
		t.Fatal(err)
	}
	receiverRecord, err := receiverSealer.seal(kindAccept, []byte(f.Plaintext))
	if err != nil {
		t.Fatal(err)
	}
	if got := base64.RawURLEncoding.EncodeToString(receiverRecord); got != f.ReceiverRecord {
		t.Fatalf("receiver record fixture mismatch: %s", got)
	}
	opener, err := newResumeOpener(inv, sn, rn, senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	kind, plain, err := opener.open(record)
	if err != nil || kind != kindOffer || string(plain) != f.Plaintext {
		t.Fatalf("open: %v %v %q", kind, err, plain)
	}
	proof, err := resumeNonceProof(inv, "sender", sn)
	if err != nil || !verifyResumeNonceProof(inv, "sender", sn, proof) || verifyResumeNonceProof(inv, "receiver", sn, proof) {
		t.Fatal("nonce proof verification failed")
	}
	if base64.RawURLEncoding.EncodeToString(proof) != "hYajIkE11zQHfASd_yQKyvTX_xFC_LvyDFQlCAi80Hs" {
		t.Fatal("nonce proof fixture mismatch")
	}
	token, err := resumeReceiverAdmission(inv)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(token)
	if base64.RawURLEncoding.EncodeToString(token) != "tv3A13vt67jg7N3OmSO-390R19s9pecIXKUhZ0p9IAg" || base64.RawURLEncoding.EncodeToString(digest[:]) != "iLGO6mZeaJglq0Dtlt7gVbXAxzfaRuuTB2EKU9pUzhI" {
		t.Fatal("receiver admission fixture mismatch")
	}
	if err := verifyResumeCheckpoint(f.Checkpoint, key, 0); err != nil {
		t.Fatalf("fixture checkpoint: %v", err)
	}
	if err := signResumeCheckpoint(&f.Checkpoint, key); err != nil || f.Checkpoint.MAC != "yJVZDnrtWoEvWo4Kacni1UcPh8dBmpFV7n6rmnj-v1s" {
		t.Fatal("checkpoint MAC fixture mismatch")
	}
	if err := verifyResumeCheckpoint(f.Checkpoint, key, f.Checkpoint.ExpiresAt); err == nil {
		t.Fatal("expired checkpoint accepted")
	}
}

func TestResumeSealerRejectsOversizedPayload(t *testing.T) {
	sealer, err := newResumeSealer(testInvitation(), make([]byte, 32), make([]byte, 32), senderDirection)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sealer.seal(kindChunk, bytes.Repeat([]byte{1}, maxRecordBytes)); err == nil {
		t.Fatal("oversized resume record accepted")
	}
}
