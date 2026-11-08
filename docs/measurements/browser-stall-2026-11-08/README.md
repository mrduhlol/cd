# Browser transfer stall investigation, 2026-11-08

The hosted browser sender stalls on this Linux machine. A fresh test of a 16 MiB random file failed to finish within 90 seconds, twice. Only 13 MiB had been handed to the relay socket when each run timed out. Payload-send gaps reached 30.3 and 25.7 seconds. These are failed transfers, not verified throughput measurements.

A fresh local test of PR #75 transferred and SHA-256 verified all 629,145,600 bytes through two independent Chromium processes. One automatic-route run used only WebRTC and completed download saving in 16.15 seconds. One forced-relay run completed in 24.63 seconds. These are individual loopback measurements, not physical-phone, LAN, WAN, durable-disk, or repeatability claims. No production performance fix is established yet.

## What differs

The deployed sender bundle `/assets/relay-sender-C3wOnsgK.js` has no `RTCPeerConnection` setup or direct offer. Its send loop uses WebSocket records and cumulative ACKs. The runtime probe likewise recorded zero peer connections in both hosted trials. PR #75 contains a direct sender path, and the local 600 MiB trial recorded a connected peer and all payload bytes on WebRTC. This explains the transport difference, but does not by itself explain the hosted relay pauses.

The deployed receiver bundle does contain WebRTC code. Receiver support alone cannot establish a direct connection when the sender does not offer one.

Fetched public asset SHA-256 values:

- `/assets/index-CAq_iO25.js`: `d29a551f464a274bf26eedfdf8e660bedfa27549e430edf2eb84f300b11d86ea`
- `/assets/relay-sender-C3wOnsgK.js`: `5c30267f2d25e9b1ea105030981f805692c23899347c5b22edbfcc4f2f574e44`

The hosted reports identify the local checkout used to run the benchmark, not the production deployment commit. Asset paths identify the served frontend. The two hosted reports were generated before automatic hosted-asset hashing was added to the runner.

## Evidence and limits

`hosted-16-isolated.json` retains both 90-second failures. The dependency downloader was stopped during the setup of the first trial and was absent before its first payload send. `hosted-16-contended.json` retains the earlier 45-second smoke failures while npm was downloading dependencies; exclude those from isolated results.

`local-600.json` contains complete output sizes and hashes, transport counts, connection states, ACK-window snapshots, and timing. `local-16-smoke.json` is a setup check, not a 600 MiB result. `focused-tests.log` contains 32 passing window/storage checks; none establishes physical Android throughput.

The local runs used the already-installed `workerd 2026-11-04` via `MINIFLARE_WORKERD_PATH`, because npm was still downloading the PR's locked runtime. The first attempt to start the partially downloaded runtime failed with `ETXTBSY` before any transfers. The override is recorded in the 600 MiB report. Do not claim these runs used the lockfile's Worker runtime.

The initial Android audit found storage-bound ACKs and a conditional prefix-rehash fallback if the digest provider cannot clone its state. Neither has been reproduced on a phone. No physical device was connected. These remain hypotheses.

Croc 11.6.5 was downloaded from the upstream release and its Linux archive passed the upstream checksum file. The executable SHA-256 is `d6cde9a91bb16007e96355ef68b64da1b5cc714a8999c16e10d050f6407c5d5c`. The globally installed 10.7.0 is excluded. Fresh comparison results appear below.

## Reproduce

Build the checkout, then run the new benchmark. It consumes no old measurements or old benchmark logic; it reuses only browser discovery and Worker lifecycle helpers. It creates independent random data for each MiB, times actual UI code entry through saved download, and verifies output size and SHA-256 outside timing. Browser contexts are fresh per trial, and route order reverses each run. Failed trials remain in the report and cause a nonzero exit.

```sh
npm ci
npm run build
CD_FRESH_MIB=600 CD_FRESH_RUNS=3 \
  CD_FRESH_OUTPUT=/tmp/cd-local-600.json \
  node scripts/bench-transfer-fresh.mjs

CD_VERIFY_URL=https://cd.yash0.in \
  CD_FRESH_MIB=16 CD_FRESH_RUNS=1 CD_FRESH_TIMEOUT_MS=90000 \
  CD_FRESH_OUTPUT=/tmp/cd-hosted-16.json \
  node scripts/bench-transfer-fresh.mjs
```

A completed transfer is not yet a performance gate. The continuing work below isolates the frontend and adds repeated comparisons and a local regression gate. WAN controls and physical Android execution remain necessary. No production deployment occurred.

## Frontend isolation and hosted checks

