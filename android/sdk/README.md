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

Call `send` and `receive` from a coroutine, such as `lifecycleScope.launch` in an Android Activity. The callback receives a one-recipient invitation once the relay has admitted the sender. The invitation contains a secret fragment; share it only with the intended recipient. `send` suspends while waiting for acceptance and sending the file. It returns after the recipient verifies completion, or throws if the transfer fails or the calling coroutine is cancelled.

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

## Cancellation, failures, and client lifetime

Cancel the calling coroutine's `Job` to stop a transfer. Keep the client for as long as its host component needs it, then call `cd.close()` when that component is destroyed. Closing the client stops its active transfers and prevents new ones. The SDK does not keep a transfer alive after the host app stops it.

For a cache-backed destination, use a new file for each receive and remove it if the transfer does not finish. This example uses AndroidX `lifecycleScope`; the app supplies its consent and result UI:

```kotlin
import java.io.File
import java.io.OutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import androidx.lifecycle.lifecycleScope

val receiveJob = lifecycleScope.launch {
    var output: File? = null
    var destination: OutputStream? = null
    var complete = false
    try {
        cd.receive(
            invitation = pastedInvitation,
            acceptOffer = { offer -> showConsentDialog(offer) },
            openDestination = {
                withContext(Dispatchers.IO) {
                    File.createTempFile("cd-received-", ".part", cacheDir)
                        .also { output = it }.outputStream().also { destination = it }
                }
            },
            onProgress = { updateTransferUi(it) },
        )
        complete = true
        showReceivedFile(checkNotNull(output))
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (rejected: CdTransferRejectedException) {
        showTransferRejected()
    } catch (failure: Exception) {
        showTransferFailure(failure)
    } finally {
        withContext(NonCancellable + Dispatchers.IO) {
            runCatching { destination?.close() }
            if (!complete) output?.delete()
        }
    }
}

cancelButton.setOnClickListener { receiveJob.cancel() }
```

Add imports for the SDK classes from `com.yashasvm.cd.sdk`. A successful return means the receiver authenticated the ordered records and checked the final byte and chunk counts. Publish or import the output only after that return. The sample uses cache storage; Android can remove cache files, so move successful output to durable app storage when needed.

Returning `false` from `acceptOffer` makes the local `receive` call throw `CdTransferRejectedException`. The sender sees the receiver disconnect and cannot distinguish rejection from other disconnects. Other protocol or transport failures throw exceptions; there is no stable error-code or automatic retry API yet. A retry creates a new live transfer rather than resuming partial output. Do not log invitations or include their secret fragments in error reports.

The SDK allows 15 seconds to open a relay socket, then 10 seconds for sender admission or 15 seconds for receiver admission. A sender waits up to 10 minutes for a recipient and another 10 minutes for acceptance. A receiver waits up to 15 minutes for an offer. Record waits after acceptance time out after 90 seconds. These waits throw `TimeoutCancellationException`, a `CancellationException`; preserve cancellation when handling errors. The relay also enforces a two-hour room lifetime. The SDK does not expose a separate expiry callback.

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
./gradlew :sdk:testDebugUnitTest :sdk-sample:testDebugUnitTest :sdk-sample:assembleDebug
./gradlew :sdk-sample:installDebug
```

Run the sample on two devices, send a selected file, and copy the invitation into the other device's receive field. The separate CD app is not required. The sample is foreground-only and stores received files in its cache; production apps own lifecycle, notification, and durable storage behavior.
