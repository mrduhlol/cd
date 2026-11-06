# Private resumable relay integration

Based on current main `9732bbb7062292cc790f89e62520b3c0b8ad1b27`, with the v2 room protocol recovered from PR #59 (`55c3d055756bbd255205925a7bd096a493a41728`).

The public service answered v1 WebSocket upgrades with 101 and v2 upgrades with 404 during this investigation. The Android v2 sender cannot use that deployment. An invitation must not appear before successful relay admission. Downgrading the client to v1 would discard authenticated resume semantics.

This change adds `/ws/v2/:id` dispatch to the existing TransferRoom class and TRANSFERS namespace, using object names `v2:<id>` and the separate `resume-room` storage key. Existing v1 origin checks, normalized IP budgets, code claim proofs, lookup budgets and leases remain intact. Health retains its original `protocol` field and adds an advertised protocol list.

Two recovered protocol defects are fixed: the replay history now retains both roles for all 128 admitted sessions, and every 32-byte base64url credential/nonce must be canonical so alternate spellings cannot bypass string replay checks. Admission retains fixed root expiry, terminal tombstones, role-token checks and opaque encrypted-record relay. No master key is registered with the existing v1 code directory. No new bindings, namespace, migration or production deployment is included.

## Verification

- `npm test`: 64 passing tests.
- `go test ./cmd/cdx`, `npm run typecheck`, `npm run build`, `npm run deploy:dry`: passed.
- `npm run verify:security`: current-main code security regressions passed.
- `npm run verify:agent`, `npm run verify:browser`: real v1 browser/CLI transfers and code/QR paths passed.
- `npm run verify:v2`: actual Miniflare Worker/DO routes, origins, IPv6 budget, v1 isolation, token checks, hibernation, opaque records, nonce replay and aliases, explicit reconnect, completion ordering, root expiry, full nonce history and session cap passed.
- `CD_V2_VERIFY_CLI=<PR59-binary> npm run verify:v2:cli`: unchanged PR59 CLI transferred 33,554,509 exact bytes across interruption/resume, verified retained progress, and rejected changed source/checkpoint tampering. The supplied binary SHA-256 was `9b79f90a75407c1259fee6bd9ffebd63a3763ba1395d21afb425812dfb1e6ba1`. Current main's CLI is still v1-only.
- Independent read-only review reproduced the canonicalization issue before its fix; 20 concurrent sender trials and 20 concurrent receiver trials each admitted one occupant.

## Remaining release work

No production deployment is authorized. The active observed Worker version was `f570df43-22c3-4cad-833c-1222778380c2` (100%); its exact Git commit is not recorded in remote version metadata. Review the source, build the production assets and obtain explicit deployment approval before changing Worker `cd` on `cd.yash0.in`. Verify v1 and v2 after deployment and retain the previous version for rollback. A rollback to v1-only makes v2 clients unavailable again; do not erase v2 room state.

This backend checkout preserves current-main frontend and CLI. Its browser receiver does not yet implement PR59's v2 receive flow; production QR-to-browser delivery needs a separately reviewed integration of that receiver. Local Android tests can use the unchanged v2 CLI. Private v2 has no secure short pairing code in this change: a code must not be fabricated or implemented by putting the master key into the existing v1 directory.
