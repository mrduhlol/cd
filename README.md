# cd

Fast, private file handoffs: **[cd.yash0.in](https://cd.yash0.in)**

- **Anyone → anyone:** pick files in the browser or run `cdx send <file>`, share the 5-digit code, and the receiver
  types it into the **Receive** box, scans the QR code, or runs `cdx receive <code>`. Several files share one code and arrive as separate files.

CD never stores files. Transfers are live and end-to-end encrypted.

## Install `cdx`

| Platform | Command |
| --- | --- |
| Linux / macOS | `curl -fsSL https://cd.yash0.in/install.sh \| sh` |
| Windows (PowerShell) | `irm https://cd.yash0.in/install.ps1 \| iex` |
| Go 1.26+ | `go install github.com/YashasVM/cd/cmd/cdx@latest` |

The shell installers check release checksums. The CLI is named `cdx` because `cd` is a shell builtin.

## Use

```bash
cdx send ./report.pdf          # shows a code and QR in a terminal
cdx send ./shots ./notes.md    # several files, one code; they arrive separately
cdx send --json --qr ./receive-qr.png ./report.pdf # QR image for chat
cdx send --link ./secret.zip   # private end-to-end encrypted link instead of a code
cdx receive 48291              # save to the current directory
cdx receive 48291 --out ~/Downloads
```

Without the CLI, open `https://cd.yash0.in/#<code>` (for example
[cd.yash0.in/#48291](https://cd.yash0.in/#48291)) or type the code into the
**Receive** box on [cd.yash0.in](https://cd.yash0.in).
To send from a browser to a terminal, use [cd.yash0.in/send](https://cd.yash0.in/send).

| Command | What it does |
| --- | --- |
| `cdx status [transfer-ID or code]` | List background sends |
| `cdx wait <code>` | Exit 0 once the receiver has verified every byte, or 1 if the transfer failed |
| `cdx wait --timeout 5m <code>` | Same, but exit 3 if the receiver hasn't finished by then (the send keeps going) |
| `cdx update` | Update cdx to the latest release (checksum-verified) |
| `--json` | Machine-readable output, including `{"error":{"kind","message"}}` on failure and explicit retry guidance |
| `--qr <path>` | Save a QR PNG locally; JSON includes its absolute `qrPath`. The output path must not exist. |
| `--wait` / `--detach` | Force foreground or background sending |

**Behavior:** in a terminal, `send` displays a share card with a scannable QR and waits until the
receiver verifies the file. Captured stdout holds only the code (or compact JSON with `--json`). Progress is opt-in with `--progress` for captured output. When stdout isn't a terminal (agents, scripts, pipes), it detaches as soon as
the code is live. Codes expire after 15 minutes and admit one receiver.
Files of 1 MiB or more switch to a direct WebRTC path mid-transfer when the network allows it.

For safe retries of a detached send, use `cdx send --request-id <unique-id> --json <path>`.
Repeating the same request returns the original transfer; changing its input fails explicitly.
Status history is stored by transfer ID, so reused codes do not overwrite earlier sends.

To keep verified progress across interruptions, use the opt-in resume protocol:

```bash
cdx send --resumable --json ./report.pdf
cdx send --resume <transfer-ID> --json ./report.pdf
cdx receive --resume '<private-v2-link>' --out ./report.pdf
```

Resumable CLI sends stay in the foreground and use private links. Receiver checkpoints
are kept beside the output; sender records live in the private CLI state directory.
Reselect the same file and private link in the browser to resume a send; reopen the
link in the same browser to resume a receive. Restart the sender first and wait for
its private link to appear, then reconnect the receiver. Browser resume requires OPFS storage.
Records expire after 24 hours. Resume verifies the source and retained prefix and uses
fresh session keys. This first resumable protocol uses the relay; ordinary transfers
retain direct WebRTC transport. Explicit browser cancellation discards saved progress;
CLI receiver cancellation does too, while interrupting the sender retains its resume record.

**Security:** a 5-digit code lets the relay hold the transfer key so the code is easy to type, so anyone who
guesses a live code can receive the file. For sensitive files, use `--link`: the key stays in the URL fragment,
which never reaches the server. Details are in [SECURITY.md](SECURITY.md) and the [protocol spec](docs/agent-transfer-v1.md).

Agents should follow [AGENTS.md](AGENTS.md) and the [file-sharing skill](skills/cd-file-sharing/SKILL.md).

To teach the AI coding agents on your machine to share files with cdx, run `cdx agent setup` (the
installer offers it too). It asks per agent: Claude Code and `~/.agents/skills` get the skill; Codex,
Gemini CLI and opencode get a short note in their global instructions file. `cdx agent remove` undoes it.
Or install just the skill with `npx skills add YashasVM/cd`.

## Architecture

```text
Browser / cdx ── encrypted WebSocket ── CD relay (Durable Object) ── Browser / cdx
                └─ direct WebRTC upgrade for large files from cdx ─┘
```

One Cloudflare Worker serves the UI, signaling, relay (`/ws/v1`), and code directory (`/api/codes`).
Each transfer gets its own Durable Object room. Rooms hold one sender and one receiver, limit memory use,
expire on their own, and keep no file data.

Developers can embed live encrypted transfers with the [Android SDK and sample](android/sdk/README.md), without requiring the CD app. See the [third-party integration RFC](docs/third-party-integration.md) for the broader platform plan.

## Paired-device development preview

This checkout includes experimental CLI pairing and the device relay. A compatible native receiver is required; Android app sources and an APK are not included here. With a receiver available, build the CLI and run:

```bash
go build -o ./bin/cdx-dev ./cmd/cdx
./bin/cdx-dev pair --name phone
./bin/cdx-dev devices
./bin/cdx-dev send --to phone ./report.pdf
```

Approve the pairing QR in CD on the phone and enable receiving. Targeted sends keep resumable progress automatically. After an interruption, rerun the same command with the same files. Changed source bytes fail verification. Use `cdx devices forget phone` to remove the local credential, and **Revoke** in Android to stop trusting the laptop.

This is a development preview. The new device relay endpoint must run from this checkout for internet fallback. No production deployment is included. Local handoffs use authenticated encrypted WebSockets and mDNS discovery. Remote transfers start on the resumable relay and upgrade to native WebRTC when reachable. Optional Firebase wake-up is implemented and needs a project configuration; follow the [Firebase setup guide](docs/guides/firebase-setup.md). Targeted sends run in the background when stdout is captured, returning a PID and private log path. Use `--wait` to stay in the foreground; only `phase: verified` in the log confirms delivery. Files and folders selected together currently arrive as a ZIP in Android. See the [Android receiver contract](docs/implementation/android-contract.md) and [verification notes](docs/implementation/android-verification.md).

See [the pairing decision](docs/adr/0002-paired-android-receiving.md) for protocol and lifecycle limits. Run `node scripts/verify-devices.mjs` to verify real CLI pairing through a local Worker, admission checks, reconnects, and credential privacy.

## Develop

Requires Node.js 24+, npm, and Go 1.26.9+.

```bash
npm ci
npm run dev        # web UI
make cdx           # builds ./bin/cdx
```

Point a local CLI at a local Worker:

```bash
npx wrangler dev
CD_RELAY_URL=ws://127.0.0.1:8787/ws/v1 CD_PUBLIC_URL=http://127.0.0.1:8787 ./bin/cdx send ./README.md
```

### Checks

| Command | Covers |
| --- | --- |
| `npm test` | Browser unit tests |
| `npm run test:cli` | Go CLI tests |
| `npm run typecheck` | TypeScript |
| `npm run verify:agent` | CLI → Worker → browser, end to end in Chromium |
| `npm run verify:browser` | Browser send → browser (typed code and scanned QR) and → `cdx receive` |
| `npm run verify:terminal` | CLI ↔ CLI and browser → CLI |
| `npm run bench` | Throughput benchmarks |
| `npm run deploy:dry` | Worker bundle |

Set `CD_VERIFY_URL=https://cd.yash0.in` to run the `verify:*` scripts against production, and
`CHROMIUM_PATH` if Chromium isn't installed in a standard location.

## Deploy and release

```bash
npm run build && npx wrangler deploy           # production: cd.yash0.in
npx wrangler deploy --env test                 # staging: cd-test.yash0.in
git tag v1.2.3 && git push --tags              # builds cdx for all platforms and publishes a release
```

If something breaks in production, see [docs/production-recovery.md](docs/production-recovery.md).

## Layout

```text
cmd/cdx/   Go CLI
src/       browser UI and transfer protocols
worker/    Cloudflare Worker + Durable Object relay
scripts/   build, verify, and bench scripts
skills/    instructions for AI agents
docs/      protocol spec, recovery runbook, audit notes
```

MIT licensed. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).
