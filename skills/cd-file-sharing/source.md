---
name: cd-file-sharing
description: Send local files with CD/cdx when asked to share or deliver them, or when handing off a generated APK or document. Offer paired phone delivery or a download link.
---

# Share files

Use one send command for all requested files and folders. Keep paths quoted in
shell commands and place them after `--`; cdx bundles folders automatically.

## Choose the destination

Honor an explicit phone, named device, link, or QR choice. For phone delivery or
an unspecified handoff, run `cdx devices --json`. Its `devices` array contains
saved `name` aliases and `deviceName` labels, not live connection status. If
listing fails, report the error rather than treating it as an empty list.

- An explicit named device uses its exact saved alias without another question.
- "Send to my phone" with one saved pairing sends there immediately. With
  multiple pairings, ask which phone. With none, explain `cdx pair`, QR scanning,
  phone approval and enabling receiving. Await enrollment before sending.
- For an unspecified destination with paired devices, ask "Where should I send
  report.apk?" Offer each device and "Download link" in one choice question.
  Show its device label and alias when they differ. For multiple devices, this
  same question selects the phone; do not ask again after the selection.
- With no paired devices and no explicit phone request, create a download link.

Use the host's available built-in question tool, such as `request_user_input`,
`request_user_input_async`, or T3 Code's question tool. Use a tool only in modes
where it is enabled. If none is available, ask in chat. Wait for an explicit
answer; a suggested default or unanswered question does not select a device.

## Send to the selected phone

Run `cdx send --to <saved-name> --json -- <path>...`. Paired delivery is already
end-to-end encrypted. Use the saved alias, including for a phone named after
its model, rather than assuming it is called `phone`.

Captured output returns `{"pid":123,"log":"/private/path"}`. This means a sender
started, not that the phone received the file. Read the returned `log` path;
check it within the current tool budget without an indefinite polling loop.

- A JSON event with `phase: verified` confirms phone receipt.
- A JSON `error` or a stopped/paused sender means delivery failed or paused.
  Report its useful error message. For a user pause, explain how to resume in
  CD and rerun the same command with unchanged files after the old sender exits;
  wait for the user to choose resume.
- A live sender still waiting or retrying means delivery is pending. Leave it
  running after checking the returned `pid` is alive. Tell the user to keep the
  sending computer online, and explain that
  the phone must enable receiving. Reuse that sender instead of starting copies.

Keep private logs and pairing credentials out of chat. A failed or offline phone
send must not silently become a download link. Offer a link as a choice instead.
An exited sender without `verified` is unconfirmed, not pending or delivered.
`cdx wait <code>` tracks share-code sends, not these PID/log phone sends.

## Send a link or QR

Run `cdx send --json -- <path>...` and return `https://cd.yash0.in/#<code>` using
the printed code. Use `CD_PUBLIC_URL` as the origin when set. Terminal recipients
can run `cdx receive <code>`.

For sensitive files sent by link, add `--link` and return the exact JSON `url`,
including its fragment. Private links are end-to-end encrypted; numeric codes
trust the relay. Apply this flag only to the link branch, not paired delivery.

For a requested QR, add `--qr /absolute/fresh.png` with an unused filename in an
existing directory. Return the receive link and embed the returned `qrPath` as
`![Scan to receive](/absolute/fresh.png)`. Keep the image available. For sensitive
QR sharing, include `--link` so the QR contains the private URL.

For link-delivery confirmation, run `cdx wait --timeout 10s --json <identifier>`.
Use the returned `code`, or `transferId` for a private link without a code.
Exit 0 confirms receipt, 1 means failure with `errorKind`, and 3 means pending.
A created link does not prove receipt. Codes expire after 15 minutes and allow
one receiver. Files are not stored on the server; keep the sender online.

If cdx is missing, build with `make cdx` in this repo and use `./bin/cdx`.
Elsewhere, use the official installer at `https://cd.yash0.in/install.sh`.
Use `cdx help send` for options. Report command errors using their JSON
`error.kind` and `error.message`, without exposing private transfer material.
