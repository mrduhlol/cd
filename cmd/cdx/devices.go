package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/YashasVM/cd/internal/devices"
)

func deviceStore() (devices.Store, error) {
	dir := os.Getenv("CD_DEVICE_DIR")
	if dir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return devices.Store{}, err
		}
		dir = filepath.Join(base, "cdx", "devices")
	}
	return devices.Store{Dir: dir}, nil
}

type deviceRuntime struct {
	pair      devices.Pair
	listener  net.Listener
	server    *http.Server
	control   *devices.Server
	mu        sync.Mutex
	transfer  *localResume
	localBase string
}

func localOrigins(port int, advertised string) ([]string, error) {
	hosts := []string{}
	if advertised != "" {
		ip := net.ParseIP(advertised)
		if ip == nil || !(ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()) {
			return nil, errors.New("advertised host must be a literal LAN IP")
		}
		hosts = append(hosts, ip.String())
	} else {
		addresses, err := net.InterfaceAddrs()
		if err != nil {
			return nil, err
		}
		for _, address := range addresses {
			ip, _, err := net.ParseCIDR(address.String())
			if err == nil && ip.To4() != nil && ip.IsPrivate() {
				hosts = append(hosts, ip.String())
			}
		}
		if len(hosts) == 0 {
			hosts = append(hosts, "127.0.0.1")
		}
	}
	out := []string{}
	seen := map[string]bool{}
	for _, host := range hosts {
		if !seen[host] {
			out = append(out, "ws://"+net.JoinHostPort(host, strconv.Itoa(port)))
			seen[host] = true
		}
	}
	return out, nil
}

func startDeviceRuntime(ctx context.Context, pair devices.Pair, listener net.Listener, origins []string) (*deviceRuntime, error) {
	control, err := devices.NewServer(pair)
	if err != nil {
		return nil, err
	}
	runtime := &deviceRuntime{pair: pair, listener: listener, control: control, localBase: origins[0]}
	mux := http.NewServeMux()
	mux.Handle("/ws/devices/v1/", control)
	mux.HandleFunc("/ws/v2/", func(w http.ResponseWriter, r *http.Request) {
		runtime.mu.Lock()
		handler := runtime.transfer
		runtime.mu.Unlock()
		if handler == nil {
			http.NotFound(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})
	runtime.server = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 8192}
	go runtime.server.Serve(listener)
	port := listener.Addr().(*net.TCPAddr).Port
	go devices.Advertise(ctx, pair.PairID, port)
	return runtime, nil
}
func (r *deviceRuntime) close() {
	r.mu.Lock()
	if r.transfer != nil {
		r.transfer.Close()
	}
	r.mu.Unlock()
	r.control.Close()
	r.server.Close()
}
func (r *deviceRuntime) arm(invite invitation, expiry int64) *localResume {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.transfer != nil {
		r.transfer.Close()
	}
	r.transfer = newLocalResume(invite, expiry)
	return r.transfer
}

type deviceMessage struct {
	peer    *devices.Peer
	local   bool
	message devices.Message
}

func deviceConnections(ctx context.Context, runtime *deviceRuntime) <-chan deviceMessage {
	messages := make(chan deviceMessage, 32)
	codec, _ := devices.NewCodec(runtime.pair, devices.Sender)
	port := runtime.listener.Addr().(*net.TCPAddr).Port
	endpoints := []string{"ws://127.0.0.1:" + strconv.Itoa(port) + "/ws/devices/v1/" + runtime.pair.PairID, runtime.pair.RelayURL}
	for index, endpoint := range endpoints {
		go func(local bool, endpoint string) {
			for ctx.Err() == nil {
				var peer *devices.Peer
				var err error
				if local {
					peer, err = devices.DialLocal(ctx, endpoint, runtime.pair, devices.Sender, codec)
				} else {
					peer, err = devices.Dial(ctx, endpoint, runtime.pair, devices.Sender, codec)
				}
				if err == nil {
					// Drain protocol events independently from authenticated application messages.
					go func() {
						for range peer.Events {
						}
					}()
					for {
						m, readErr := peer.Receive(ctx)
						if readErr != nil {
							break
						}
						select {
						case messages <- deviceMessage{peer, local, m}:
						case <-ctx.Done():
							peer.Close()
							return
						}
					}
					peer.Close()
				}
				select {
				case <-ctx.Done():
					return
				case <-time.After(time.Second):
				}
			}
		}(index == 0, endpoint)
	}
	return messages
}

func pairedDeviceName(model string, existing []devices.DeviceSummary) string {
	var b strings.Builder
	for _, r := range model {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		} else if b.Len() > 0 && !strings.HasSuffix(b.String(), "-") {
			b.WriteByte('-')
		}
		if b.Len() >= 48 {
			break
		}
	}
	base := strings.Trim(b.String(), "-")
	if base == "" {
		base = "Android"
	}
	used := map[string]bool{}
	for _, device := range existing {
		used[device.Name] = true
	}
	name := base
	for n := 2; used[name]; n++ {
		name = fmt.Sprintf("%s-%d", base, n)
	}
	return name
}

