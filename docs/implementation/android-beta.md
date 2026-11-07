# Android and CLI beta, October 2026

PR #60 continues as an Android beta and adds the missing CLI/relay peers. The older handoff document describes a stopped rollout and the earlier preview, not this release.

- Android `0.1.1-beta.1`, package `in.yash0.cd.beta`, installs alongside CD and CD Preview. Its history and pairings start empty. APKs use this build machine's Android debug signing key; no key is committed or uploaded.
- CLI `v0.4.0-beta.1` adds `cdx pair`, `devices`, `send --to`, resumable private sends and receiving Android private links. `cdx pair` always prints a beta notice to stderr.
- Android sends remain private v2 links. The web receiver and this CLI beta can receive them. Android also receives ordinary v1 private links and numeric codes from the website or CLI. Numeric codes use the relay directory; they are not end-to-end encrypted. V1 transfers restart with a fresh link after interruption; only v2 supports retained progress. Legacy multi-file bundles are saved as ZIP archives on Android.
- The server retains v1 and adds v2 plus authenticated device channels. Migration v4 adds DeviceRoom without replacing existing Durable Object identities.
- The browser retains completed v2 staging files until their existing retention expiry so an asynchronous download cannot lose its backing file. The next expiry cleanup removes them.
- QR scanning uses a portrait activity with camera permission recovery, a dark scanning frame, back and flashlight controls.

## Install

Download the ARM64 APK from the beta release. Install the matching terminal beta explicitly:

```sh
curl -fsSL https://cd.yash0.in/install.sh | CDX_VERSION=v0.4.0-beta.1 sh
cdx pair
```

The stable installer and `cdx update` continue to select stable releases. Pairing is foreground-first: keep CD open while receiving. Push wake-up is not configured by this beta.

## Build

```sh
cd android
ANDROID_HOME=/path/to/android-sdk ./gradlew --max-workers=2 -PcdBeta=true -PcdAbi=arm64-v8a testDebugUnitTest lintDebug assembleDebug
```

The user requested no emulator testing for this release. Physical-device camera behavior and native transfers still need their install feedback. JVM protocol fixtures, Android compilation/lint, Go and JS tests, local browser transfers, CLI interrupted resume, and hosted v1/v2/pairing checks provide the automated coverage.

## Release verification

- 55 Android JVM tests, lint with no errors, ARM64 APK assembly.
- Go suites and 84 JavaScript tests passed; TypeScript and production build passed.
- Browser private links, pasted links, QR input and 8 MiB interrupted resume passed exact-byte and private-key disclosure checks.
- CLI restart recovered 262,144 retained bytes and verified 33,554,509 bytes; modified-source and checkpoint-tamper rejection passed.
- Hosted staging v1/v2 relay and paired-device authentication/reconnect checks passed.
- Production deployment: `f759bf5e-be03-480f-9b2d-3fd848f72da3`.
