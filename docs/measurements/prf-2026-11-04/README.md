# Real-task performance results

**The requested universal 2x target is not achieved.** CD still loses some measured cases. These results measure a busy local machine, not physical LAN, WAN, or phone transfers.

This comparison uses the checksum-verified official croc 11.6.3 release, defaults and compression disabled. Folder tasks enable croc `send --zip`, including preparation and native extraction before success. Earlier exploratory results against installed croc 10.7 are excluded.

Five frozen real inputs cover a small Go file, the project source tree, a gzip archive, a mixed folder with an empty directory, and an existing MP4. All 90 retained transfers preserve every filename, size, SHA-256 and empty directory. Each tool/route/task has three rotated trials. Shared emulator, build and application workloads caused substantial timing variance.

## Receiver-to-durable medians

Milliseconds from receiver launch through recursive file and directory fsync; lower is better. Sender readiness and total handoff times remain in the JSON. The strict 2x gate covers every reported timing metric against both croc modes and fails throughout this suite.

| Task | Route | CD | croc | croc without compression |
|---|---|---:|---:|---:|
| Small source file | auto | 67 | 803 | 704 |
| Small source file | relay | 161 | 147 | 188 |
| Source folder (croc ZIP) | auto | 529 | 1348 | 1389 |
| Source folder (croc ZIP) | relay | 1573 | 1153 | 1068 |
| Gzip archive | auto | 79 | 648 | 659 |
| Gzip archive | relay | 119 | 111 | 150 |
| Mixed folder (croc ZIP) | auto | 526 | 1418 | 1324 |
| Mixed folder (croc ZIP) | relay | 464 | 860 | 811 |
| MP4 video | auto | 75 | 773 | 551 |
| MP4 video | relay | 61 | 162 | 131 |

## Verified changes

- New CLI peers negotiate independent `deflate-v1` chunks before encryption. Existing clients keep raw chunks. Actual Go source compresses to 14% of its input at 132–164 MB/s in the component test. Random/archive fallback samples cost roughly 3–5 microseconds per chunk with no copy. These component figures do not establish transfer speedups.
- Sequential folder extraction reuses a bounded copy buffer, reducing allocation bytes from approximately 1.415 MB to 437 KB per source-folder extraction. File validation, CRC checks, publication order and no-clobber handling are unchanged.
- The restored v2 CI gate found and now rejects noncanonical nonce aliases, preserves replay history through 128 sessions, and applies the existing IPv6 prefix rate budget to v2.

## Limits and validation

Full Go tests, 163 JavaScript tests, nine real-task benchmark tests, targeted race checks, type checking, Worker security/v2/resume-limit checks, CLI-to-browser and browser transfer verification, and deployment dry-run pass. Browser integration confirms legacy raw negotiation remains usable. Physical Android/iOS, WAN, lossy links, large media libraries and concurrent-user performance remain unverified.

Native completion semantics differ. The timed durable metric adds recursive fsync equally to both tools. Existing CD folder extraction closes each extracted file without individually fsyncing it; this PR does not change that native durability behavior.

No paid hosting service, subscription, or production deployment was added. [Free hosting](../../guides/free-hosting.md) describes finite Cloudflare allowances. The connected account billing plan is unverified.

## Reproduce

Build the candidate, generate inputs once, and point `--croc` at a checksum-verified current official release. Use `--croc-zip 1` for folder tasks.

```sh
go build -buildvcs=false -trimpath -o /tmp/cdx-prf ./cmd/cdx
node scripts/bench-real-task-fixtures.mjs /tmp/cd-real-tasks
node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-prf --croc /absolute/croc --input /tmp/cd-real-tasks/mixed --croc-zip 1 --routes auto,relay --storage disk --runs 3 --output /tmp/cd-mixed.json
go test ./cmd/cdx -run '^$' -bench '^BenchmarkChunkCompression$' -benchmem -count=3
CD_UNPACK_SOURCE=/tmp/cd-real-tasks/source-tree go test ./cmd/cdx -run '^$' -bench '^BenchmarkUnpackSourceTree$' -benchmem -count=3
```

Per-task executable hashes and all retained trial timings are in `real-task-results.json`. The final folder cases were rerun after copy-buffer reuse; the single-file cases use the preceding executable and do not call the changed extraction path.
