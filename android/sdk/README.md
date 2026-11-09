# CD Android transfer SDK

`com.yashasvm.cd.sdk` is a standalone Android library for integrating CD's live, end-to-end encrypted file transfer into another app. It has no Activity, Compose, CD app, or UI dependency. The host app owns file selection, invitation delivery, recipient consent, output storage, progress presentation, and cancellation through its coroutine scope.

## Install locally

The SDK is not published to Maven Central yet. Include the `:sdk` Gradle module in a checkout of this repository and add:

```kotlin
implementation(project(":sdk"))
```

Then create the client using the host app's public reverse-domain package identifier:

```kotlin
val cd = CdTransferClient(applicationId = BuildConfig.APPLICATION_ID)
```

This identifier is public attribution metadata. It is not an API key, does not authorize a transfer, and must not be treated as secret. The service validates its shape and records it in transfer admission logs; a modified client can spoof it. The relay continues to apply its IP-based limits. There are no embedded credentials.

## Send

```kotlin
cd.send(
    source = CdFileSource(
        name = "pack.stikrpack",
        mediaType = "application/zip",
        sizeBytes = file.length(),
        open = { file.inputStream() },
    ),
    onInvitation = { invitation -> showShareSheet(invitation) },
    onProgress = { updateTransferUi(it) },
)
```

The callback receives a one-recipient invitation once the relay has admitted the sender. The invitation contains a secret fragment; share it only with the intended recipient. `send` suspends until the recipient accepts, the recipient verifies completion, the transfer fails, or the calling coroutine is cancelled.

## Receive

```kotlin
cd.receive(
    invitation = pastedInvitation,
    acceptOffer = { offer -> showConsentDialog(offer) },
    openDestination = { offer -> openAppDestination(offer.name) },
    onProgress = { updateTransferUi(it) },
)
```

The SDK calls `acceptOffer` with authenticated file metadata before opening the destination or receiving bytes. Return `false` to reject. It closes the destination on failure or cancellation; destination writes are streamed and are not retained in SDK storage. The host app must delete or discard partial output after an exception and publish the received file only after `receive` returns successfully.

## Scope and compatibility

- Android SDK, minimum Android API 26.
- One sender and one recipient per transfer.
- Live transfers only. The sender must stay online; the relay does not persist file contents for later download.
- The SDK implements CD's version 1 file-transfer record protocol (`/ws/v1`). It does not yet implement the native app's resumable v2 protocol, trusted-device workflows, direct WebRTC upgrade, short numeric codes, or offline storage.
- Current sending uses 256 KiB chunks and an acknowledged 4 MiB in-flight window. It accepts incoming 64, 256, and 768 KiB chunks.
- File size is capped at the JavaScript safe integer limit. App callbacks run in the calling coroutine context. Use an IO dispatcher for destination providers if they block.

The API and security contract are described in [the third-party integration RFC](../../docs/third-party-integration.md). The normative wire format is [CD transfer protocol v1](../../docs/agent-transfer-v1.md).

## Run the sample and checks

From `android/`:

```sh
./gradlew :sdk:testDebugUnitTest :sdk-sample:assembleDebug
./gradlew :sdk-sample:installDebug
```

Run the sample on two devices, send a selected file, and copy the invitation into the other device's receive field. The separate CD app is not required. The sample is foreground-only and stores received files in its cache; production apps own lifecycle, notification, and durable storage behavior.
