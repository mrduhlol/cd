# Optional Firebase wake-up

The default Android build has no Firebase SDK or messaging service. LAN, WebRTC and relay receiving work without a Firebase project. The preview APK remains this default build.

## Configure a build

Follow the repository's [Firebase setup guide](../../docs/guides/firebase-setup.md). Register the Android package `in.yash0.cd` in your own Firebase project and place its downloaded configuration at `android/app/google-services.json`. This ignored file contains client configuration, not a server service-account key. Keep service-account credentials on the Worker; never put them in the Android project or APK.

```sh
cd android
./gradlew :app:assembleDebug :app:testDebugUnitTest :app:lintDebug -PcdFcm=true -PcdAbi=arm64-v8a
```

The APK is `app/build/outputs/apk/debug/app-debug.apk`. Omitting `cdAbi` includes all supported native architectures. `cdFcm=true` without the configuration file fails with an explicit setup error. Normal builds omit Firebase even if the configuration file exists. The optional manifest adds FCM declarations to the base manifest, preserving all receiver permissions and intent filters.

Install the configured APK, allow notifications, enable receiving, pair your laptop, then enable **Trusted wake-up notifications**. This setting defaults to off and only appears in a Firebase-configured build. It does not enable receiving by itself. It can take a successful relay connection before the status changes to enabled.

## Registration and revocation

Firebase Messaging uses the current Firebase installation ID API. The optional manifest enables `firebase_messaging_installation_id_enabled` and disables messaging auto-initialization and Analytics collection. CD only enables messaging auto-initialization after the user's separate opt-in. CD depends on Messaging, not Firebase Analytics.

`FirebaseMessaging.register()` runs after opt-in and on process startup. The SDK's `onRegistered(installationId)` callback handles initial registration, routine registration refresh and installation-ID changes. CD caches the FID in its encrypted vault. After authenticated **relay** admission, it posts the FID and receiver admission credential to that relay origin's `/api/devices/v1/<pairId>/push-target`. LAN admission never triggers registration, and relay credentials never go to a discovered LAN endpoint. Target uploads refresh on a new relay admission or FID callback. Failed requests retry during active receiver maintenance. No registration credentials, FIDs, URLs or file metadata enter diagnostic logs.

Target requests require HTTPS and disable redirects. Explicit `ws://127.0.0.1`, `ws://[::1]`, or `ws://localhost` test relays may use HTTP; private LAN addresses and emulator `10.0.2.2` are not exceptions. Target HTTP requests bind to a currently permitted Android network, including DNS. CD also waits for a permitted network before explicitly calling Firebase registration. Google Play services manages FCM's own connection and SDK metadata traffic; that small wake-up traffic may use mobile data after push opt-in. The separate mobile-data switch continues to control file-transfer traffic and CD's target requests.

Turning the setting off durably queues target deletion before clearing CD's cached FID. CD disables messaging auto-init and calls `unregister()`; it does not delete the Firebase installation. Revoking a laptop persists the scoped receiver deletion credential before removing the trusted pair, so its target can still be removed. Pending deletions remain encrypted and retry when CD is next opened or its active receiver performs maintenance on a permitted network. An offline deletion is therefore not immediate on the server. Local trust checks reject revoked-pair hints immediately. A pending deletion must finish before a later opt-in uploads a new target for that pair.

## Delivery policy

A wake hint contains exactly `v`, `type`, `pairId` and epoch-millisecond `issuedAt`. It contains no file content, invitation, filename or cryptographic secret. CD validates version/type, a currently trusted pair, notification permission, the push opt-in and the receiving switch. It accepts hints up to 300 seconds old and 30 seconds in the future. The encrypted vault persists the highest accepted issue time and a 20-second coalescing window per pair, so replays and rapid duplicate hints do not repeatedly restart the service.

Only a message delivered with `RemoteMessage.PRIORITY_HIGH` can request the receiving foreground service. CD checks delivered priority, not original priority. A downgraded message shows a generic tap-to-open notification. A rejected foreground-service start also falls back to that notification. The receiving service rechecks the same eligibility policy before reconnecting. It replaces that pair's potentially half-open control sockets, while keeping active file data intact. It never changes the receiving switch for a push wake, and it never resumes paused transfers. Normal receiving shows its existing notification with Stop and progress.

Delivery is best effort. Doze, Google Play services availability, Android priority downgrades, Samsung battery management and force-stop behavior still apply. A force-stopped app must be opened by the user. Stop stays stopped. No boot receiver or silent battery-optimization exemption is installed.

## Verify without project credentials

The following command compiles the actual Firebase SDK integration and runs its unit tests and lint without Google resource processing:

```sh
cd android
./gradlew -PcdFcm=true -PcdFcmCompileOnly=true :app:compileDebugKotlin :app:testDebugUnitTest :app:lintDebug
```

`cdFcmCompileOnly=true` rejects APK/AAB packaging, assembly and installation tasks. It is a build-check mode, not a runnable app. No synthetic project, API key or service-account credential is needed. A configured APK and real FCM delivery still require your project configuration and a Worker configured for that project. The Firebase-free build is checked separately with the normal assemble/test/lint command.

Policy tests cover delivered priority, notification denial, opt-out, Stop, revoked/unknown pairs, timestamp boundaries, malformed hints, replay/coalescing and TLS-only target origins. Target-request tests use the shared paired protocol fixture to prove the receiver credential and exact POST/DELETE bodies.

## Dependencies and primary sources

Firebase Messaging is pinned to `com.google.firebase:firebase-messaging:26.0.0`; its minimum Android API 24 is below CD's API 29. The optional Google Services plugin is pinned to `com.google.gms:google-services:4.5.0`. Both versions and artifacts were verified against [Google Maven](https://maven.google.com/) and the [Firebase Android release notes](https://firebase.google.com/support/release-notes/android). The optional build constrains Google Play services' old transitive Fragment dependency to AndroidX Fragment 1.8.6, compatible with Activity Result APIs and CD's compile SDK 35. See its [official release notes](https://developer.android.com/jetpack/androidx/releases/fragment#1.8.6).

The implementation follows Firebase's [Android registration guide](https://firebase.google.com/docs/cloud-messaging/android/get-started), [FID registration lifecycle](https://firebase.google.com/docs/cloud-messaging/manage-tokens), and [Messaging API reference](https://firebase.google.com/docs/reference/android/com/google/firebase/messaging/FirebaseMessaging). Background delivery follows [Android's foreground-service restrictions](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start) and Firebase's [message-priority guidance](https://firebase.google.com/docs/cloud-messaging/android/message-priority).
