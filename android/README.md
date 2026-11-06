# CD for Android

Native Kotlin and Jetpack Compose receiver for trusted CLI transfers. Requires Android 10 or newer. The first physical-device target is the Samsung S24 Ultra.

## CD Beta updates

The beta package is `in.yash0.cd.beta`, separate from `in.yash0.cd`. All builds use this single package. The current update is `0.1.5-beta`, version code 6. Keep the original signing key when updating. This machine's beta key is in `$HOME/.config/.android/debug.keystore`; set `ANDROID_USER_HOME=$HOME/.config/.android` when building.

```sh
ANDROID_USER_HOME="$HOME/.config/.android" ./gradlew --max-workers=2 -PcdAbi=arm64-v8a testDebugUnitTest lintDebug assembleDebug
```

Opening a CD file link shows Accept / Reject. Accept queues the transfer in the foreground receiver and returns to the previous app after any notification permission prompt. Reject performs no lookup and queues no download. Numeric codes and private v1/v2 links are supported. Browser word-code transfers still require the web receiver. Publish `public/.well-known/assetlinks.json` so Android can verify the beta as the website's link handler.

## Build and install

Install JDK 17 and Android SDK platform 35. Set `ANDROID_HOME` to your SDK location, or put `sdk.dir=/path/to/Android/Sdk` in `local.properties`.

```sh
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n in.yash0.cd/.MainActivity
```

For a smaller S24 Ultra APK, first preserve the verified universal APK, then build only arm64:

```sh
cp app/build/outputs/apk/debug/app-debug.apk /tmp/cd-universal.apk
./gradlew :app:assembleDebug -PcdAbi=arm64-v8a
mkdir -p ../bin
cp app/build/outputs/apk/debug/app-debug.apk ../bin/cd-android-preview-arm64.apk
adb install -r ../bin/cd-android-preview-arm64.apk
```

Omitting `cdAbi` builds a universal APK for emulator development. Accepted values are `arm64-v8a`, `armeabi-v7a`, `x86`, and `x86_64`; other values fail configuration.

The S24 artifact is `bin/cd-android-preview-arm64.apk` from the repository root. The default build output changes with the ABI property, so keep the universal copy for emulator use.

The checked-in Gradle wrapper downloads Gradle 8.13. Dependencies resolve from Google Maven and Maven Central. Debug APKs use the local Android debug signing key. A signed release and store distribution need a separately managed release key.

## Pair and receive

Run `cdx pair` on your computer, scan its QR code with CD, and tap **Trust device**. You can also paste its `cdpair://v1#...` pairing link. Pairing links expire after five minutes. They contain a secret, so keep them private.

Enable receiving and allow notifications. CD keeps a visible **Ready to receive** notification, discovers trusted computers over `_cdx._tcp`, and reconnects to their paired control channels. Trusted offers automatically enter the receive queue. LAN control sockets answer a fresh, directional HMAC challenge and never send relay bearer tokens. Relay sockets use their separate admission token. Admitted control sockets send a small JSON heartbeat every 20 seconds; idle receiving holds no CPU wake lock, so Doze may defer it until the phone wakes. Public connections require TLS; local connections accept only numeric private, link-local, or loopback addresses and still authenticate and encrypt every record.

The receiver tries the authenticated offer's local WebSocket endpoint first and then its v2 relay endpoint. Each retry authenticates fresh session nonces and resumes only from a durable checkpoint. Retries revisit the local route and use bounded admission waits. Each failed attempt yields to other queued roots; per-root retry timing and route attempt numbers persist in the active service, and authenticated re-offers wake only their own retry. Bounded receive-attempt diagnostics are available with `adb logcat -s CD`; they contain root IDs, route classes, stages, and safe error categories, with no invitation URLs, filenames, or secrets. The Android client binds sockets to an unmetered Wi-Fi or Ethernet network by default. Enable mobile or metered data explicitly to use it. This also permits local Wi-Fi when Android's default internet route is cellular.

