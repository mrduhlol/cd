# Background desktop receiving

Status: proposed, not an available command.

A small Go process can receive files from a trusted phone without opening a browser or entering a code for every transfer. The existing CLI download engine handles staging, validation and publication. The missing parts are incoming-offer orchestration and explicit permission for uploads to the laptop.

## Permission and protocol

Existing pairing authorizes the computer to send files to the phone. It does not authorize uploads to the computer. Keep that permission unchanged. The intended authorization is an explicit foreground `cdx receive --paired --out <directory>` invocation using the existing private pairing store. Pairing alone must never enable uploads. This command is not implemented yet; do not install a service invoking it.

CD Beta already sends encrypted `share` messages containing `transferId`, `url`, `filename` and `size`, and expects `receiving`, `received` or `paused` replies. The CLI codec currently rejects `share` and `receiving`. Extend its directional validation deliberately: these phone shares travel from the existing receiver role to the desktop sender role. Ordinary numeric share codes remain useful for manual handoffs, but must not authorize automatic desktop downloads.

## Process and transfer handling

Implement `cdx receive --paired --out <directory>` as a foreground command, managed by a user service for login startup and restart. No custom process manager is needed. Start with one serialized receive queue and a fixed, bounded queue length. Use the saved pairing store, `devices.NewCodec`, `DialLocal` for discovered LAN endpoints and `Dial` for the configured secure relay. Reuse each pair's codec across its connections so replay protection covers both routes.

Validate each authenticated share before queueing: require a v2 invitation on an allowed endpoint, match its decoded root ID to `transferId`, reject unsafe filenames and invalid sizes, and bind the v2 offer name and size to the announcement before creating staging files. Reject unpaired messages and malformed URLs. Pass validated invitations to the existing receive engine. Preserve filename validation, private staging, size and digest verification, no-overwrite publication and disk-space errors. Send a receipt only after publication succeeds. Revoking upload permission must close that pairing's connections and reject new offers.

Keep the receive daemon's pair roles separate from ordinary CLI sending. Two processes cannot occupy the same pair and role simultaneously. Fail with an actionable ownership/bind error if concurrent sending already owns the listener; do not replace its socket. Refuse `--force` in paired mode.

## Idle resource use

Wait on sockets and queue events. Allocate transfer buffers, hash files and negotiate WebRTC only after an authorized offer arrives. Do not scan directories or poll for incoming files.

The current paired transport sends an application heartbeat every 20 seconds. The local server also sends WebSocket pings every 20 seconds. Discovery refreshes advertisements every 60 seconds. These timers mean idle operation is not zero work. Replace the current one-second reconnect loop with capped exponential backoff and jitter before reusing it in a daemon. Stop retrying revoked credentials.

LAN-only receiving can avoid cloud traffic. Internet receiving can reuse the existing relay infrastructure, but connection heartbeats and transfer traffic still consume provider resources. No production pricing or account allowance has been verified for this proposal.

No paired listener has been built or benchmarked for this design. There are no measured idle CPU or memory figures. Ordinary manual `cdx receive <link> --out <directory>` remains the available receive path. Before enabling startup by default, measure idle CPU time, RSS and PSS, wakeups, reconnect attempts and network bytes for connected, offline and reconnect scenarios. Test a large phone-to-desktop transfer, cancellation, insufficient space, duplicate offers, revocation and process restart. Use those measurements to decide whether persistent relay connectivity should be opt-in.