The deployed frontend snapshot completed and verified 16 MiB through the local PR75 Worker in 607.9 ms. PR75's frontend completed in 631.9 ms. These single trials do not establish a speed difference, but neither reproduced the hosted stall. Raw reports and the snapshot's hash manifest are in `isolation/`.

Using PR75's frontend against the production service completed 16 MiB over WebRTC in 2.28 seconds. Forced relay failed its 90-second deadline: the sender had queued 5 MiB, while the receiver had received only about 2.75 MiB of wire records. The existing test service also failed its 90-second relay trial. Both used the candidate frontend via Playwright asset fulfillment, without a production deployment. `candidate-on-production-16.json` and `candidate-on-existing-test-16.json` retain these runs.

The production Worker's latest deployment metadata dates to 2026-10-19 and has no compatibility flags. The PR's `no_web_socket_compression` flag is not part of that deployment. The existing `cd-test` update was rejected by Cloudflare with migration error 10074, so its Durable Objects were left intact. A separate temporary Worker, `cd-speed-perf-test-20261108`, was deployed with fresh SQLite namespaces and the PR configuration. It verified 16 MiB in 58.08 seconds, about 0.275 MiB/s. Its browser socket still negotiated `permessage-deflate` despite the opt-out in the source configuration.

A second temporary candidate deleted `Sec-WebSocket-Extensions` from the request forwarded to the transfer Durable Object, in both v1 and v2 routes. It still negotiated compression and took 54.61 seconds, about 0.293 MiB/s. This did not establish a material improvement, so the source change was reverted. `isolated-worker-strip-extension-16.json` retains that failed optimization attempt. The flag alone and the forwarded-header change are not proven fixes. Cloudflare documents the opt-out in its [WebSocket compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-compression).

The same-service HTTP control below is slow too. It does not isolate a CD-specific relay defect. The temporary diagnostic Worker was deleted after those controls.

## Fresh 600 MiB comparison

`compare-600-wrangler-proxy.json` contains 15 verified transfers, three per case, on the same Linux host. Every tool received the exact same 629,145,600 random bytes and produced the same SHA-256. Tool order rotates between repetitions. Medians of receive-through-saved-output throughput were:

| Case | Median MiB/s |
| --- | ---: |
| Browser CD, automatic WebRTC route | 34.34 |
| Browser CD, forced relay | 24.02 |
| CLI CD, forced relay | 410.37 |
| Croc 11.6.5 CLI, forced relay | 1461.05 |
| Unencrypted HTTP ceiling | 1121.34 |

These are loopback results with OS caching and no fsync claim. Browser pages preload outside timing. CLI receiver process startup is inside receive timing. Croc retains its default compression and multiplexing, with `--transport relay --no-local`; CD CLI sets `CD_DIRECT=0`. Readiness is recorded separately for native tools. The HTTP ceiling has fewer guarantees and is not a secure file-transfer competitor. Croc's throughput exceeding this particular single-stream HTTP implementation does not imply it exceeds the machine's network capacity.

The local CD service uses Wrangler's development proxy. The browser handshake negotiated compression even though the application's config opts out; native clients have different compression negotiation. These results measure the recorded runtime, not a maximum CD core-runtime speed. An attempted direct-runtime replacement failed to run the complete UI flow and was removed rather than used for favorable timings. No old benchmark timings or result files are inputs to the new comparison runner.

```sh
CD_FRESH_CROC=/absolute/path/to/checksum-verified/croc \
  CD_FRESH_MIB=600 CD_FRESH_RUNS=3 \
  CD_FRESH_OUTPUT=/tmp/cd-compare-fresh.json \
  node scripts/bench-transfer-compare-fresh.mjs
```

## Regression check

`npm run verify:performance` builds the frontend and runs three independent 64 MiB browser trials per route. The gate requires full hashes and sizes, at least 8 MiB/s in every trial, no payload-send gap above five seconds, actual direct payload in automatic mode, and only relay payload in forced-relay mode. It rejects missing, duplicate, failed, and misrouted trials. Throughput is recomputed from bytes and elapsed time rather than trusting a report's claimed rate.

The 8 MiB/s floor is below every retained 600 MiB local trial. It is a conservative KB/s-stall detector, not a promise for every network or phone. `ci-gate-64.json` and `ci-gate.log` retain the six passing real transfers. Five gate tests include false high-rate claims, 30-second stalls, hash failures, missing repetitions, and routing failures. CI now runs this check after browser verification. All 168 JavaScript tests, full Go tests, and type checking pass on this checkout. Cloud CI has not yet verified this new step.

