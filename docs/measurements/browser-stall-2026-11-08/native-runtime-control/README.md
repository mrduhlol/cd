# Native runtime configuration control

These nine local transfers are a separate batch from the main 18-case comparison. All used the same fresh 600 MiB random input. Every output matched its full size and SHA-256, and both participants exited zero. Both CD participants reported directBytes=0. Sender relayBytes includes the full encrypted payload; receiver relayBytes counts outbound acknowledgments.

| Runtime | Round 1 MiB/s | Round 2 MiB/s | Round 3 MiB/s | Median MiB/s |
| --- | ---: | ---: | ---: | ---: |
| Wrangler | 365.90 | 371.96 | 366.20 | 366.20 |
| Direct core | 518.57 | 565.89 | 541.50 | 541.50 |
| Croc | 1373.48 | 1366.86 | 1353.04 | 1366.86 |

Order rotated Wrangler/core/Croc, core/Croc/Wrangler, Croc/Wrangler/core. Exact numbers, input digest, binary digests and routes are in results.json. Raw process output was removed because it contains invitation secrets and private addresses; the sanitization field records this removal. Original private artifact hashes are in original-hashes.json. No numeric values or hashes were changed.

## Configuration and limits

| Setting | Wrangler | Direct core |
| --- | --- | --- |
| Application | Current CLI and full Worker/v1 DO crypto | Same CLI and freshly bundled full worker/index.ts |
| Runtime | Wrangler local proxy and wiring | startDirectRuntime helper |
| Rate limits | 30/120 | 1000000 |
| DO state | Persisted local state | Ephemeral |
| Compression configuration | no_web_socket_compression | compression:false |
| Assets | Wrangler configuration | false |

This does not isolate a causal proxy cost. Rate limits, state, runtime wiring and assets differ. Actual request/response Sec-WebSocket-Extensions headers were not captured. The optional 16 MiB CD header probe was not attempted; compression negotiation remains unknown. Configuration alone does not prove negotiation.

Timing starts before receiver spawn and ends after the receiver exit event and output capture finishes. It does not wait for the child close event as its endpoint. Full output hashing happens afterward. There is no fsync and OS caches are allowed. Startup/readiness durations were not retained. Load metadata was captured after the run, without per-run normalization. The empty process scan is post-run evidence only.

Final Croc process text is present in private results but separate final log files were not persisted. Public results omit this text. Exact flags remain in compare.mjs. The earlier 16 MiB Croc smoke passed on its first attempt with matching full hash and size; croc-smoke.json retains its results and commands. Its timing is separate and is not pooled.

No production maximum, fastest, WAN or physical-phone conclusion follows. The original phone KB/s symptom and first Chrome RTC failure remain unexplained. Physical-phone testing was explicitly skipped.

## Reproduction and provenance

Source commit: 17db2f94e6278691f3d9816d62a55747c35620d1. metadata.json records source hashes and tool versions. App, Worker and Go sources are unchanged since cf154ff; the intervening diff contains CI and measurement docs. Existing cloud checks at 17db2f9 were reported passing by the parent; this documentation step did not rerun them. Global 8.13 settings were not independently verified here.

compare.mjs and croc-smoke.mjs are copies of the executed sources with only repository imports and the comparison output root made relative. Their private originals have recorded hashes. These are experiment records, not changes to repository benchmark scripts. To reproduce from the repository root with dependencies installed:

```sh
go build -o docs/measurements/browser-stall-2026-11-08/native-runtime-control/cdx ./cmd/cdx
npx esbuild worker/index.ts --bundle --format=esm --platform=browser --outfile=docs/measurements/browser-stall-2026-11-08/native-runtime-control/worker.mjs
node docs/measurements/browser-stall-2026-11-08/native-runtime-control/compare.mjs
```

Provide Croc 11.6.5 at the source's explicit /tmp/cd-croc-11.6.5/croc path and verify its recorded binary hash first. Run in a disposable copy: the source writes results.json, generates 600 MiB, starts local listeners and removes its generated outputs. Exact binary hashes may depend on build environment; compare them before treating a reproduction as identical. The original build invocation was not retained in this artifact; the commands above are reproduction instructions, not a claimed historical shell transcript. Do not commit generated binaries, bundles, state or payloads.

## Excluded attempts

| Batch | Outcome | Treatment |
| --- | --- | --- |
| run-fresh | Two Croc setup attempts failed | Setup failures, not Croc throughput samples; private reports retained |
| run-fixed-20261108a | First Wrangler file verified, then harness accessed an undefined transport array | Harness failure; excluded entirely from final nine |
| run-fixed-20261108a Croc smoke | 16 MiB verified, both exits zero | Separate smoke only |
| run-fixed-20261108b | Nine verified 600 MiB transfers | Only source of the table |

The corrected comparison uses a new input. No batches are pooled. Original scratch remains unchanged; generated payloads had already been deleted by the experiment owner.