func runPair(args []string) int {
	flags := flag.NewFlagSet("pair", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	name := flags.String("name", "", "optional alias; defaults to the phone device name")
	account := flags.Bool("account", false, "pair with a phone signed into your Clerk account")
	listen := flags.String("listen", "0.0.0.0:53318", "local address to listen on")
	advertised := flags.String("advertise-host", "", "explicit LAN address for QR or emulator development")
	jsonOutput := flags.Bool("json", false, "print a machine-readable pairing QR")
	qrPath := flags.String("qr", "", "save pairing QR PNG")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: cdx pair [--name phone] [--qr pairing.png]")
		return 2
	}
	store, err := deviceStore()
	if err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	if *name != "" {
		if _, err = store.Load(*name); err == nil {
			return deviceFailure(fmt.Errorf("device %q already paired; forget it before pairing again", *name), *jsonOutput)
		} else if !errors.Is(err, os.ErrNotExist) {
			return deviceFailure(err, *jsonOutput)
		}
	}
	relay, _, err := endpointBase()
	if err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	defer listener.Close()
	origins, err := localOrigins(listener.Addr().(*net.TCPAddr).Port, *advertised)
	if err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	hostname, _ := os.Hostname()
	if hostname == "" {
		hostname = "Laptop"
	}
	pair, err := devices.NewPair(hostname, relay, origins, time.Now())
	if err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	ctx, cancel := context.WithDeadline(ctx, time.UnixMilli(pair.ExpiresAt))
	defer cancel()
	runtime, err := startDeviceRuntime(ctx, pair, listener, origins)
	if err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	defer runtime.close()
	incoming := deviceConnections(ctx, runtime)
	if *account {
		pair.AccountSubject, err = accountIdentity(ctx)
		if err != nil {
			return deviceFailure(err, *jsonOutput)
		}
	}
	qr, err := pair.QR()
	if err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	if *account {
		var directory struct {
			Phones []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				PublicKey string `json:"publicKey"`
			} `json:"phones"`
		}
		if err = accountRequest(ctx, "GET", "", nil, &directory); err != nil {
			return deviceFailure(err, *jsonOutput)
		}
		target := ""
		publicKey := ""
		for _, phone := range directory.Phones {
			if phone.Name == *name || (*name == "" && len(directory.Phones) == 1) {
				*name = phone.Name
				target = phone.ID
				publicKey = phone.PublicKey
			}
		}
		if target == "" {
			return deviceFailure(fmt.Errorf("no account device named %q; sign in and enable account receiving on your phone", *name), *jsonOutput)
		}
		envelope, sealErr := sealAccountPair(publicKey, target, pair.PairID, qr)
		if sealErr != nil {
			return deviceFailure(sealErr, *jsonOutput)
		}
		if err = accountRequest(ctx, "POST", "/pair", map[string]string{"id": pair.PairID, "target": target, "envelope": envelope}, nil); err != nil {
			return deviceFailure(err, *jsonOutput)
		}
		defer accountRequest(context.Background(), "DELETE", "/pair", map[string]string{"id": pair.PairID}, nil)
		fmt.Fprintln(os.Stderr, "Waiting for account device", *name)
	}
	ready := readyOutput{URL: qr}
	if err = saveReadyQR(&ready, *qrPath); err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	if *account {
		// Account receiving imports the invitation privately over authenticated HTTPS.
	} else if *jsonOutput {
		err = json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 1, "phase": "pairing", "name": *name, "qr": qr, "qrPath": ready.QRPath, "expiresAt": pair.ExpiresAt})
	} else {
		fmt.Fprintln(os.Stdout, "Open CD on your phone, scan this QR, and approve this laptop.")
		writeTerminalQR(os.Stdout, ready)
		if ready.QRPath != "" {
			fmt.Fprintln(os.Stdout, "QR saved to", ready.QRPath)
		}
	}
	if err != nil {
		return deviceFailure(err, *jsonOutput)
	}
	for {
		select {
		case <-ctx.Done():
			if *account && errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return 3
			}
			return deviceFailure(fmt.Errorf("pairing stopped or expired: %w", ctx.Err()), *jsonOutput)
		case result := <-incoming:
			if result.message.Type != "paired" {
				continue
			}
			pair.Name = result.message.Name
			if *name == "" {
				existing, listErr := store.List()
				if listErr != nil {
					return deviceFailure(listErr, *jsonOutput)
				}
				*name = pairedDeviceName(pair.Name, existing)
			}
			if err = store.Save(*name, pair); err != nil {
				return deviceFailure(err, *jsonOutput)
			}
			if *jsonOutput {
				json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 1, "phase": "paired", "name": *name, "deviceName": pair.Name, "pairId": pair.PairID})
			} else {
				fmt.Fprintf(os.Stdout, "Paired %s. Send with: cdx send --to %q <file>\n", pair.Name, *name)
			}
			return 0
		}
	}
}
func deviceFailure(err error, jsonOutput bool) int {
	reportFailure(os.Stdout, os.Stderr, NewFailure(failureProtocol, err.Error(), retryNever, err), jsonOutput)
	return 1
}
func runDevices(args []string) int {
	store, err := deviceStore()
	if err != nil {
		return deviceFailure(err, false)
	}
	jsonOutput := false
	rest := []string{}
	for _, arg := range args {
		if arg == "--json" {
			jsonOutput = true
		} else {
			rest = append(rest, arg)
		}
	}
	if len(rest) == 2 && rest[0] == "forget" {
		if err = store.Forget(rest[1]); err != nil {
			return deviceFailure(err, jsonOutput)
		}
		if jsonOutput {
			json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 1, "forgotten": rest[1]})
		} else {
			fmt.Fprintln(os.Stdout, "Forgot", rest[1])
		}
		return 0
	}
	if len(rest) != 0 {
		fmt.Fprintln(os.Stderr, "usage: cdx devices [--json] | cdx devices forget <name>")
		return 2
	}
	list, err := store.List()
	if err != nil {
		return deviceFailure(err, jsonOutput)
	}
	if jsonOutput {
		json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 1, "devices": list})
	} else {
		for _, device := range list {
			fmt.Fprintf(os.Stdout, "%s\t%s\n", device.Name, device.DeviceName)
		}
		if len(list) == 0 {
			fmt.Fprintln(os.Stdout, "No paired devices. Run cdx pair.")
		}
	}
	return 0
}

