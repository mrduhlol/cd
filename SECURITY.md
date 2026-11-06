# Security policy

## Supported versions

Security fixes are released only for the latest version on the default branch.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do
not open a public issue containing an unpatched vulnerability, a live share
link, or its URL fragment.

Include the affected commit, reproduction steps, expected impact, and whether
the issue concerns the browser-to-browser path or `cdx` agent transfers. You
should receive an initial response within seven days.

## Security model

Full-link agent transfers (`cdx send --link`, or opening a share URL) are
live and end-to-end encrypted. The URL fragment contains
the transfer key and is not sent in HTTP requests. The relay sees a random
transfer identifier, timing, byte counts, and encrypted frames; it does not
store file contents or receive the master key. Anyone who obtains the complete
link while its sender is online can receive the file, so treat the link as a
secret and let it expire after use.

Short share codes (the default `cdx send` code, and the browser `/send` page)
are NOT end-to-end encrypted: the relay directory holds the transfer key so a
5-digit code resolves on any device. TLS protects code transfers in transit
and the relay forwards but never stores the bytes, but the relay could read
them, and anyone who guesses an active code within its 15-minute lifetime can
receive the file. Lookups consume durable IPv4 or IPv6 /64 and aggregate
shard budgets, including legacy probes. See [directory controls](docs/code-directory-security.md)
for the limits and availability tradeoff.
Use codes for everyday one-time shares between friends; use `--link` mode for
anything sensitive.

This model does not hide traffic metadata, protect a compromised endpoint, or
provide resumable/offline storage. See [the protocol](docs/agent-transfer-v1.md)
for exact limits and wire behavior.

Browser-to-browser transfers use WebRTC encryption and a
short-word rendezvous code (3-5 letters, e.g. river; legacy random codes are
still accepted). CD's Worker coordinates signaling but does not carry
file bytes. WebRTC may contact public STUN servers for NAT discovery; those
servers can observe endpoint IP addresses but not transfer contents. The `cdx`
path uses only `cd.yash0.in` and does not need STUN or PeerJS infrastructure.
