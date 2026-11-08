# Android public release gates

Audit date: 2026-11-07. Keep the beta label until the physical-device and distribution checks below pass. No physical phone, signing operation or production deployment was performed for this audit.

## Source version

This PR incorporates current main, including the newer `in.yash0.cd.beta` Android app. Earlier development-only Android/account sources imported during this task were superseded. The retained beta receiver is `LegacyReceiver` for v1 and `ResumeReceiver` for v2. Legacy receiving stays on the relay; it does not negotiate the v2-only direct-record assembler. Existing Android sending and share-sheet functionality must remain intact.

Paired transfers use authenticated LAN control and resumable file data, with relay and native WebRTC fallback. Checkpoint acknowledgements and final hashes protect retained progress. The foreground service holds a wake lock during active transfers. Firebase wake-up is optional and absent from the default build. Real wake delivery requires Firebase and Worker configuration, user opt-in and notification permission. A foreground service does not promise delivery after force-stop, reboot or under vendor battery restrictions.

No production release signing configuration exists. Keep the beta package and its update signing identity until a production package, signing key, app-link association and migration plan are reviewed. Do not change the package merely to remove the visible beta label.

## Agent handoffs

The bundled sharing skill and global agent note run `cdx devices --json`. For generated APKs, documents and other requested handoffs they offer paired devices and a download link through the host question tool. An explicit phone request with one pair sends immediately; multiple pairs require a destination choice. The listing shows saved trust, not live connectivity. Existing agents need an updated CLI and `cdx agent setup`.

`cdx send --to phone` resolves the sole saved pair when it has another alias. An exact saved `phone` alias takes precedence. Without that alias, multiple pairs fail with their names before a background sender starts. Targeted sends return a PID and private log when stdout is captured; the process must stay online. Only `phase: verified` confirms receipt. An offline send stays pending instead of silently becoming a link.

## Required physical-device evidence

Run on the intended Samsung S24 Ultra and a second vendor. Record OS/build, APK hash, CLI commit, route, network, file size, SHA-256, timings and failures without credentials. The latency numbers below are proposed release targets, not measured results.

- Pair once with `cdx pair`; send 30 APKs/documents without typing a code. Require 30 correct Downloads files and zero duplicates. Repeat with two paired phones and verify the selected destination receives each file.
- Target offer-to-first-byte p95 of at most 3 seconds while awake on stable LAN and at most 10 seconds on remote relay. Measure 30 sends per route and report p50/p95 separately.
- Send a 1 GiB incompressible file five times per LAN, relay and native route. Require matching hashes, bounded memory and no crash. Compare median MiB/s with the same files and network before making a speed claim. Choose the required speed improvement from this baseline.
- Run 30 screen-off deliveries after 30 minutes idle, then repeat under forced Doze with configured FCM. Target at least 29 starts within 15 seconds and all files eventually correct. Count tap-required delivery separately. Repeat with notifications denied and push disabled.
- Interrupt a resumable 1 GiB transfer ten times through Wi-Fi loss, network switching and process death. Require exact final hashes, retained acknowledged progress and no duplicate publication. Document that legacy v1 transfers restart.
- Verify Stop, Pause and revoke prevent automatic delivery in ten trials each. Test reboot with receiving enabled/disabled. Force-stop must require reopening.
- Fill storage during staging and publication. Require an actionable failure and no corrupt published file. Check cancellation cleanup and filename collisions.
- Measure an eight-hour idle session and a 30-minute screen-off transfer for battery, temperature and service survival. Set the battery budget before release.
- Validate installation/update with the intended signing key, notification actions, verified app links, and permissions on supported Android versions. Repair the local NDK before producing reproducible stripped native packages.

## Suggested improvements

Show device availability and last successful delivery in the agent destination picker. Show the active route, speed, remaining time and reconnect reason on the phone. Add retention controls for transfer history and partial files. Give users a receiving-health check that explains notification, network and battery settings. Prioritize these after the physical release gates rather than claiming unmeasured transport improvements.

## Verification

Current-main integration must pass Android unit tests/lint/assembly, JavaScript and Go tests, TypeScript checking, pairing/push integration and a deployment dry run. Hosted CI and review are separate checks on the latest PR head. No measured physical-phone speed improvement or background reliability guarantee is established by these source checks.

The current-main source passed 158 JavaScript tests, all Go tests and vet, TypeScript checking, the frontend build and Worker deployment dry run. Pairing/reconnect/forged-admission checks passed through the real local Worker. Push policy/authentication checks passed with Google transport mocked. Android unit tests passed 69 tests and lint completed. npm audit reports zero vulnerabilities after the toolchain updates. Physical-device and production-delivery gates remain open.

The restored `verify:v2` CI command exposed and now covers missing health protocol advertisement, IPv6-prefix upgrade limiting, canonical nonce validation and complete replay history through the 128-session cap. The real Worker/DO v2 gate, code-directory security gate and agent/browser integration are required before calling CI green. Already discarded nonce history in existing relay state cannot be reconstructed by this fix.

Release preparation restored the published beta 3 receiving/recovery fixes without replacing main's sending/UI work. The combined Android source passes 83 unit tests and lint with zero errors. Android beta advances to 0.1.8/version code 9, above published beta 3's version code 8. The candidate signing certificate matches the previous beta. This supports a new beta update, not removal of the public-release gates above.

A final review found that dismissing terminal receive history removed transfer-ID replay protection. Dismissed rows now retain their final state and receipt data for 24 hours, stay out of the UI, and are pruned on subsequent offer intake after expiry. Regression tests exercise the production intake/dismissal functions with fresh message IDs and verify hidden history and bounded retention.
