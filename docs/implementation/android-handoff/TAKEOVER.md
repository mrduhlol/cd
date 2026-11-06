# Android CD handoff (2026-10-19)

## Scope and stop state

The user requested a draft PR for their local agent to finish. Rollout and browser testing stopped at 17:06 UTC. Do not merge or deploy automatically. No Claude models were used in this cloud continuation; the user explicitly prohibits further Claude use.

This branch is based on current main `9732bbb7062292cc790f89e62520b3c0b8ad1b27`, not a wholesale merge of PR #59. It combines:
- Android tree and runtime harness byte-for-byte from `a4e49786b37a99c594f67e86d8826c2e74ad2e52`, derived from PR #59 (`55c3d055756bbd255205925a7bd096a493a41728`).
- Selective v2 Worker/browser integration on hardened main through `4c135f3e8e065f498da0557a4aef16f6e90432b2`, plus test-only diagnostics `2a7ab01e79a5ea13442a36141894ece97fd731f6`.

Main's existing CLI receive-path security fixes, directory proof/rate/lease limits, origin checks, and v1 compatibility are preserved. The old PR #59 Worker/browser/CLI are NOT substituted for main. PR #59 remains open/unmodified; its v2 CLI is used only as a pinned interoperability test peer, not proposed as a replacement for main's CLI here.

## Android changes and exact delivered APK

Invitation/QR publication waits for authenticated relay acceptance. State survives navigation/recreation, pause and interruption; completion/cancel/expiry removes the invitation. Transfer identity includes direction, self-receive is rejected, and terminal-history trimming no longer evicts active waiting transfers. Navigation transitions are restrained and copy/share labels avoid displaying a raw private URL. Relay/source failures are actionable.

The delivered `CD-Preview-arm64.apk` is a side-by-side preview:
- applicationId `in.yash0.cd.preview`, label `CD Preview`; fresh history/pairings.
- Unique provider authority and preview-only pairing scheme/web host avoid intercepting existing CD links.
- SHA-256 `94572b3f83aff2d52a6350316fe835b2c6a5a5265ed0ecadf83d5f4ff9fbe070` (39,908,656 bytes).
- Its app source is unchanged from application commit `aab7bb4`; subsequent Android commits are test-only. The full exact source is the Android tree in this PR. No existing signing key was copied. A fresh cloud debug key signed it; no signing key is included in this PR.
- The user received and ran this APK; production currently returns its expected unsupported-private-relay error. Reinstalling does not solve that server dependency.

Build with JDK17, Android SDK35 and Gradle8.13:

```sh
cd android
./gradlew -PcdPreview=true -PcdAbi=arm64-v8a assembleDebug
./gradlew -PcdPreview=true testDebugUnitTest lintDebug assembleDebugAndroidTest
```

No Firebase setup is required for basic foreground transfer. Optional FCM source is inherited from PR #59 and is not configured by this handoff.

## Completed verification (do not conflate environments)

Cloud build: application and instrumentation APK assembly, 53 JVM tests (zero failures/errors), lint with no errors. ARM64 and x86_64 artifacts have byte-identical DEX/resources/manifest; native ABI differs.

Actual API29 x86_64 software emulator, supported ANGLE+SwiftShader renderer, local v2 relay:
- QR pixels decoded to the exact accepted private invitation before and after scrolling.
- Both rotations caused real Activity recreation and retained the transfer screen.
- Waiting and mid-data process interruption/resume retained the invitation.
- 1,048,576 retained bytes resumed; all 33,554,432 received bytes matched source SHA-256 `2439a01839f32efe5b96967de49ad51a0f487f6b05695ce1a72e27e3e9292a42`.
- Completion hides invitation; self-receive, pause/immediate resume, cancellation persistence/source cleanup passed.
- HTTP404 and unreadable-source errors were actionable and exposed no premature invitation.
- API35 software emulation hit startup ANRs; initial API29 renderer had corrupt captures. Those were NOT counted as passes. No physical ARM64 device or API35 runtime pass is claimed.

