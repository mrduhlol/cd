// Package devices implements authenticated paired-device control and LAN discovery.
package devices

import (
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"
)

const Protocol = "cd-device-v1"
const MaxFrame = 16 * 1024
const MaxLifetime = 5 * time.Minute

// MaxClockSkew permits a sender clock ahead of this device without extending
// acceptance of messages or pairing codes that have already expired locally.
const MaxClockSkew = 30 * time.Second
const Sender = "sender"
const Receiver = "receiver"

// Pair is private credential material. Never include it in logs or public device listings.
type Pair struct {
	Version   int      `json:"version"`
	PairID    string   `json:"pairId"`
	Secret    string   `json:"secret"`
	Name      string   `json:"name"`
	RelayURL  string   `json:"relayUrl"`
	LocalURLs []string `json:"localUrls"`
	ExpiresAt int64    `json:"expiresAt"`
}

type Join struct {
	Type              string `json:"type"`
	Protocol          string `json:"protocol"`
	Role              string `json:"role"`
	Token             string `json:"token"`
	SenderTokenHash   string `json:"senderTokenHash,omitempty"`
	ReceiverTokenHash string `json:"receiverTokenHash,omitempty"`
}

// Challenge is fresh for each local socket and carries no admission credential.
type Challenge struct {
	Type     string `json:"type"`
	Protocol string `json:"protocol"`
	Nonce    string `json:"nonce"`
}

// LocalJoin proves possession without exposing the reusable relay admission token.
type LocalJoin struct {
	Type       string `json:"type"`
	Protocol   string `json:"protocol"`
	Role       string `json:"role"`
	LocalProof string `json:"localProof"`
}

func (p Pair) LocalJoin(role, nonce string) (LocalJoin, error) {
	if !validRole(role) {
		return LocalJoin{}, errors.New("invalid role")
	}
	if err := p.Validate(); err != nil {
		return LocalJoin{}, err
	}
	if _, err := decode(nonce, 32); err != nil {
		return LocalJoin{}, err
	}
	key, err := p.derive(role + " local join")
	if err != nil {
		return LocalJoin{}, err
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write([]byte(Protocol + " " + role + " " + p.PairID + " " + nonce))
	return LocalJoin{Type: "join", Protocol: Protocol, Role: role, LocalProof: base64.RawURLEncoding.EncodeToString(mac.Sum(nil))}, nil
}

func randomID(n int) (string, error) {
	b := make([]byte, n)
	_, err := rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b), err
}
func decode(s string, n int) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil || len(b) != n || base64.RawURLEncoding.EncodeToString(b) != s {
		return nil, errors.New("invalid canonical credential encoding")
	}
	return b, nil
}
func validRole(role string) bool { return role == Sender || role == Receiver }
func (p Pair) Validate() error {
	if p.Version != 1 {
		return errors.New("unsupported pair version")
	}
	if _, err := decode(p.PairID, 16); err != nil {
		return err
	}
	if _, err := decode(p.Secret, 32); err != nil {
		return err
	}
	if len(p.Name) == 0 || len(p.Name) > 128 || strings.ContainsAny(p.Name, "\x00\r\n") {
		return errors.New("invalid device name")
	}
	if err := ValidateEndpoint(p.RelayURL, true); err != nil {
		return fmt.Errorf("relay: %w", err)
	}
	if len(p.LocalURLs) > 32 {
		return errors.New("too many local addresses")
	}
	for _, endpoint := range p.LocalURLs {
		if err := ValidateEndpoint(endpoint, true); err != nil {
			return err
		}
		u, _ := url.Parse(endpoint)
		if u.Scheme != "ws" {
			return errors.New("local endpoint must use ws")
		}
	}
	for _, endpoint := range append([]string{p.RelayURL}, p.LocalURLs...) {
		u, _ := url.Parse(endpoint)
		if u.Path != "/ws/devices/v1/"+p.PairID || u.RawQuery != "" || u.Fragment != "" {
			return errors.New("invalid pair endpoint path")
		}
	}
	return nil
}

