# Free hosting for CD

CD's core can run on Workers Free: static assets plus the existing SQLite-backed `TransferRoom`, `PeerSignal`, `CodeDirectory` and `DeviceRoom` Durable Objects. `ResumeRoomProtocol` runs inside `TransferRoom`; it does not need a separate paid service. Direct TCP/WebRTC carries payload between devices, while the existing WebSocket relay provides fallback. The server forwards encrypted records and keeps transfer metadata; it does not store uploaded file copies.

This is a deployment design, not proof of the connected account's billing plan. No account subscription or production deployment was changed for this PR. Existing custom domains have their own registration cost; a `workers.dev` hostname avoids buying a domain for a new deployment. This repo currently sets `workers_dev: false`; enabling that route and validating its origin policy would be a separate deployment change.

## Free budget

Limits checked on 2026-11-04:

| Resource | Free allowance |
|---|---:|
| Worker requests | 100,000/day |
| Worker CPU | 10 ms/invocation |
| Direct static asset requests | Free and unlimited |
| Durable Object requests | 100,000/day |
| Durable Object duration | 13,000 GB-s/day |
| SQLite rows read / written | 5 million / 100,000 per day |
| SQLite storage across the account | 5 GB |

Worker upgrades consume requests. Incoming Durable Object WebSocket messages count at a 20:1 request ratio; outgoing messages do not. Duration is metered while an object is active. Free operations fail after exhausting a quota; daily allowances reset at 00:00 UTC. SQLite-backed Objects are available on Free; legacy key-value-backed namespaces require Paid. See [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Keep the deployment within that budget

- Keep the account on Workers Free. Do not enable paid TURN, Containers, R2 uploads or a paid subscription for this architecture.
- Preserve `new_sqlite_classes` migrations and WebSocket Hibernation (`ctx.acceptWebSocket`). Keep admission limits, record size limits, buffered-byte limits and expiry alarms enabled.
- Compress plaintext only on endpoints before encryption. The existing `no_web_socket_compression` flag avoids spending relay CPU recompressing ciphertext.
- Keep assets outside `run_worker_first` where Worker routing is unnecessary. Current root, API, relay and design remapping patterns intentionally invoke the Worker and consume its allowance; they become unavailable when the free request allowance is exhausted. See [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).
- Watch Worker requests/CPU and Durable Object requests/duration/storage in the dashboard, including usage from other apps on the same account. Relay traffic and repeated connections still consume finite compute. Do not promise unlimited public transfers or a fixed number of files per day from byte size alone.
- Deploy branch candidates only to the existing isolated test environment; keep the production promotion separate. The repo's `wrangler.jsonc` documents this rule.

Peer-to-peer delivery reduces relay work, but some firewalls require relay fallback. Free quotas constrain availability; neither free hosting nor a protocol rewrite guarantees a 2x speed advantage on a saturated network or disk.
