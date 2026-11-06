package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
)

func TestAndroidLegacyFixtureMatchesCLI(t *testing.T) {
	data, err := os.ReadFile("../../fixtures/transfer-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ ID, Key, Token, Sender, Receiver string }
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	invite := testInvitation()
	if invite.encodedID() != fixture.ID || invite.encodedKey() != fixture.Key {
		t.Fatal("fixture identity changed")
	}
	token, err := invite.receiverToken()
	if err != nil || base64.RawURLEncoding.EncodeToString(token) != fixture.Token {
		t.Fatal("Android admission differs")
	}
	for _, test := range []struct {
		direction direction
		kind      messageKind
		expected  string
	}{
		{senderDirection, kindChunk, fixture.Sender}, {receiverDirection, kindAccept, fixture.Receiver},
	} {
		sealer, err := newSealer(invite, test.direction)
		if err != nil {
			t.Fatal(err)
		}
		record, err := sealer.sealInto(nil, test.kind, []byte("exact bytes"))
		if err != nil || base64.RawURLEncoding.EncodeToString(record) != test.expected {
			t.Fatal("Android record differs")
		}
	}
}
