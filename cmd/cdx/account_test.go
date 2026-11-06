package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

type accountRoundTrip func(*http.Request) (*http.Response, error)

func (f accountRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestAccountRefreshPersistsRotatedCredentials(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	if err := saveAccount(accountTokens{Access: "old-access", Refresh: "old-refresh", ExpiresIn: -1}); err != nil {
		t.Fatal(err)
	}
	prior := accountHTTP
	defer func() { accountHTTP = prior }()
	accountHTTP = &http.Client{Transport: accountRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != clerkIssuer+"/oauth/token" {
			t.Fatal(r.URL)
		}
		if err := r.ParseForm(); err != nil {
			t.Fatal(err)
		}
		if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "old-refresh" || r.Form.Get("client_id") != clerkClientID {
			t.Fatal("wrong refresh request")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600}`))}, nil
	})}
	access, err := accountAccess(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if access != "new-access" {
		t.Fatal(access)
	}
	path, _ := accountTokenPath()
	var saved accountTokens
	if err := resumeReadJSON(path, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.Refresh != "new-refresh" || saved.ExpiresAt < time.Now().Unix()+3500 {
		t.Fatalf("invalid saved refresh: %+v", saved)
	}
}
func TestAccountRejectsPlaintextRelayBeforeSendingToken(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("CD_RELAY_URL", "ws://127.0.0.1:9999/ws/v1")
	t.Setenv("CD_PUBLIC_URL", "http://127.0.0.1:9999")
	if err := saveAccount(accountTokens{Access: "private-access-token", ExpiresIn: 3600}); err != nil {
		t.Fatal(err)
	}
	err := accountRequest(context.Background(), "GET", "", nil, &json.RawMessage{})
	if err == nil || !strings.Contains(err.Error(), "HTTPS") {
		t.Fatalf("wanted HTTPS rejection, got %v", err)
	}
}

func TestAccountPairRejectsInvalidPhoneEncryptionKey(t *testing.T) {
	if _, err := sealAccountPair("invalid", "phone", "pair", "private-link"); err == nil {
		t.Fatal("invalid phone key accepted")
	}
}

func TestAccountPairEncryptsForOnlyTheRegisteredPhone(t *testing.T) {
	data, err := os.ReadFile("../../fixtures/account-pair-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var f map[string]string
	if err = json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	encoded, err := sealAccountPair(f["publicKey"], f["target"], f["pairId"], "cdpair://v1#actual-private-invitation")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(encoded)
	var envelope map[string]string
	if err = json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	decode := func(s string) []byte {
		b, e := base64.RawURLEncoding.DecodeString(s)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	private, err := x509.ParsePKCS8PrivateKey(decode(f["privateKey"]))
	if err != nil {
		t.Fatal(err)
	}
	var local *ecdh.PrivateKey
	switch k := private.(type) {
	case *ecdsa.PrivateKey:
		local, err = k.ECDH()
	case *ecdh.PrivateKey:
		local = k
	default:
		t.Fatal("unexpected fixture key")
	}
	if err != nil {
		t.Fatal(err)
	}
	remote, err := x509.ParsePKIXPublicKey(decode(envelope["ephemeral"]))
	if err != nil {
		t.Fatal(err)
	}
	var public *ecdh.PublicKey
	switch k := remote.(type) {
	case *ecdsa.PublicKey:
		public, err = k.ECDH()
	case *ecdh.PublicKey:
		public = k
	default:
		t.Fatal("unexpected ephemeral key")
	}
	if err != nil {
		t.Fatal(err)
	}
	shared, err := local.ECDH(public)
	if err != nil {
		t.Fatal(err)
	}
	key, err := hkdf.Key(sha256.New, shared, []byte(f["pairId"]), "cd-account-pair-v1", 32)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	opened, err := gcm.Open(nil, decode(envelope["nonce"]), decode(envelope["ciphertext"]), []byte(f["target"]))
	if err != nil {
		t.Fatal(err)
	}
	if string(opened) != "cdpair://v1#actual-private-invitation" {
		t.Fatalf("wrong invitation: %q", opened)
	}
	if _, err = gcm.Open(nil, decode(envelope["nonce"]), decode(envelope["ciphertext"]), []byte("another-phone")); err == nil {
		t.Fatal("invitation accepted by wrong phone")
	}
}
