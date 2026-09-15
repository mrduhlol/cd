# cd

Fast, private file handoffs at [cd.yash0.in](https://cd.yash0.in).

CD supports two focused flows:

- Browsers exchange one or more files directly over WebRTC.
- Agents and terminals run `cdx send <file>` and produce one browser link.

Files are never intentionally stored by CD. The orange CD interface is the
receiver for both flows.

## Send a file from an agent or terminal

Install `cdx` with Go:

```bash
go install github.com/YashasVM/cd/cmd/cdx@latest
```

Or install the latest checksum-verified release on Linux or macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/YashasVM/cd/main/scripts/install.sh | sh
```

Then send one regular file:

```bash
cdx send ./app.apk
```

The binary is named `cdx` because `cd` is already the shell's change-directory
command.

Standard output contains only the private share URL:

```text
https://cd.yash0.in/s/3JgrxJIKt2cqd2V0aTDQyQ#v1.<private-key>
```

Send that complete URL to the receiver. Keep `cdx` running while they accept
and download the file. Progress is written to standard error; exit status 0
means the receiver verified the complete byte count. Use `--json` when a tool
needs structured output.

The URL fragment holds the encryption key. Browsers do not send fragments to
the server, and the relay receives encrypted records only. A receiver must
also prove knowledge of a token derived from that key before joining. Treat
the full URL as a temporary secret.

Repository agents should follow [AGENTS.md](AGENTS.md) and the reusable
[CD file-sharing skill](skills/cd-file-sharing/SKILL.md).

## Browser-to-browser sharing

Open [cd.yash0.in](https://cd.yash0.in), choose files, and share the displayed
5-letter private code (e.g. `K7Q2M`), link, or QR code. The private code is placed in the URL
fragment so it is not sent in HTTP requests. Codes are CAPS-only and exclude
lookalike characters (no I/L/O/0/1) so they are easy to read out loud.
Keep both tabs open until the
WebRTC transfer finishes. CD coordinates the connection through its own
`cd.yash0.in` Worker; file bytes travel over the encrypted WebRTC data channel.
WebRTC may use public STUN servers for NAT discovery, but they do not receive
file bytes. This remains separate from the agent relay.

## Develop locally

Requirements: Node.js 24+, npm, and Go 1.26.8+.

```bash
npm ci
npm run dev
```

Build the local CLI with `make cdx`; it is written to `bin/cdx`. Run the full
production checks with:

```bash
npm test
npm run test:cli
npm run typecheck
npm run verify:agent
npm run deploy:dry
cd android && ./gradlew testDebugUnitTest lintDebug assembleDebug
```

`verify:agent` starts a local Worker, builds the real Go sender, and drives the
built receiver page in Chromium. It checks admission failures, duplicate
participants, multi-chunk flow control, Unicode filenames, the downloaded
bytes, visible CD branding, and the sender's completion status. Set
`CHROMIUM_PATH` if Chromium is installed outside the common system paths.

To exercise the browser receiver locally:

```bash
npx wrangler dev
CD_RELAY_URL=ws://127.0.0.1:8787/ws/v1 \
CD_PUBLIC_URL=http://127.0.0.1:8787 \
./bin/cdx send ./README.md
```

## Architecture

```text
Browser sender  ── CD signaling ── WebRTC ── Browser receiver

cdx sender ── encrypted WebSocket records ── CD relay ── Browser receiver
                 key remains in URL fragment
```

The Cloudflare Worker uses one Durable Object room per random 128-bit transfer
identifier. Rooms admit one sender and one authorized receiver, bound memory
and frame sizes, expire automatically, and retain no file contents. The sender
uses 64 KiB chunks with an acknowledged 1 MiB window. The browser streams to
the File System Access API where available, stages to the Origin Private
File System next, and otherwise offers a Blob download (capped at
256 MiB on WebKit receivers, where large blob downloads crash real devices).

The exact protocol and trust boundaries are documented in
[Agent transfer protocol v1](docs/agent-transfer-v1.md). Operational recovery
notes are in [Production recovery](docs/production-recovery.md).

## Repository layout

```text
cmd/cdx/                  Go sender CLI
src/                      Browser UI and transfer protocols
worker/                   Cloudflare Worker and Durable Object relay
scripts/verify-agent.mjs  Deterministic end-to-end verification
android/                  Android shell for the browser P2P flow
skills/                   Instructions for AI agents
```

## Deploy and release

`npm run build && npx wrangler deploy` publishes the Worker and assets using
`wrangler.jsonc`. Pushing a `v*` tag runs the release workflow, cross-compiles
`cdx`, publishes SHA-256 checksums, and creates a GitHub release.

After deployment, run `CD_VERIFY_URL=https://cd.yash0.in node scripts/verify-p2p.mjs`
to verify that two browsers can transfer and save the exact file bytes through
production signaling. This check sends a generated test file through both disk
staging and the memory fallback, including unavailable disk storage.
Run `CD_VERIFY_URL=https://cd.yash0.in node scripts/verify-agent.mjs` to verify
the encrypted CLI transfer and downloaded bytes against production as well.

See [SECURITY.md](SECURITY.md) before reporting vulnerabilities. CD is
available under the [MIT License](LICENSE).
