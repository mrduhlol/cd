# Android public release gates

Audit date: 2026-11-07. Keep beta branding until these gates pass. No physical device, emulator, signing operation or publication was performed in this audit.

## Current implementation

QR pairing uses an expiring private invitation and explicit Trust. Account receiving uses Clerk device authorization and phone-specific P-256 encrypted pairing. Account configuration in `Account.kt` points to a development Clerk instance and `cd-test.yash0.in`; production account delivery remains blocked on production configuration and end-to-end verification. Code-free delivery means no transfer code after enrollment, not zero enrollment.

The foreground receiver keeps authenticated LAN and relay control connections. Its scheduler rotates ready transfers and backs off failures. Resume transfers checkpoint before acknowledgments and verify final hashes before MediaStore publication. Ordinary transfers cannot resume. Native WebRTC can replace relay chunks; successful compilation does not prove that route works on a phone. Active transfers renew a timed wake lock; idle receiving has no wake lock. The boot receiver attempts restoration only when receiving remains enabled.

Firebase is optional and absent from the default build. Real wake delivery requires the Android Firebase configuration, matching Worker configuration, user opt-in and notification permission. Compile-only Firebase mode cannot produce a runnable APK. No release signing configuration exists in `app/build.gradle.kts`; assembly alone is not a distributable signed release. Verify signing certificate association for HTTPS app links before distribution.

## Required physical-device evidence

Run on the intended Samsung S24 Ultra and a second vendor, covering API 29 and current supported Android versions where hardware is available. Record OS/build, APK hash, CLI commit, route, network, file size, SHA-256, timings and failures without credentials.

- Pair once with `cdx pair`; send 30 files without a code or confirmation per file. Require 30 correct Downloads files and zero duplicates. Repeat account enrollment and delivery separately against production configuration.
- Define instant delivery as offer-to-first-byte p95 at most 3 seconds while awake on stable LAN and at most 10 seconds over remote relay. Measure 30 sends per route; report p50 and p95 separately.
- Send a 1 GiB incompressible file five times per LAN, relay and native route. Require matching hashes, no dropped records, bounded memory and no crash. Record median MiB/s and compare with the same CLI/browser baseline on the same link. Agree a speed target before claiming faster performance.
- Run 30 screen-off deliveries after 30 minutes idle, then repeat under forced Doze with configured FCM. Require at least 29 starts within 15 seconds and all files eventually correct. Record fallback notifications and delivered priority separately. Repeat with notifications denied and push disabled; do not count tap-required delivery as automatic success.
- Interrupt a resumable 1 GiB download at least ten times through Wi-Fi loss, network switching and process death. Require eventual exact hash, no duplicate publication and retained acknowledged progress. Confirm ordinary transfers show the documented new-link requirement.
- Verify Stop, Pause, revoke and account sign-out prevent subsequent automatic delivery in ten trials each. Reboot with receiving enabled and disabled; verify restoration behavior and visible notification. Force-stop must require reopening.
- Fill storage during staging and publication. Require actionable pause, no corrupt Downloads entry and retained resumable progress. Cancel must remove retained files. Verify filename collisions preserve both files.
- Measure an eight-hour idle session and a 30-minute screen-off transfer for battery, temperature and service survival. Set the battery budget from this evidence before release.

## Build and integration dependencies

Use `./gradlew testDebugUnitTest lintDebug assembleRelease` for the default build. Use `-PcdFcm=true -PcdFcmCompileOnly=true compileDebugKotlin testDebugUnitTest lintDebug` to check Firebase source without packaging. Configured Firebase packaging is a separate required check.

Tests read root `fixtures/` through the Android test resource path. A clean branch needs `fixtures/account-pair-v1.json` in addition to existing device/resume fixtures. This PR includes Worker account routes, account authorization tests, the account directory binding and migration, and CLI enrollment/send dependencies. Production still requires the OAuth client secret and matching production endpoints; no credentials are committed.

Suggested next improvements are production account configuration, reproducible signing and app-link verification, and instrumented route/start timing on physical phones. Avoid transport tuning until comparable hardware measurements identify the bottleneck.

## Audit check results

The default online Gradle run passed `testDebugUnitTest lintDebug assembleRelease`: 41 tests, zero failures/errors/skips. Lint completed with warnings. Release packaging warned that the local NDK lacked `source.properties` and native libraries could not be stripped; repair the build machine before a reproducible distribution build. Offline execution failed because dependencies were not cached. An initial flavor-style task name was invalid; Firebase selection uses project properties rather than product flavors.

No runtime bug was reproduced during this source audit, so no speculative transport change or regression test was added. The concrete corrections are stale boot-restoration claims in Android README and push documentation. Existing tests cover pairing cryptography, control admission, transfer validation, durable scheduling, native record pressure and push policy. They do not replace the physical-device gates above.

Firebase compile-only `compileDebugKotlin testDebugUnitTest lintDebug` also passed. This verifies SDK integration compilation and policy tests, not configured push delivery or APK packaging.

## Agent delivery changes in this PR

The bundled skill and global agent note discover saved pairs with `cdx devices --json`. For generated APKs, documents and other requested handoffs they offer paired devices and a download link through the host question tool. An explicit phone request with one pair sends directly; multiple pairs require a destination choice. Pair listings do not indicate live connectivity. Updating existing agents requires rebuilding/installing this CLI and rerunning `cdx agent setup`.

`cdx send --to phone` resolves the sole saved pair when its alias is the model name. An existing exact `phone` alias takes precedence. Without that alias, multiple pairs fail with their names before a background sender starts. Tests cover exact names, model aliases, ambiguity, and the empty store account fallback. Successful delivery still requires `phase: verified` in the private sender log.

## Improvements after the release gates

Add a destination picker with device availability and last successful delivery in the agent integration. Show the active route, speed, remaining time and actionable reconnect status on the phone. Add configurable cleanup for completed transfer history and retained partial files. Android-to-computer sending and share-sheet integration are useful follow-ups after paired receiving is dependable.

## Final source checks

An exported source tree passed 120 JavaScript tests, all Go tests and vet, TypeScript checking, frontend build and Worker deployment dry run. Native Android passed all 41 unit tests, lint and release assembly from a clean export. Real CLI/Worker pairing and reconnect checks rejected forged credentials and preserved active peers. Account isolation/revocation and push policy checks passed in local Durable Objects; Google transport was mocked.

The existing toolchain had six high-severity npm advisories. Miniflare, Vite and Wrangler were updated to patched versions; npm audit reports zero vulnerabilities. JavaScript tests, pairing, account/push integration, type checking and deployment dry run passed again with those versions. Hosted CI and review remain separate checks on the PR.
