# Paired Android receiving

Status: implemented locally as a development receiver. Production rollout, Firebase project activation, and physical Samsung validation remain separate work.

CD Android receives files from an explicitly trusted CLI without a share code. The user scans a five-minute pairing QR and approves the laptop on the phone. Names identify stored pairs for CLI commands. A random 32-byte credential authenticates each pair. A separate random 16-byte pair ID routes control messages and is not an authorization credential.

## Device control

Pair credentials stay in a private CLI configuration directory and Android Keystore-encrypted storage. Sender and receiver admission tokens and message keys use separate HKDF-SHA256 labels. Control messages use AES-GCM with a fresh random nonce, direction-bound additional data, a random message ID, and a five-minute expiry. Future lifetime validation permits 30 seconds of clock skew. Already-expired messages remain invalid.

The `DeviceRoom` Durable Object stores the admission-token hashes and a registration expiry. It forwards bounded encrypted messages between one sender and one receiver. Active peers cannot be replaced. Application keepalives renew a 75-second peer lease so a half-open socket cannot block reconnect indefinitely. The room retains no messages or file contents. Authenticated activity refreshes the 30-day registration. Expired registration can be recreated by the sender with the same privately stored credential. The phone remains the authority for trust and revocation.

The CLI also advertises `_cdx._tcp` locally. Discovery carries a pair ID and port, never credentials or transfer capabilities. Local control uses a numeric private address and the same authenticated encryption as the relay. Before joining, the client answers a fresh server challenge with a role-specific HMAC. Local joins never disclose reusable relay admission tokens. The receiver follows a successful local control connection's host when connecting to the local data endpoint. Public endpoints require TLS.

## Resumable file data

File data retains the authenticated `cd-transfer-v2` record protocol from ADR 0001. Local WebSockets carry these encrypted records directly over TCP. The relay remains available when the local route fails. Internet transfers start on the relay and negotiate native WebRTC through encrypted signaling. After draining durable relay acknowledgements, only subsequent chunks move to the ordered direct channel. Control and completion remain on the relay. This preserves strict record sequence validation across the transition. A used direct channel that fails triggers a new resumable attempt. Each reconnect contributes new sender and receiver nonces and derives fresh directional frame keys. A matching credential can recover orphaned waiting or paired relay state only when no sender socket is active.

New senders advertise a four-MiB window and accept increasing cumulative durable acknowledgements. Existing receivers continue to acknowledge each chunk. Android commits one-MiB batches only when the sender advertises a sufficient window. Older senders retain per-chunk commits to avoid a deadlock. Receiver buffering remains bounded and applies backpressure instead of discarding records when storage is slower than the network.

A checkpoint advances only after syncing the staging file, checkpoint file, and checkpoint directory. Restart validates the checkpoint MAC and retained prefix, truncates any uncommitted tail, and resumes from committed bytes. The receiver verifies the complete size and SHA-256 before publishing through MediaStore. CLI completion requires the authenticated completion exchange or a matching trusted publication receipt after revalidating the source and saved capability. This receipt recovers a final acknowledgement lost after publication.

Targeted CLI sends persist an intent bound to the pair and ordered absolute source paths. Running the same command after interruption loads the same authenticated transfer capability. The existing source digest check rejects changed bytes. Intent and resume retention are 24 hours. Targeted sends re-execute a sender process when stdout is captured or `--detach` is selected. The command returns its PID and private log path; `--wait` keeps it in the foreground. This process must remain online and is not a persistent daemon across computer restarts.

This extends ADR 0001's initial exclusions of discovery and paired devices. Its authentication and durability requirements remain applicable.

## Android lifecycle

Android uses a native Kotlin receiver with Jetpack Compose controls and a `connectedDevice` foreground service. Kotlin and Go consume the same literal protocol fixtures. A reusable Go Android library was not required for this first interoperable build.

Receiving requires a visible notification and an enabled receiving switch. Stop pauses transfers and keeps checkpoints. Cancel and discard removes partial data. Revocation closes the device's control connections and pauses its pending transfers. Failed attempts yield to other queued roots. Network sockets bind to an allowed network so opting out of mobile data also constrains actual file traffic. Native ICE receives only permitted Android network handles and adapter types. Only active receive sessions hold a wake lock.

A foreground service does not promise immediate delivery during Doze, after a force-stop, or after reboot. Optional Firebase wake-up is implemented behind a separate build flag and an explicit phone opt-in. It sends only a pair ID and timestamp through Google. Receiver-authenticated registration stores a private installation ID on the Worker; sender-authenticated wake requests have per-pair limits. Stop and revocation reject later hints. The default preview omits Firebase, and no project is configured. Setup is documented in [the Firebase guide](../guides/firebase-setup.md). Screen-off emulator tests do not establish Samsung battery-management behavior. Directory bundles currently arrive as ZIP files. Android-to-CLI sending remains unimplemented.

Resumable relay sessions have a 16-minute waiting lease and a 15-minute paired inactivity lease. Existing forwarded records refresh both peers. Lease expiry retains the root and nonce history. At the existing 128-session cap, authenticated clients receive `exhausted` with reason `session_limit` and close code 4410. The CLI exits with guidance to start a new transfer; Android pauses without deleting the checkpoint. A repeated targeted CLI command creates a new root while preserving the old private capability.