Backend/browser: 84 JS tests, seven diagnostic/redaction tests, TypeScript and production build passed. Real local v1/v2 security/replay/expiry/concurrency and encrypted CLI interrupted-resume checks passed. The browser queue fix raises only its byte bound to 4,194,752 (4MiB plaintext plus16x28 bytes framing), retaining the16-record cap; legal sender window acceptance and byte/record overflow rejection have regressions.

## Deployment state at handoff

- Staging `cd-test.yash0.in`: candidate runtime `4c135f3`, current version `b4d16832-35f1-48a6-9896-38ec872373b7`, deployed from cloud at17:01UTC.
- Previous staging v3 version `fab4f48e-5391-4c85-9c7d-968a9d7ce0b8`.
- Older staging v2 version `0269452f-3a3b-4da9-90fa-bd0fc547e7d3` cannot be directly rolled back after the approved CodeDirectory/v3 migration (Cloudflare rejected10210). Never delete storage to force rollback. Preserve current DO identities/bindings/migration history.
- Production `cd.yash0.in` and `design.yash0.in` were NOT changed. Last recorded production version `f570df43-22c3-4cad-833c-1222778380c2`; recheck before any future action.
- Credentials are NOT included. Wrangler OAuth was saved by its normal cloud login flow only. Do not copy credentials from cloud or omarchy, and do not assume persistence after a full cloud reset.

## Staging evidence and remaining gates

Managed cloud browser direct-link transfer on the current staging version passed: downloaded1,048,653 synthetic bytes with SHA-256 `f7dfceaeeec681281b3c0478d2f7639e1ef6622870fab901187de53f904b101b`, exact source match, private fragment cleared, UI verified completion, sender exit0.

This is NOT the full browser gate. Pasted-link input was denied before execution over the user's Android-focused scope; no bypass/retry occurred. The user then stopped rollout. QR-scanner, interrupted browser resume and captured no-directory/no-key-on-wire assertions remain incomplete on current staging. Actual Android-to-hosted-staging testing was cancelled before starting. Production end-to-end is unverified.

Earlier staging diagnostics: an immediate fragment assertion raced the lazy-loaded receiver; bounded readiness fixed that test issue. A separate direct transfer succeeded, while a later pasted-link test timed out after pairing. Logs did not establish whether its cause was transport or protocol. 'Connecting securely' remained displayed during transfer, so it was not proof of failed admission. The harness now waits120s (beyond existing90s protocol timeout) and records sanitized header-kind/sequence/length/progress metadata; it never logs payloads, keys or proof material. Do not claim the later stall is diagnosed.

Raw headless Chromium through the cloud proxy raised a certificate authority error. No HTTPS-error bypass or trust change was performed. The supported managed cloud browser loaded normally and completed the direct transfer.

## How to continue locally

1. Review this draft and retain main's security protections. Do not merge PR #59 wholesale.
2. Build the APK above; test on an actual Android device. See `scripts/verify-android-send.py` (intentionally local-relay-only) and Android instrumentation for repeatable lifecycle/failure coverage.
3. For the pinned v2 interoperability peer, build PR #59 commit `55c3d055756bbd255205925a7bd096a493a41728` in a separate worktree with Go1.26.9: `go build -buildvcs=false -trimpath -o /absolute/path/cdx-v2 ./cmd/cdx`. Main's CLI deliberately remains untouched in this PR.
4. With a properly trusted local Chromium, run `CD_VERIFY_URL=https://cd-test.yash0.in CD_V2_VERIFY_CLI=/absolute/path/cdx-v2 node scripts/verify-v2-browser.mjs`. Keep all byte/privacy/resume assertions. Review sanitized diagnostics on failure. Do not bypass browser certificate warnings.
5. Recheck staging/production versions and obtain any needed fresh deployment authorization. No production promotion is authorized merely by merging this draft.

Secure short numeric codes remain unresolved: the legacy v1 directory exposes the master transfer key and is not a safe transparent fallback for private v2. Keep QR/private-link sharing; do not advertise fake codes or silently downgrade privacy. A secure code design needs separate review.

No APK binaries, raw private transfer logs, test payloads, credentials, signing keys, or generated deployment assets are committed.
