# CLI transfer performance

CD first meets the receiver through its relay. For regular v1 CLI handoffs of at least 1 MiB, it also offers an authenticated TCP connection on a local interface. If that connection succeeds, it carries the same AES-GCM records as the relay. When both CLIs support it, the receiver offers its own listener and the sender connects, so a firewall blocking inbound connections at the sender does not prevent TCP. If reverse TCP fails, CD serializes teardown before trying the original forward listener, then WebRTC. The reverse attempt can add up to three seconds before forward fallback. The handshake proves both peers hold the transfer capability and confirms one winning connection before records move.

A LAN offer accepts only literal private addresses on a subnet attached to the receiver and ports at least 1024. Malformed, public, loopback, link-local, and unrelated private targets do not become dial targets. An unavailable TCP connection leaves WebRTC and relay fallback available. Browsers cannot use this TCP lane. Resumable v2 handoffs keep their existing transport and session authentication.

New CLI peers negotiate larger v1 chunks through optional offer and acceptance fields. The advertised base chunk size stays 256 KiB. Existing browser and CLI receivers send the same empty acceptance and keep that size. A new receiver can select the optional larger limit; malformed or unadvertised selections fail. These fields do not change the 1 MiB encrypted-record cap.

The CLI decrypts exclusively owned inbound records in place. It still authenticates each record before passing plaintext to the file writer, validates sequence and byte counts, and fsyncs the received file before success. Folder preparation calculates exact ZIP metadata sizes without checksumming a synthetic payload first.

## Reproduce a comparison

Build a candidate outside a noexec RAM filesystem:

```sh
go build -buildvcs=false -trimpath -o /tmp/cdx-candidate ./cmd/cdx
node scripts/bench-croc-matrix.mjs --cdx /tmp/cdx-candidate --runs 7 --output /tmp/cd-croc-results.json
```

The matrix compares croc defaults and compression disabled. It uses identical random and compressible inputs, rotates tool order, records readiness and receiver completion separately, and verifies every output with SHA-256 outside transfer timing. The stricter durable-completion metric adds file and directory fsync to both tools. A speed gate requires the target multiplier against both croc modes for every reported timing metric. Missing or failed transfers cannot pass.

Local Worker persistence defaults to RAM through `--control-dir /dev/shm`. This keeps local SQLite writes from being confused with transport CPU cost. Disk and RAM output cases still use their named filesystems. Use `--control-dir ~/.cache` for an explicit disk-infrastructure diagnostic. These are local-only benchmark configurations; never deploy `scripts/bench-worker.wrangler.jsonc`. Production admission limits are unchanged.

To isolate paths or record sizing, set these variables for both sender and receiver:

- `CD_DIRECT=0` forces the relay.
- `CD_LAN=0` disables the TCP lane while allowing WebRTC.
- `CD_LARGE_RECORDS=0` disables the optional larger chunk negotiation.
- `CD_TRANSPORT_REPORT=1` emits byte counters, direct protocol, and route labels to stderr.

A loopback score measures this machine's protocol, CPU, and storage behavior. It does not establish internet, browser, Android, or physical LAN performance. A saturated shared link or disk prevents a universal 1.5x multiplier. Publish per-case results and failures instead of extending a measured win to untested paths.

## Negotiated plaintext compression

New ordinary CLI peers offer and accept `compression: "deflate-v1"`. Clients that do not select it keep the original raw chunk format. Resumable v2 transfers and browser/Android clients keep their existing format.

After negotiation, each encrypted `kindChunk` contains either a zero byte followed by raw bytes, or a one byte, a four-byte big-endian raw length, and an independent DEFLATE stream. Compression happens before encryption. ACKs, transfer sizes, and retransmission release offsets count original bytes. The receiver bounds each expanded record by the negotiated chunk size, requires the exact declared length, and rejects truncation or trailing bytes before writing it.

The sender samples each chunk to avoid compressing high-entropy content, and keeps compressed output only when it saves at least 10%. A reusable standard-library BestSpeed compressor avoids a new allocation per chunk. Compression can still cost CPU on very fast links; set `CD_COMPRESSION=0` on either endpoint for an A/B comparison. No new relay service or hosted storage is required. See [free hosting](free-hosting.md) for finite Cloudflare Free allowances.

To compare ordinary files and folders, freeze the inputs once, then use the printed commands for both binaries:

```sh
node scripts/bench-real-task-fixtures.mjs /tmp/cd-real-tasks
node scripts/bench-croc-matrix.mjs --cdx /absolute/cdx --input /tmp/cd-real-tasks/mixed --routes auto,relay --storage disk --runs 3 --output /tmp/cd-real-results.json
```

The matrix verifies names, sizes, hashes, and empty directories outside the timing interval. Both tools receive the same frozen input and complete the same recursive file/directory fsync check. A local test does not establish physical-network performance.
