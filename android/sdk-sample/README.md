# CD Android SDK sample

Run `./gradlew :sdk-sample:installDebug` from the `android/` directory, then open **CD SDK sample** on two devices. On the sending device, choose a file and share the generated invitation with the recipient through any channel you already use. On the recipient device, paste it, review the encrypted file offer, and accept or reject it. The sender remains online until CD reports that the recipient verified the transfer.

The sample writes received data into its private cache directory to keep the example small. Production apps should choose their own destination, handle duplicate names, and tell users where received files go.
