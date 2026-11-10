# CD Android SDK sample

Run `./gradlew :sdk-sample:installDebug` from the `android/` directory, then open **CD SDK sample** on two devices. On the sending device, choose a file and share the generated invitation with the recipient through any channel you already use. On the recipient device, paste it, review the encrypted file offer, and accept or reject it. The sender remains online until CD reports that the recipient verified the transfer.

The sample writes each receive into a new file in its private cache directory and shows the saved path after verification. Failed or cancelled receives delete their partial output, and an existing received file is not overwritten. The sample is foreground-only; destroying its Activity cancels its transfers. Cache files can be removed by Android. Production apps should choose durable storage and tell users where received files go.

Build and test from `android/` with `./gradlew :sdk:testDebugUnitTest :sdk-sample:testDebugUnitTest :sdk-sample:assembleDebug`. CI runs these tasks alongside the CD app unit tests. Sample unit tests check successful cache output and cleanup after failure or cancellation. SDK unit tests use a local test relay; they do not establish interoperability with the hosted service or a physical device.
