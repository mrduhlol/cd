---
name: cd-file-sharing
description: Hand off generated APKs, documents, and other local files with CD/cdx. Offer paired phone delivery or a download link.
---

# Share files

Pass all files to one send command; cdx preserves folders without manual zipping.

Before handing off a generated APK, document, or other requested file, run
`cdx devices --json`. The `devices` entries contain `name` and `deviceName`;
these are saved pairings, not proof that a device is online.

- If the user already chose a phone or link, use that choice directly.
- Otherwise, when devices are paired, use the host's built-in choice tool
  (`request_user_input`, `request_user_input_async`, or T3 Code's available
  question tool). Offer each paired device and "Download link". With multiple
  devices, ask which device before sending. Use a plain chat question when no
  choice tool is available. Wait for the answer before starting the transfer.
- Send to the selected device with `cdx send --to <name> --json -- <path>...`,
  using its exact saved `name`. For an explicit "my phone" request with one
  pairing, send there immediately. With multiple pairings, ask which device.
- Read the returned private log; `phase: verified` confirms receipt. If offline,
  leave the background sender running and report pending delivery. If unconfigured,
  explain `cdx pair` and phone approval. Use a download link when selected;
  a failed device send must not silently create a link.
- When a link is selected, or no devices are paired for an unspecified handoff,
  run `cdx send --json -- <path>...` and reply with
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
