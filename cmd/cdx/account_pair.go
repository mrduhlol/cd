package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
)

func sealAccountPair(publicKey, target, pairID, link string) (string, error) {
	encoded, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil {
		return "", err
	}
	parsed, err := x509.ParsePKIXPublicKey(encoded)
	if err != nil {
		return "", err
	}
	public, ok := parsed.(*ecdsa.PublicKey)
	if !ok {
		return "", errors.New("phone encryption key must be P-256")
	}
	remote, err := public.ECDH()
	if err != nil {
		return "", err
	}
	if remote.Curve() != ecdh.P256() {
		return "", errors.New("phone encryption key must be P-256")
	}
	local, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	shared, err := local.ECDH(remote)
	if err != nil {
		return "", err
	}
	key, err := hkdf.Key(sha256.New, shared, []byte(pairID), "cd-account-pair-v1", 32)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	ephemeral, err := x509.MarshalPKIXPublicKey(local.PublicKey())
	if err != nil {
		return "", err
	}
	envelope := map[string]string{"ephemeral": base64.RawURLEncoding.EncodeToString(ephemeral), "nonce": base64.RawURLEncoding.EncodeToString(nonce), "ciphertext": base64.RawURLEncoding.EncodeToString(gcm.Seal(nil, nonce, []byte(link), []byte(target)))}
	b, err := json.Marshal(envelope)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
