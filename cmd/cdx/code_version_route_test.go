package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDirectoryReceiveRouting(t *testing.T) {
	for _, version := range []int{0, 1, 2, 3} {
		t.Run(string(rune('0'+version)), func(t *testing.T) {
			invite := testReceiveInvitation()
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/api/codes/48291" {
					t.Errorf("path = %s", r.URL.Path)
				}
				json.NewEncoder(w).Encode(codeLookupResponse{TransferID: invite.encodedID(), Key: invite.encodedKey(), Version: version})
			}))
			defer server.Close()
			t.Setenv("CD_PUBLIC_URL", server.URL)
			t.Setenv("CD_RELAY_URL", strings.Replace(server.URL, "http:", "ws:", 1)+"/ws/v1")
			got, err := resolveReceiveCode(context.Background(), "48291")
			if calls != 1 {
				t.Fatalf("lookups = %d", calls)
			}
			if version == 3 {
				if err == nil {
					t.Fatal("unknown version accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			var decoded invitation
			if version == 2 {
				if !strings.Contains(got, "#v2.") {
					t.Fatalf("v2 dispatch missing: %s", got)
				}
				decoded, err = resumeInvitation(got)
			} else {
				decoded, err = parseInvitationInput(got)
			}
			if err != nil || decoded != invite {
				t.Fatalf("route = %v, %v", decoded, err)
			}
		})
	}
}
