package main

import (
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/stun/v4"
	"github.com/pion/webrtc/v4"
)

func TestOfferDoesNotWaitForUnreachableSTUNAfterPublicCandidate(t *testing.T) {
	server, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	silent, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	go func() {
		buffer := make([]byte, 1500)
		for {
			n, remote, err := server.ReadFrom(buffer)
			if err != nil {
				return
			}
			request := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
			if request.Decode() != nil {
				continue
			}
			reply, err := stun.Build(stun.NewTransactionIDSetter(request.TransactionID), stun.BindingSuccess,
				&stun.XORMappedAddress{IP: net.ParseIP("203.0.113.7"), Port: 50000})
			if err == nil {
				_, _ = server.WriteTo(reply.Raw, remote)
			}
		}
	}()
	old := directICEServers
	directICEServers = []webrtc.ICEServer{{URLs: []string{
		"stun:127.0.0.1:" + strconv.Itoa(server.LocalAddr().(*net.UDPAddr).Port),
		"stun:127.0.0.1:" + strconv.Itoa(silent.LocalAddr().(*net.UDPAddr).Port),
	}}}
	defer func() { directICEServers = old }()
	path, err := newDirectPath(func([]byte) {}, func(error) {})
	if err != nil {
		t.Fatal(err)
	}
	defer path.close()
	started := time.Now()
	sdp, err := path.createOffer()
	if err != nil {
		t.Fatal(err)
	}
	elapsed := time.Since(started)
	if !strings.Contains(sdp, "203.0.113.7") || !strings.Contains(sdp, " typ srflx") {
		t.Fatal("offer omitted public candidate")
	}
	if elapsed >= directGatherWait/2 {
		t.Fatalf("usable offer waited for unresponsive STUN: %s", elapsed)
	}
	t.Logf("usable public offer ready in %s", elapsed)
}