// ValidateEndpoint requires TLS for public endpoints. Private literal IP addresses
// permit ws; loopback requires an explicit testing/development opt-in.
func ValidateEndpoint(endpoint string, allowLoopback bool) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" || u.User != nil {
		return errors.New("invalid websocket endpoint")
	}
	if u.Scheme == "wss" {
		return nil
	}
	if u.Scheme != "ws" {
		return errors.New("endpoint requires ws or wss")
	}
	ip := net.ParseIP(u.Hostname())
	if ip == nil {
		return errors.New("insecure endpoint must use a literal LAN IP")
	}
	if ip.IsPrivate() || ip.IsLinkLocalUnicast() || (allowLoopback && ip.IsLoopback()) {
		return nil
	}
	return errors.New("public websocket endpoint requires TLS")
}

func NewPair(name, relayOrigin string, localURLs []string, now time.Time) (Pair, error) {
	id, err := randomID(16)
	if err != nil {
		return Pair{}, err
	}
	secret, err := randomID(32)
	if err != nil {
		return Pair{}, err
	}
	origin, err := url.Parse(relayOrigin)
	if err != nil {
		return Pair{}, err
	}
	origin.Path = "/ws/devices/v1/" + id
	origin.RawQuery = ""
	origin.Fragment = ""
	urls := make([]string, 0, len(localURLs))
	for _, endpoint := range localURLs {
		u, err := url.Parse(endpoint)
		if err != nil {
			return Pair{}, err
		}
		u.Path = origin.Path
		u.RawQuery = ""
		u.Fragment = ""
		urls = append(urls, u.String())
	}
	p := Pair{1, id, secret, name, origin.String(), urls, now.Add(MaxLifetime).UnixMilli()}
	return p, p.Validate()
}
func (p Pair) QR() (string, error) {
	if err := p.Validate(); err != nil {
		return "", err
	}
	b, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	return "cdpair://v1#" + base64.RawURLEncoding.EncodeToString(b), nil
}
func ParseQR(s string, now time.Time) (Pair, error) {
	if !strings.HasPrefix(s, "cdpair://v1#") || len(s) > 32768 {
		return Pair{}, errors.New("invalid pairing QR")
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(s, "cdpair://v1#"))
	if err != nil {
		return Pair{}, err
	}
	var p Pair
	if err = json.Unmarshal(b, &p); err != nil {
		return Pair{}, err
	}
	if err = p.Validate(); err != nil {
		return Pair{}, err
	}
	if p.ExpiresAt <= now.UnixMilli() || p.ExpiresAt > now.Add(MaxLifetime+MaxClockSkew).UnixMilli() {
		return Pair{}, errors.New("pairing QR expired or lifetime invalid")
	}
	return p, nil
}
func (p Pair) derive(info string) ([]byte, error) {
	secret, err := decode(p.Secret, 32)
	if err != nil {
		return nil, err
	}
	id, err := decode(p.PairID, 16)
	if err != nil {
		return nil, err
	}
	return hkdf.Key(sha256.New, secret, id, "cd-device-v1 "+info, 32)
}
func (p Pair) Join(role string) (Join, error) {
	if !validRole(role) {
		return Join{}, errors.New("invalid role")
	}
	if err := p.Validate(); err != nil {
		return Join{}, err
	}
	token, err := p.derive(role + " join")
	if err != nil {
		return Join{}, err
	}
	j := Join{Type: "join", Protocol: Protocol, Role: role, Token: base64.RawURLEncoding.EncodeToString(token)}
	if role == Sender {
		s, _ := p.derive(Sender + " join")
		r, _ := p.derive(Receiver + " join")
		sh := sha256.Sum256(s)
		rh := sha256.Sum256(r)
		j.SenderTokenHash = base64.RawURLEncoding.EncodeToString(sh[:])
		j.ReceiverTokenHash = base64.RawURLEncoding.EncodeToString(rh[:])
	}
	return j, nil
}