func runDeviceSend(request sendRequest) int {
	if request.requestID != "" {
		return deviceFailure(errors.New("targeted sends do not support --request-id"), request.jsonOutput)
	}
	if shouldDetach(request, isTerminal(os.Stdout)) {
		if err := validateSourcePaths(request.files); err != nil {
			return deviceFailure(err, request.jsonOutput)
		}
		args := []string{"send", "--to", request.to, "--wait", "--json"}
		if request.resumeID != "" {
			args = append(args, "--resume", request.resumeID)
		}
		args = append(args, "--")
		args = append(args, request.files...)
		return runBackgroundTransfer(args, request.jsonOutput, "device-send")
	}
	store, err := deviceStore()
	if err != nil {
		return deviceFailure(err, request.jsonOutput)
	}
	pair, err := store.Load(request.to)
	if errors.Is(err, os.ErrNotExist) {
		for {
			code := runPair([]string{"--account", "--name", request.to, "--listen", "0.0.0.0:0"})
			if code == 3 {
				fmt.Fprintln(os.Stderr, "Phone is offline. Renewing private pairing invitation.")
				continue
			}
			if code != 0 {
				return code
			}
			break
		}
		pair, err = store.Load(request.to)
	}
	if err != nil {
		return deviceFailure(fmt.Errorf("load paired device %q: %w", request.to, err), request.jsonOutput)
	}
	if pair.AccountSubject != "" {
		subject, authErr := accountIdentity(context.Background())
		if authErr != nil {
			return deviceFailure(authErr, request.jsonOutput)
		}
		if subject != pair.AccountSubject {
			return deviceFailure(errors.New("this device belongs to a different Clerk account; forget and pair it again"), request.jsonOutput)
		}
	}
	if err = validateSourcePaths(request.files); err != nil {
		reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput)
		return 1
	}
	pendingPath, err := devicePendingPath(pair.PairID, request.files)
	if err != nil {
		return deviceFailure(err, request.jsonOutput)
	}
	if request.resumeID == "" {
		request.resumeID, err = loadDevicePending(pendingPath)
		if err != nil {
			return deviceFailure(err, request.jsonOutput)
		}
		if request.resumeID != "" {
			fmt.Fprintln(os.Stderr, "Resuming retained transfer", request.resumeID)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	listenAddress := os.Getenv("CD_DEVICE_LISTEN")
	if listenAddress == "" {
		listenAddress = "0.0.0.0:53318"
	}
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		return deviceFailure(err, request.jsonOutput)
	}
	defer listener.Close()
	advertised := os.Getenv("CD_DEVICE_ADVERTISE_HOST")
	origins, err := localOrigins(listener.Addr().(*net.TCPAddr).Port, advertised)
	if err != nil {
		return deviceFailure(err, request.jsonOutput)
	}
	runtime, err := startDeviceRuntime(ctx, pair, listener, origins)
	if err != nil {
		return deviceFailure(err, request.jsonOutput)
	}
	defer runtime.close()
	incoming := deviceConnections(ctx, runtime)
	var activeID atomic.Value
	activeID.Store("")
	peerInbox := make(chan deviceMessage, 32)
	receipts := make(chan string, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case m := <-incoming:
				if m.message.Type == "paused" && m.message.TransferID == activeID.Load().(string) {
					stop()
					return
				}

				if m.message.Type == "received" && m.message.TransferID == activeID.Load().(string) {
					select {
					case receipts <- m.message.TransferID:
					default:
					}
					continue
				}
				if m.message.Type == "paired" {
					select {
					case peerInbox <- m:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()
	var current deviceMessage
	var remoteCandidate *deviceMessage

	awaitPeer := func() error {
		wakeCtx, stopWake := context.WithCancel(ctx)
		defer stopWake()
		go deviceWakeLoop(wakeCtx, pair)
		var err error
		current, remoteCandidate, err = awaitDevicePeer(ctx, peerInbox, remoteCandidate)
		return err
	}
	fmt.Fprintf(os.Stderr, "Waiting for %s. Keep Receive from trusted devices enabled in CD.\n", request.to)
	if err = awaitPeer(); err != nil {
		return deviceFailure(err, request.jsonOutput)
	}
	var lastID string
	request.deviceConnect = func(callCtx context.Context, invite invitation, senderToken []byte, expiry int64, ready readyOutput, digest string) (*resumeSession, error) {
		wakeCtx, stopWake := context.WithCancel(callCtx)
		defer stopWake()
		go deviceWakeLoop(wakeCtx, pair)
		lastID = invite.encodedID()
		if err := saveDevicePending(pendingPath, lastID, expiry); err != nil {
			return nil, err
		}
		activeID.Store(lastID)
		local := runtime.arm(invite, expiry)
		// Development verification can force the internet data path while
		// retaining authenticated LAN control and discovery.
		localEnabled := os.Getenv("CD_DEVICE_LAN") != "0"
		useLAN := current.local && localEnabled
		var localSessions <-chan *resumeSession
		if localEnabled {
			localSessions = local.Sessions
		}
		offer := devices.Message{Type: "offer", TransferID: ready.TransferID, URL: ready.URL, Filename: ready.Filename, Size: strconv.FormatUint(ready.Size, 10), WholeSHA256: digest}
		route := "internet relay"
		if useLAN {
			route = "local network"
			offer.LocalURL = runtime.localBase + "/ws/v2/" + ready.TransferID
		}
		if request.jsonOutput {
			json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 2, "phase": "sending", "transferId": lastID, "device": request.to, "filename": ready.Filename, "size": ready.Size, "route": route})
		} else {
			fmt.Fprintf(os.Stderr, "Sending %s to %s over %s.\n", ready.Filename, request.to, route)
		}
		if useLAN {
			if err := current.peer.Send(offer); err != nil {
				if err = awaitPeer(); err != nil {
					return nil, err
				}
				return nil, NewFailure(failureDisconnected, "device reconnected; retrying", retrySameRequest)
			}
		}
		connection := current
		remoteCtx, cancel := context.WithCancel(callCtx)
		type result struct {
			session *resumeSession
			err     error
		}
		remote := make(chan result)
		go func() {
			if useLAN {
				select {
				case <-remoteCtx.Done():
					return
				case <-time.After(time.Second):
				}
			}
			session, connectErr := resumeConnectWithExpiry(remoteCtx, invite, "sender", senderToken, expiry, func(accepted int64) error {
				if accepted != expiry {
					return resumeFailure("relay does not support paired transfer expiry; update relay")
				}
				if !useLAN {
					return connection.peer.Send(offer)
				}
				return nil
			})
			select {
			case remote <- result{session, connectErr}:
			case <-remoteCtx.Done():
				if session != nil {
					session.close()
				}
			}
		}()

		admissionTimeout := time.NewTimer(30 * time.Second)
		defer admissionTimeout.Stop()
		for {
			select {
			case replacement := <-peerInbox:
				if !replacement.local {
					copy := replacement
					remoteCandidate = &copy
					if current.local && current.peer.Alive() {
						continue
					}
				}
				current = replacement
				retryOffer := offer
				if replacement.local && localEnabled {
					retryOffer.LocalURL = runtime.localBase + "/ws/v2/" + ready.TransferID
				} else {
					retryOffer.LocalURL = ""
				}
				_ = replacement.peer.Send(retryOffer)
			case <-admissionTimeout.C:
				cancel()
				return nil, NewFailure(failureDisconnected, "phone did not open the transfer; retrying offer", retrySameRequest)
			case session := <-localSessions:
				cancel()
				return session, nil
			case r := <-remote:
				if r.err != nil {
					cancel()
					if useLAN {
						remote = nil
						continue
					}
					return nil, r.err
				}
				r.session.onClose = cancel
				return r.session, nil
			case <-callCtx.Done():
				cancel()
				return nil, callCtx.Err()
			}
		}
	}
	for {
		activeID.Store("")
		var receivedID string
		err, receivedID = sendDeviceAttempt(ctx, request, receipts)
		if err != nil && receivedID != "" {
			confirmed, receiptErr := finishDeviceReceipt(pendingPath, receivedID, request.files)
			if receiptErr != nil {
				return deviceFailure(receiptErr, request.jsonOutput)
			}
			if confirmed {
				err = nil
			}
		}
		if err == nil {
			_ = os.Remove(pendingPath)
			if request.jsonOutput {
				json.NewEncoder(os.Stdout).Encode(map[string]any{"version": 2, "phase": "verified", "transferId": lastID, "device": request.to})
			}
			return 0
		}
		if ctx.Err() != nil {
			reportFailure(os.Stdout, os.Stderr, NewFailure(failureCanceled, "transfer paused; rerun the same command to retain progress", retrySameRequest, ctx.Err()), request.jsonOutput)
			return 1
		}
		var failure *Failure
		if errors.As(err, &failure) && failure.Kind != failureDisconnected && failure.Kind != failureNetwork && failure.Kind != failureTimeout {
			if errors.Is(err, errResumeSessionLimit) {
				if resetErr := resetExhaustedDevicePending(pendingPath); resetErr != nil {
					return deviceFailure(resetErr, request.jsonOutput)
				}
			}
			reportFailure(os.Stdout, os.Stderr, err, request.jsonOutput)
			return 1
		}
		request.resumeID = lastID
		fmt.Fprintf(os.Stderr, "Connection interrupted: %v. Retrying retained progress.\n", err)
		select {
		case <-ctx.Done():
			return 1
		case <-time.After(2 * time.Second):
		}
	}
}

var errDeviceReceived = errors.New("trusted receiver already verified this transfer")

// Wait for source validation before a paired receipt can finish this attempt.
// Canceling its context interrupts both admission and an active v2 socket.
func sendDeviceAttempt(ctx context.Context, request sendRequest, receipts <-chan string) (error, string) {
	attempt, cancel := context.WithCancelCause(ctx)
	validated := make(chan string, 1)
	connect := request.deviceConnect
	request.deviceConnect = func(callCtx context.Context, invite invitation, token []byte, expiry int64, ready readyOutput, digest string) (*resumeSession, error) {
		validated <- invite.encodedID()
		return connect(callCtx, invite, token, expiry, ready, digest)
	}
	done := make(chan struct{})
	var receivedID string
	go func() {
		defer close(done)
		var expected string
		select {
		case expected = <-validated:
		case <-attempt.Done():
			return
		}
		for {
			select {
			case id := <-receipts:
				if id == expected {
					receivedID = id
					cancel(errDeviceReceived)
					return
				}
			case <-attempt.Done():
				return
			}
		}
	}()
	err := sendResumable(attempt, request)
	cancel(nil)
	<-done
	return err, receivedID
}

const deviceLocalGrace = 3 * time.Second

// Android retries cached LAN endpoints every2.5s, so give that attempt time to
// arrive before committing to an otherwise available internet connection.
func awaitDevicePeer(ctx context.Context, incoming <-chan deviceMessage, prior *deviceMessage) (deviceMessage, *deviceMessage, error) {
	var remote *deviceMessage
	if prior != nil && prior.peer.Alive() {
		remote = prior
	}
	var timer *time.Timer
	var grace <-chan time.Time
	arm := func() {
		if timer == nil {
			timer = time.NewTimer(deviceLocalGrace)
			grace = timer.C
		}
	}
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	if remote != nil {
		arm()
	}
	for {
		select {
		case <-ctx.Done():
			return deviceMessage{}, remote, ctx.Err()
		case <-grace:
			if remote.peer.Alive() {
				return *remote, remote, nil
			}
			remote = nil
			grace = nil
			timer = nil
		case result := <-incoming:
			if result.message.Type != "paired" {
				continue
			}
			if result.local {
				return result, remote, nil
			}
			copy := result
			remote = &copy
			arm()
		}
	}
}
