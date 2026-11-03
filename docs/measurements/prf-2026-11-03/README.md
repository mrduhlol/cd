# prf performance work

The universal 2x target is not achieved. All 54 local transfers verified successfully, but the strict 2x gate failed. Loopback on a busy shared host cannot establish LAN, WAN, mobile, folder, or competitor-wide performance.

## Changes

- Reuse encrypted relay record storage only after synchronous writes and only when no retransmission retains it. Regression tests check delivery and retained-record integrity.
- Return usable public ICE SDP without waiting for another unresponsive STUN server. The deterministic UDP test went from 1.002 seconds before the fix to 1.6–15.6 ms after. If all STUN servers fail, the existing one-second bound remains.
- Reuse the sender admission token when deriving its published hash.
- Reject ZIP filenames exceeding the 16-bit UTF-8 byte limit; enforce monotonic sample times after duplicate ACKs.

## Local comparison

Median milliseconds from receiver launch through file and directory fsync; lower is better. Sender readiness and full handoff timings are also retained in croc-results.json and included in the strict gate. Both croc defaults and compression disabled are measured.

| Case | CD | croc | croc without compression |
|---|---:|---:|---:|
| disk/auto/random-4k | 33 | 548 | 542 |
| disk/relay/random-4k | 30 | 243 | 239 |
| disk/auto/random-64m | 236 | 1202 | 851 |
| disk/relay/random-64m | 517 | 1892 | 791 |
| disk/auto/compressible-64m | 209 | 1081 | 752 |
| disk/relay/compressible-64m | 895 | 1260 | 791 |

The allocation microbenchmark against the same main base dropped from about 797 KB per 768 KiB record to 3.2–5.6 KB. Throughput was noisy (before 242–349 MB/s; after 343–372 MB/s), so this is an allocation win, not a claimed 2x end-to-end improvement.

Browser CRC and SHA experiments were discarded because whole-operation measurements did not improve reliably. Rust was unnecessary for the demonstrated allocation and setup costs.

## Reproduce

```sh
go test ./...
node --test src/*.test.js
go test -race -p 1 ./cmd/cdx -run 'TestOfferDoesNotWaitForUnreachableSTUNAfterPublicCandidate|TestRelaySend'
go test ./cmd/cdx -run '^$' -bench '^BenchmarkRelaySend$' -benchmem -count=3
go build -buildvcs=false -trimpath -o /tmp/cdx-prf ./cmd/cdx
node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-prf --cases random-4k,random-64m,compressible-64m --routes auto,relay --storage disk --runs 3 --output /tmp/prf.json
```

The older dirty-workspace measurements are excluded: that snapshot had unrelated changes and is not a valid before/after comparison against this PR.
