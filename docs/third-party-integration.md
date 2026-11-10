# Third-party app integration RFC

**Status:** Proposal
**Scope:** Live, end-to-end encrypted file transfers initiated and accepted inside a third-party app.
**Non-goal:** Persistent file hosting or offline downloads. The sender stays online until the receiver completes or cancels the transfer.

## Problem

CD already has a live relay protocol, a browser implementation, and native Android transfer code. A developer can study the protocol and build a client, but there is no supported SDK/API contract for integrating CD into another app. The Android implementation is coupled to CD's application UI, storage, and lifecycle. The wire protocol document alone is not a practical integration kit.

The target experience is that an app such as Stikr can show its own **Share** and **Accept** screens, transfer an archive through CD, and import the received file without asking either user to install the CD app.

## Proposed developer surface

Publish a supported client SDK for Android first, followed by JavaScript/TypeScript and iOS clients. The SDK owns transfer protocol details and exposes app-owned file streams and progress callbacks. The host app owns participant discovery, consent UI, notifications, destination storage, and post-transfer handling.

Illustrative Android API (not yet implemented):

```kotlin
val client = CdTransferClient(
    appId = "com.example.stikr",
    appVersion = BuildConfig.VERSION_NAME,
)

val outgoing = client.createTransfer(
    file = PackArchiveSource(file, mediaType = "application/zip"),
    onProgress = { sent, total -> /* update Stikr UI */ },
)
shareCode(outgoing.invitation)

val incoming = client.accept(invitation)
incoming.receiveTo(destination) { received, total -> /* update Stikr UI */ }
```

The concrete API should support cancellation, lifecycle-safe operation, bounded streaming, transfer status, recipient rejection, and a completion result that means the receiver verified the exact bytes. It should not require a CD Activity or use CD-owned UI.

## App identity and authorization

`appId` is a public identifier, similar to an Android application ID. It is useful for attribution, policy, per-app quotas, and abuse investigation. It is not a credential and must not grant privileges by itself. Any static API secret shipped in an APK, browser bundle, or desktop binary can be extracted and copied.

The first SDK should not require a permanent API key. CD can admit anonymous, short-lived transfer sessions with existing rate limits and limits on size, concurrency, and lifetime. If app-specific quotas or paid tiers are later needed, use a developer registration flow and short-lived app attestations or server-issued credentials. Never put a long-lived server secret in a client app.

## Transfer and privacy contract

- The sender creates a random transfer identifier and cryptographic key locally.
- The receiver invitation carries the key only in a channel that the relay does not receive (for example, a URL fragment or an equivalent encrypted invitation).
- The relay forwards ciphertext and the minimum routing metadata needed to connect the two clients. It does not store file contents.
- The receiver explicitly accepts before file bytes are sent.
- Invitations expire, permit a documented number of recipients, and can be cancelled by the sender.
- SDK callbacks distinguish connecting, waiting for acceptance, transferring, verified completion, rejection, expiry, cancellation, and recoverable failure.
- Apps must tell users that a live sender must remain online. The SDK must not claim that a transfer is durable or available offline.

The current protocol and security model are described in [Agent transfer protocol v1](agent-transfer-v1.md). This RFC proposes supported client libraries around that model; it does not silently change its cryptographic or relay behavior.

## Rollout

1. Extract the native Android sender/receiver transport from the CD app into an Android library module with no Compose or CD UI dependency. Keep CD's own app on the same library so it exercises the public API.
2. Add a sample third-party Android app that transfers one file in each direction and verifies hashes, cancellation, expiry, and explicit receiver consent.
3. Publish the library, API reference, compatibility policy, limits, security contact, and integration guide. Keep the protocol spec normative and versioned.
4. Add JavaScript/TypeScript and iOS SDKs against the same versioned wire contract. Add cross-client fixtures and end-to-end tests before declaring each SDK stable.
5. Only add persistent object storage as a separate product/API if offline or later downloads are required. Live relay and stored hosting have different privacy, abuse, cost, and retention requirements.

## Acceptance criteria

- A third-party app can send and receive without launching or installing the CD app.
- No long-lived secret is embedded in the client.
- CD's own Android app uses the published Android library rather than a private copy of its transport implementation.
- The SDK exposes no file bytes or file keys to application logs and verifies complete content before reporting success.
- A sample app demonstrates transfer, rejection, cancellation, expiry, network loss, and exact-byte verification across supported clients.
- Public limits, service availability, data handling, and deprecation policy are documented before stable publication.

## Open decisions

- Whether the first public Android artifact is distributed through Maven Central or a versioned GitHub package.
- Whether invitations are one-recipient or multi-recipient. The existing relay room admits one receiver, so the first SDK should preserve that limit.
- The production support window and compatibility policy for protocol and SDK versions.
- Whether public apps need any registration beyond package/app identifiers and abuse controls.

## Android implementation

The first implementation is available in [`android/sdk`](../android/sdk/README.md), with a runnable `:sdk-sample` app. It implements encrypted live v1 transfers and explicit recipient consent. The CD app is not required on either device. This is an initial Android library distributed as source; it is not yet a published Maven artifact. App IDs are public attribution, not authentication or per-app quotas. Resumable v2 transfers, other platform SDKs, developer registration, billing, and offline storage remain future work.

The SDK README documents the implemented API, cancellation and failure handling, and timeout limits. The API above remains illustrative. This initial implementation does not complete the rollout or all acceptance criteria: CD's Android app still uses its existing transport, and publication, support and deprecation policies, and full cross-client device verification remain future work.
