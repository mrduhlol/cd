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

Croc 11.6.5 was downloaded from the upstream release and its Linux archive passed the upstream checksum file. The executable SHA-256 is `d6cde9a91bb16007e96355ef68b64da1b5cc714a8999c16e10d050f6407c5d5c`. The globally installed 10.7.0 is excluded. No fresh croc performance comparison has been run yet.

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

A completed transfer is not yet a performance gate. Remaining work includes isolating deployed frontend versus hosted relay, repeated large-file runs, fair croc and baseline comparisons, Android execution, and regression thresholds calibrated from those measurements. No production deployment occurred.
