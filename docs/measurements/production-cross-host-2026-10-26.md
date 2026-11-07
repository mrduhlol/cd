# Cross-host production verification

This check used the PC at `192.168.1.6` and the Linux box at `yvm@192.168.1.9`. Both endpoints used a candidate CLI built from current main plus the performance changes. Browser transfers used Chromium on this PC with OPFS on the home filesystem. All relay connections went to the live `https://cd.yash0.in` service. No Worker or public frontend deployment occurred during these measurements.

## Results

All 15 accepted transfers passed independent SHA-256 verification. Ordinary tests covered a 17,003 byte Linux-to-PC relay transfer and a 32 MiB plus 77 byte PC-to-Linux transfer with automatic direct transport. The latter reported both relay and WebRTC traffic; it was not a TCP-only or internet-only throughput measurement.

The browser comparisons used three alternating before/after pairs in each direction with random 32 MiB plus 77 byte files. Direct transport was disabled for these comparisons, so their bytes crossed the production relay.

| Direction | Before median | Candidate median | Ratio |
| --- | ---: | ---: | ---: |
| Linux box to browser | 23.899 s | 10.246 s | 2.33× faster |
| Browser to Linux box | 44.748 s | 9.949 s | 4.50× faster |

Every candidate receiver issued exactly 129 worker write requests, confirming that the new storage path ran rather than silently falling back. The untouched deployed browser receiver also completed a separate 32 MiB transfer with the expected hash in 27.295 seconds. That single run is a compatibility check, not the comparison baseline.

## Method and limits

The before build uses the committed browser resume and hashing sources at `405551b3`, with the same fixed 4 MiB plus 64 KiB inbox limit as the candidate so the current CLI's outstanding window fits both receivers. The candidate adds reusable SHA-256 scratch storage, a four-record sender pipeline and the flushed worker-owned receiver handle. Both builds retain current main's other transport and security fixes.

Only test-browser asset requests were intercepted. Both variants ran on the real production origin and used its actual WebSocket relay, authentication and completion protocol. Browser exports were invoked with native selected files and real browser storage. A separate built-UI verifier covers ordinary UI flows, unsupported-worker fallback and restart in both directions.

Module loading and sender readiness precede timing. Receiver timing includes native OPFS writes, strict IndexedDB checkpoint persistence, whole-file verification and production completion signaling. Sender timing starts at remote CLI receiver launch and includes its durable completion and browser sender completion. Final downloaded-copy hashing or remote `sha256sum` runs after timing.

The PC uses Wi-Fi and the Linux box uses Ethernet on the same home network. Relay cases still traverse the public service, but this does not reproduce mobile hardware or a carrier route. Three pairs demonstrate a repeatable result in this session; they do not establish seven-trial acceptance or a universal speed multiplier. No encryption, integrity or checkpoint barriers were removed.

An early test-browser overlay omitted Vite's absolute worker asset path. Its activation assertion rejected that candidate attempt; it is excluded from the accepted rows. The corrected overlay intercepts the worker path and requires the exact write count.

Raw evidence:

- `production-ordinary-2026-10-26.json`
- `production-receiver-2026-10-26.json`
- `production-sender-2026-10-26.json`
- `production-cross-host-2026-10-26-manifest.json`, including source, CLI and frontend bundle hashes

## Reproduce

The runner is intentionally specific to these two machines. It uses only generated test files beneath the Linux user's home cache and does not replace the installed CLI. Build `/tmp/cd-resume-candidate`, copy it to `~/.cache/cd-production-verify-20261026/cdx` on the Linux box, and create `small.bin` and `random32.bin` there. The latter is 32 MiB plus 77 random bytes. Build the candidate frontend normally.

For the comparison build, run Vite with a load plugin that supplies `src/resume-browser.js` and `src/incremental-sha256.js` from base commit `405551b3`, changes only the old inbox cap to the shared limit described above, and writes `/tmp/cd-resume-before-dist`. The raw manifest identifies the measured outputs. Then run serially:

```sh
node --input-type=module <<'JS'
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const files = new Map(['src/resume-browser.js', 'src/incremental-sha256.js'].map(path => [resolve(path), execFileSync('git', ['show', '405551b3:' + path], { encoding: 'utf8' })]));
const receiver = resolve('src/resume-browser.js');
files.set(receiver, files.get(receiver).replace('pending.length >= 16 || queuedBytes + size > 2 * 1024 * 1024', 'pending.length >= 32 || queuedBytes + size > 4 * 1024 * 1024 + 64 * 1024'));
await build({ plugins: [{ name: 'baseline', enforce: 'pre', load(id) { return files.get(id.split('?')[0]) ?? null; } }], build: { outDir: '/tmp/cd-resume-before-dist', emptyOutDir: true } });
JS
```

```sh
CD_VERIFY_PHASE=ordinary node scripts/verify-production-cross-host.mjs /tmp/ordinary.json
CD_VERIFY_PHASE=receiver node scripts/verify-production-cross-host.mjs /tmp/receiver.json
CD_VERIFY_PHASE=sender node scripts/verify-production-cross-host.mjs /tmp/sender.json
```

## Deployment checks

Porting the changes onto current main preserved its newer ordering, ZIP safety and relay hardening. The candidate passed all 152 JavaScript tests, the Go suite, typechecking and the production build before cross-host testing.

Deployment preparation exposed two existing security-check blockers. The dependency override pins the patched `undici` 7.30.1 while preserving direct dependency versions. The Go module and CI/release toolchain pins move from 1.26.9 to 1.26.10 for the certificate distrust fix. These are separate from the measured transfer changes. The measured CLI used Go 1.26.9; release validation uses the patched toolchain. The browser bundle contents are unchanged by those development-tool patches.

References: [undici advisory](https://github.com/advisories/GHSA-xjj6-f33q-929c), [Go advisory](https://pkg.go.dev/vuln/GO-2026-6809).

After those patches, npm audit reported zero vulnerabilities and govulncheck reported no affected code. It still lists one advisory in a required module whose vulnerable functions are not called. The patched Go suite passed. Agent verification, browser verification, all five browser resume scenarios and deployment dry run also passed. Production deployment remains gated on the PR review bot and CI.