The benchmark accepts `CD_FRESH_INPUT` to reuse an existing file of exactly the configured size, and `CD_FRESH_ASSET_DIR` to isolate an alternate frontend from the configured service. It records the runner hash, source hashes, actual served asset names, socket extensions, and failed-request paths. Asset overrides only fulfill the app root and asset requests; transfer traffic still reaches the configured service.

## Same-service HTTP control

A temporary wrapper around the same isolated Worker accepted at most 16 MiB on a private test route and returned those bytes over HTTP. It checked the declared size and bounded the streamed input. The real Chromium client preloaded 16 MiB of random data, timed POST through full response consumption, then verified the response hash outside timing. The exact same file was then sent through actual browser CD forced relay, without replacing CD with a synthetic WebSocket echo.

All three HTTP requests returned 200 with complete matching bytes and hashes. They took 75.41, 82.40, and 57.88 seconds. Time to response headers was 52.85, 54.60, and 32.58 seconds. Header timing includes upload and Worker buffering/processing; it is not an independent upload-capacity measurement.

One CD trial verified the same file in 53.38 seconds. A second failed its 120-second download deadline and retained only partial diagnostic counts. Both trial outcomes are in `network-control/cd-relay.json`; `network-control/http.json` contains all HTTP outcomes. HTTP echoes buffer before responding, while CD streams between two sockets, so these timings do not support a protocol speed ratio.

This control does not establish abundant network capacity or isolate compression/relay code as the cause of the slow hosted runs. The delays affect plain HTTP on the same service too. It provides no evidence about the disconnected physical phone's network. The temporary Worker was deleted after this control; production and the existing test Worker's objects were not changed. The diagnostic route's private path and deployment credentials are excluded from the evidence.

## Android app coverage

A universal debug APK from this checkout passed all 69 Android JVM tests and ran on the dedicated Android 15 x86_64 emulator. The emulator had a newer test version installed, so installation used the platform's data-preserving downgrade option. No app data was cleared. Subsequent benchmark runs pulled the installed `base.apk` and required its SHA-256 to match the checkout's built artifact. The APK hash was `3ce0b8a264537b12febce7c1abe511d36739124ab758c82f0463121723a3eeb0`.

The real browser main page sent three independent 600 MiB random files to CD Beta's Receive UI over v1 relay. Each Android publication was pulled from `Downloads/CD` and its full size and SHA-256 matched the source. Transport times through the encrypted completion record were 48.55, 46.25, and 48.09 seconds. This completion record follows native Android publication, including its sync and pending-file flag update. UI entry latency and the later verification pull/hash are outside those times. The first large trial predates the automatic APK-equality guard; the next two enforced it. All used the same freshly installed APK.

Raw reports are in `android/receive-600-*.json`. The largest measured payload-send pause was below half a second. These are emulator/local-Worker results with an active Wrangler proxy and compression, not physical hardware, mobile Internet, Android Chrome, or paired v2 resume measurements. Native Android and desktop tools have different hardware and timing semantics here; do not treat their rates as a direct competition.

`bench-browser-android-fresh.mjs` reproduces this real UI path. After opening a dedicated emulator with the device tools and installing the current APK, pass the bound `agent-device` executable as `CD_ANDROID_AGENT_DEVICE` and the emulator serial as `CD_ANDROID_SERIAL`. The driver opens CD Beta, enters its Receive screen, fills the generated local invitation, and presses Receive. Every UI action uses that bound device command. Without it, the runner emits a private offer-file path for an operator to drive the same UI. It enforces output hashes and a conservative 4 MiB/s emulator floor for payloads of at least 64 MiB. A final one-MiB test verified the automatic UI driver.

```sh
ANDROID_HOME=/path/to/android-sdk \
  CD_ANDROID_AGENT_DEVICE=/path/returned/by/device_open/agent-device \
  CD_ANDROID_SERIAL=emulator-5554 CD_FRESH_MIB=600 \
  CD_FRESH_OUTPUT=/tmp/cd-browser-android.json \
  node scripts/bench-browser-android-fresh.mjs
```

The existing paired Android verifier addressed the retired `in.yash0.cd` identity and rejected files larger than 512 MiB. It now checks that CD Beta is installed, uses `in.yash0.cd.beta` for app-private access and process recovery, and accepts the requested 600 MiB case. Its paired v2 interruption/screen-off modes have not been rerun in this investigation. CI now includes the existing Android JVM suite; this new cloud job still needs its first run. The browser throughput job passed in cloud CI at commit `2a011bb`. The security job failed twice downloading its pinned scanner with upstream HTTP 504; those failures are not secret-scan findings.