Files stage in app-private storage. CD verifies the retained prefix before resuming, synchronizes file data and its authenticated checkpoint, including its directory rename, before acknowledging it, and verifies the final byte count and SHA-256 before publishing to `Downloads/CD` through MediaStore. Existing files receive MediaStore's collision-safe names. Completed transfer IDs and accepted control-message IDs persist across process restarts. New senders advertising a receive window of at least 1 MiB get cumulative durable acknowledgments every 1 MiB; older senders keep per-chunk acknowledgments. The final partial batch always commits. Storage checks account for both the unfinished staging file and its Downloads copy. Insufficient storage pauses the transfer with an actionable message, and a small metadata reserve lets the app persist that pause even when another app fills the disk.

**Stop** in the notification pauses all active and queued transfers, sends authenticated pause receipts, and turns off receiving after a bounded control-frame drain. Per-transfer Pause keeps trusted control sockets open. Saved progress remains. Enable receiving and tap **Resume** on the transfer to continue. A lost network remains retryable, while an expired transfer or an exhausted reconnect budget pauses with instructions to start a new transfer. Both keep their retained checkpoint. A paused transfer also has **Cancel and discard**, which removes retained data and preserves the receiving switch. **Revoke** removes a device credential and pauses that device's pending transfers.

For an ordinary CLI resumable transfer, paste its full private `https://.../s/...#v2...` link and tap **Receive file**. Numeric codes and v1 links do not support this receiver's resume protocol.

## Background behavior and current limits

Receiving uses an Android `connectedDevice` foreground service. Active transfers hold a timed partial wake lock, renewed only while the transfer is running. Idle receiving does not hold a wake lock. The notification must remain enabled. Android Doze can delay idle network traffic until the phone wakes. Active transfers consume battery. Samsung's battery management can still stop it, so physical S24 Ultra screen-off and battery tests are required before describing background delivery as reliable.

Firebase wake-up is optional and off by default. The default build and preview APK omit Firebase; configure your own project and build with `-PcdFcm=true` to expose the separate Trusted wake-up notifications switch. See [docs/push.md](docs/push.md) for setup, build checks without credentials, delivery policy and current limits. No project is configured by this checkout. After a force-stop, open CD to restore receiving; Android does not deliver FCM to a force-stopped app. Receiving that was explicitly stopped stays off until enabled again. Android may also delay process recreation after memory pressure. CD does not silently restart receiving after a reboot. Credentials remain in Android Keystore-encrypted app-private storage; Android backup is disabled.

The remote v2 transfer starts on the encrypted WebSocket relay and can switch file chunks to native WebRTC after negotiation. Failed negotiation leaves relay transfer working. Android-to-CLI sending, directory bundles, and a release signing/distribution pipeline are not implemented in this receiver. Optional FCM wake-up is implemented but needs your Firebase and Worker configuration before real delivery can be verified. Native dependency provenance and network filtering are documented in [docs/webrtc.md](docs/webrtc.md). No account or username/password is needed for pairing.

## Protocol checks

Unit tests consume the repository's `fixtures/resume-v2.json` and `fixtures/device-v1.json`, rather than copied Android fixtures. They compare admission derivation, nonce proofs, both AES-GCM frame directions, and checkpoint MACs with Go's literal fixture. They also compare all paired channel keys and decrypt Go's literal offer frame, reject replayed records, changed nonces, modified ciphertext, expired pairing links, public cleartext endpoints, and control messages in the wrong direction. Upper expiry validation permits 30 seconds of clock skew. Push policy tests cover opt-in, receiving and notification gates, actual delivered priority, trusted-pair checks, freshness, replay/coalescing and target request credentials from the shared fixture. Scheduler tests prove that an unreachable transfer yields to newer queued roots. Native transport tests cover fragmented and concatenated CHUNK reassembly, record bounds, concurrent SIGNAL/ACK sequencing, terminal signal freeze, and mobile opt-out network policy. Separate pressure tests prove that the bounded eight-record inbox waits for the disk writer without dropping chunks and that closing it releases both blocked producers and consumers.

For emulator integration, forward the CLI/Worker port with `adb reverse` and use loopback/private numeric URLs in the test invitation. Pairing still requires a manual Trust action in the app; no test-only trust bypass is included.

## One Android app

CD Beta is the only build identity. CD and CD Preview variants are retired. Remove those old installations manually after saving any needed files. Android cannot merge their private data into CD Beta.

Pair without an account using `cdx pair --name phone`. Scan the QR in CD Beta and approve the laptop, then use `cdx send --to phone <file>`. Pairing credentials stay private on both devices. Review and revoke trusted devices in the app. No login is required.
