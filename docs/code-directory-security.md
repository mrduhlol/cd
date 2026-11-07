# Share-code directory controls

Numeric codes remain bearer capabilities. Anyone who guesses a live code can receive its file. These controls bound online guessing; they do not add entropy or sender confirmation. Full links keep the key out of the directory.

## Lookup budgets

Every lookup spends one durable token for the requesting IPv4 address or IPv6 /64, then one for the code's first-digit shard. Both hits and misses spend tokens before either the current directory or legacy directory is queried. Failed guesses never burn a particular code.

Each prefix gets a burst of 12 lookups and refills at 12 per minute. Each of the ten shards gets a burst of 30 and refills at 60 per minute. Across arbitrary address rotation, the aggregate maximum is 300 initial probes plus 600 per minute. The existing edge limit of 30 connections per minute remains an additional bound. It uses the same canonical address prefix, but its eventually consistent counters are not the security boundary.

Twelve lookups per minute permits one new receive every five seconds, with a burst for retries. One prefix can spend at most 40% of one shard's initial burst and 20% of its refill rate. It cannot exhaust that shard by itself. Sharding avoids making a single exhausted budget disable every numeric code.

The prefix parser uses URL IPv6 normalization before expanding the address into eight words and taking the first four. It joins expanded, compressed, uppercase, and lowercase variants. IPv4-mapped IPv6 addresses use the corresponding IPv4 bucket. Invalid or missing addresses share the `unknown` bucket. Cloudflare must supply `CF-Connecting-IP`; callers must not be allowed to override that header at another proxy.

The budgets use synchronous SQLite read/debit/write operations inside existing `CodeDirectory` objects. They survive object eviction. Denied requests cannot extend a lockout. Tokens refill with elapsed time, so a prefix can retry after five seconds and a shard after one second. HTTP 429 responses advertise a conservative five-second retry delay. Code responses use `Cache-Control: no-store`.

These finite budgets trade availability for a bound on guessing. Sustained attackers with multiple independent network prefixes can throttle numeric lookups in a chosen shard. One prefix cannot consume the whole directory's burst or sustained capacity. Other shards, code creation, and full-link receiving remain independent. This is a bounded temporary throttle, not a permanent global lock or a claim of cryptographic resistance to a distributed attacker.

The legacy `cdx.yash0.in` fallback remains because released cdx v0.1.0 registers there. A local miss makes at most one legacy request, within the same prefix and shard budget. A throttled request makes none. The fallback retains its five-second timeout.

## Claim authorization and holding limits

Browser code requests and relay/signaling upgrades require the request's own origin. A present `Origin` must match exactly; opaque, sibling, and foreign origins fail. Native clients without `Origin` remain supported. Fetch Metadata identifying a cross-site or sibling-site request also fails when `Origin` is missing. POST requires `application/json` and reads at most 256 bytes.

POST dispatches through an internal binding to the transfer room. The room must be waiting, unexpired, and have a live admitted sender. The supplied master key must derive the receiver-token hash stored at admission, using the existing HKDF protocol and a timing-safe comparison. Join-time `shareKey` claims use this same path. Unadmitted, mismatched, paired, closed, and expired rooms cannot claim.

Supported old clients already join before POST. Their call order and payload stay unchanged. Concurrent retries share one in-flight claim and return the existing unexpired code. A room admitted by older Worker code without a captured prefix cannot create a new claim after upgrade; reconnecting creates an admission with the required prefix.

Each sender prefix can hold at most 16 unexpired claims across all code shards. Sixteen slots allow multiple users behind one NAT while limiting one prefix to 0.16% of the directory's 10,000-code holding capacity. The sender's admission prefix owns the reservation, even if POST comes from a different address. A random lease identifies each reservation. Pairing, cancellation, and room expiry release the code and lease. Expired leases are removed on reservation and by alarms. Stale releases cannot free another lease. If an internal claim fails ambiguously, its lease remains until the 15-minute expiry; it cannot evade the bound through retries.

Room completion can interleave with a cross-object claim. The claimant rechecks the room after reservation and directory publication and releases a claim whose sender has left or paired. Abrupt crashes can leave a bounded orphan until expiry.

Issue #47 remains unchanged: terminal rooms reset after five minutes, so a holder of an old full capability can re-host it. These directory changes do not alter room reuse semantics.

## Run the boundary regressions

Run `npm run verify:security`. The script bundles the actual Worker, uses the configured compatibility date and bindings in local workerd, and isolates SQLite in a temporary directory. Its outbound handler supplies only a fake legacy response and rejects any other egress. It tests HTTP and WebSocket boundaries, cross-object calls, concurrent claims, prefix rotation, aggregate bounds, eviction, refill, slot cleanup, expiry, and legitimate lookup. It never probes production.

Run `CD_SECURITY_BASELINE=1 npm run verify:security` to reproduce both original attacks against pinned commit `8520156`. That command is expected to fail its security assertions.

## Runtime references

The implementation preserves the repository's existing compatibility date, generated types, and Wrangler version. API behavior was checked against Cloudflare's [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), [alarms API](https://developers.cloudflare.com/durable-objects/api/alarms/), [WebSocket API](https://developers.cloudflare.com/workers/runtime-apis/websockets/), and [HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/). The local suite uses the installed Miniflare APIs alongside its [Durable Objects testing reference](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/).
