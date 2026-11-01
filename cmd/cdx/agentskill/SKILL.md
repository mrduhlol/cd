---
name: cd-file-sharing
description: Send local files to a phone or share them with CD/cdx.
---

# Share files

Pass all files to one send command; cdx preserves folders without manual zipping.

- Phone: run `cdx send --to phone --json <path>...` without confirmation.
  Read the returned private log; `phase: verified` confirms receipt. If offline,
  leave the background sender running and report pending delivery. If unconfigured,
  report that account receiving or pairing is needed; if ambiguous, ask which device.
  Use a download link only if requested.
- Otherwise: run `cdx send <path>...` and reply with
  `https://cd.yash0.in/#<code>` using the printed code. Use `CD_PUBLIC_URL` as
  the origin when set. Terminal recipients can run `cdx receive <code>`.
- Sensitive files: add `--link --json` and return the exact `url`, including
  its fragment. Private links are end-to-end encrypted; codes trust the relay.
- QR requested: add `--json --qr /absolute/fresh.png` using an existing directory
  and unused filename. Return the `url` and embed the returned `qrPath` as
  `![Scan to receive](/absolute/fresh.png)`. Keep the PNG available; if images
  cannot render, return the link and code.

Captured sends run in the background. Keep the sender online; files are not
stored on the server. Codes expire after 15 minutes and allow one receiver.

For requested delivery confirmation, run `cdx wait --timeout 10m --json <code>`.
Exit 0 confirms receipt; 1 means failure, see `errorKind`; 3 means still pending.
A code alone does not prove delivery. On command failure, report JSON
`error.kind` and `error.message`.

If cdx is missing, run `make cdx` in this repository and use `./bin/cdx`, or
install elsewhere with `curl -fsSL https://cd.yash0.in/install.sh | sh`.
Use `cdx help send` for additional options.
