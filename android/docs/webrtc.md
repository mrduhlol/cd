# Native WebRTC transport

CD pins `io.github.webrtc-sdk:android:150.7871.01`, published on Maven Central by the [webrtc-sdk Android project](https://github.com/webrtc-sdk/android/tree/v150.7871.01). This is a maintained distribution of native WebRTC, rather than the discontinued `org.webrtc:google-webrtc` coordinate.

The publisher's [release workflow](https://github.com/webrtc-sdk/android/blob/v150.7871.01/.github/workflows/publish.yml) downloads its [GitHub release AAR](https://github.com/webrtc-sdk/android/releases/tag/v150.7871.01), applies its documented [Java class version transformation](https://github.com/webrtc-sdk/android/blob/v150.7871.01/tools/downgrade_class_version.py), and publishes the AAR to Maven Central. The project's [artifact-fetch workflow](https://github.com/webrtc-sdk/android/blob/v150.7871.01/.github/workflows/fetch-webrtc-artifacts.yml) identifies `webrtc-sdk/webrtc-build` as the native artifact producer.

Verified on 2026-10-18:

- Maven AAR SHA-256: `0a1627b1a48c2bc17d9a40d62fc47bd45166f44a311e95917f147c402de379b0`.
- Publisher release AAR SHA-256: `8ad5e5fd02f0177743ddb566bea329006bef7689b944f6351717cd1d018958c0`, matching its GitHub release asset digest.
- Every native library for arm64-v8a, armeabi-v7a, x86_64, and x86 is byte-identical between Maven and the publisher release.
- Every Java class is byte-identical after changing only a class-file header above major61 down to major61, exactly as the publisher script specifies. Non-class entries match too.

Gradle verification metadata pins the Maven AAR and POM checksums. Existing dependency groups retain their prior trust behavior. To repeat artifact verification after Gradle resolution:

```sh
python3 scripts/verify-webrtc.py
python3 scripts/verify-webrtc.py --release-aar /path/to/publisher/libwebrtc.aar
```

This verifies published artifacts and their documented transformation. It does not claim an independently reproducible build of Chromium's C++ sources.

## Data and ordering

The reliable ordered, negotiated data channel is `cd-direct`, ID1. It carries only encrypted v2 CHUNK records, fragmented into messages of at most64KiB. The assembler checks the v2 header and bounded record length before allocating and feeds complete ciphertext into the same eight-record bounded inbox as the WebSocket. One consumer authenticates records and enforces their shared sequence.

OFFER, durable ACK, END, and COMPLETE remain on the relay. The Go sender drains every outstanding relay ACK at a durable batch boundary before switching chunks to WebRTC and waits for all chunk ACKs before END. SIGNAL answer and candidate records share the receiver's synchronized seal-and-send lock with ACKs. Authenticated END freezes SIGNAL sends synchronously, preventing late candidates after COMPLETE while keeping the native channel alive through terminal confirmation.

Native negotiation is optional and starts while relay transfer continues. Negotiation failure before direct bytes leaves relay transfer running. Failure after the first direct fragment aborts the session, allowing existing fresh-nonce resume to recover. The bounded inbox closes before asynchronous native disposal, releasing native callbacks waiting for disk backpressure. SDP, ICE candidates, and native error details are not included in CD diagnostics.

## Network policy

The public upstream [`PeerConnectionFactory.Options.networkIgnoreMask`](https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/android/api/org/webrtc/PeerConnectionFactory.java) maps Ethernet to1 and Wi-Fi to2. CD's opt-out mask is the complement of those bits, excluding every cellular generation, VPN, loopback, wildcard, and future non-Wi-Fi/non-Ethernet bit. Unit tests use the pinned AAR's actual enum masks, including2G through5G.

The mask alone cannot represent `UNKNOWN`, whose value is0. CD therefore also installs a custom [`NetworkChangeDetectorFactory`](https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/android/api/org/webrtc/NetworkMonitor.java) before native monitoring starts. Its Android network callback publishes only handles whose capabilities explicitly identify unmetered Wi-Fi or Ethernet when mobile/metered data is off. Cellular, VPN, metered, Bluetooth, and unknown handles are omitted. The detector never requests a cellular network. Policy changes withdraw previously published handles.

Upstream [`AndroidNetworkMonitor::GetInterfaceInfo`](https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/android/src/jni/android_network_monitor.cc) marks interfaces with no published handle unavailable when its `IsAdapterAvailable` check is enabled. CD explicitly enables that check, keeps the native network monitor enabled, and disables any-address ICE gathering. The same upstream monitor binds UDP sockets to the published Android network handle. If Android callback registration fails, the detector publishes no handles, so the optional direct path cannot escape onto an unclassified route; the already-bound WebSocket relay remains usable.

Mobile/metered opt-in permits the other Android networks. Changing the setting closes the active session and rebuilds its native network policy on resume. Native WebRTC is never attempted for the explicit local transfer route.
