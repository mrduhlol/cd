import {
  KIND_ACCEPT,
  KIND_ACK,
  KIND_COMPLETE,
  KIND_CHUNK,
  KIND_END,
  KIND_OFFER,
  KIND_SIGNAL,
  RECEIVER_DIRECTION,
  SENDER_DIRECTION,
  createOpener,
  createSealer,
  encodeBase64Url,
  receiverAdmission
} from './agent-protocol.js';
import { isShortCode } from './agent-code.js';
import { fileSource, rechunk } from './zip-bundle.js';
import { createRecordMerger, offerDirect, DIRECT_BUFFER_BYTES } from './direct-link.js';
import { createSendWindow } from './send-window.js';
import { CHUNK_SIZE, LARGE_CHUNK_SIZE, acceptedSendChunkSize } from './transfer-limits.js';

// Browser relay sender: mints a numeric share code plus a share link and
// streams one byte source with the same encrypted records `cdx send` uses,
// so `cdx receive <code>` or any browser Receive box can take it.
// startRelaySend is the engine (used by the main page); mountRelaySender
// wires it to the standalone `/send` page.

const MAX_INCOMING_BYTES = 4 * 1024 * 1024;
const MAX_INCOMING_RECORDS = 256;
const MAX_RETAINED_BYTES = 16 * 1024 * 1024;
const MAX_RETAINED_RECORDS = 128;
const ADMISSION_WAIT_MS = 10_000;
const PEER_WAIT_MS = 15 * 60_000;
const CONSENT_WAIT_MS = 10 * 60_000;
const TRANSFER_IDLE_MS = 90_000;

const encoder = new TextEncoder();

// Short codes come from the relay directory: typable in any browser Receive
// box or `cdx receive`. The directory holds the transfer key, so code mode
// relies on TLS + the live relay rather than end-to-end encryption.
async function claimShareCode(transferId, key) {
  let response;
  try {
    response = await fetch('/api/codes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transferId, key })
    });
  } catch {
    throw new Error('Could not reserve a share code. Check your connection and try again.');
  }
  if (!response.ok) throw new Error('Share codes are busy right now. Wait a moment and try again.');
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Could not reserve a share code. Check your connection and try again.');
  }
  if (!body || !isShortCode(body.code)) {
    throw new Error('Could not reserve a share code. Check your connection and try again.');
  }
  return body.code;
}

function formatSize(bytes) {
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export class RelaySendError extends Error {}

// startRelaySend sends source ({ name, type, size, stream() }) and reports
// through hooks: onShare({ code, url }), onState(state), onStatus(text),
// onProgress(done, total). It resolves when the receiver verified every
// byte and rejects with the reason otherwise. cancel() stops it.
export function startRelaySend(source, hooks = {}) {
  const onShare = hooks.onShare || (() => {});
  const onState = hooks.onState || (() => {});
  const onStatus = hooks.onStatus || (() => {});
  const onProgress = hooks.onProgress || (() => {});
  let socket = null;
  let cancelled = false;
  let direct = null;
  let directUsed = false;
  let switched = false;
  let complete = false;
  let retainedBytes = 0;
  let incomingBytes = 0;
  const retained = [];
  const merger = createRecordMerger();
  let sendChain = Promise.resolve();
  let windowController = null;
  const stats = { relayBytes: 0, directBytes: 0, maxRetainedBytes: 0, maxIncomingBytes: 0, maxIncomingCount: 0 };
  function reportTransport() {
    const snapshot = { ...stats, transport: directUsed ? 'direct' : 'relay', retainedBytes, incomingBytes, incomingCount: incoming.length, mergerBytes: merger.pendingBytes, window: windowController?.snapshot() };
    hooks.onTransport?.(snapshot);
    if (typeof globalThis.__CD_TRANSFER_TEST_OBSERVER__ === 'function') globalThis.__CD_TRANSFER_TEST_OBSERVER__(snapshot);
  }
  function failPump(error) {
    closedError = error;
    for (const waiter of waiters.splice(0)) waiter(null);
  }
  function deliver(event) {
    if (closedError || cancelled) return;
    const size = typeof event.data === 'string' ? encoder.encode(event.data).byteLength : event.data.byteLength;
    const waiter = waiters.shift();
    if (waiter) waiter(event);
    else {
      if (incoming.length >= MAX_INCOMING_RECORDS || incomingBytes + size > MAX_INCOMING_BYTES) {
        failPump(new RelaySendError('The receiver exceeded the safe response buffer. Send again for a fresh transfer.'));
        return;
      }
      incoming.push({ event, size }); incomingBytes += size;
      stats.maxIncomingBytes = Math.max(stats.maxIncomingBytes, incomingBytes);
      stats.maxIncomingCount = Math.max(stats.maxIncomingCount, incoming.length);
    }
    reportTransport();
  }
  function receiveRecord(record) {
    try { for (const ordered of merger.push(record)) deliver({ data: ordered }); reportTransport(); }
    catch (error) { failPump(new RelaySendError(error.message)); }
  }

  // Single persistent pump: every socket message is buffered exactly once and
  // handed to waiters in arrival order. Attaching a fresh message listener per
  // wait (instead of this pump) drops records that arrive while a chunk is
  // being sealed or sent, which stalls multi-megabyte transfers.
  const incoming = [];
  const waiters = [];
  let closedError = null;

  function releaseRetained(acknowledged) {
    while (retained.length && retained[0].endingBytes <= acknowledged) retainedBytes -= retained.shift().record.byteLength;
  }
  async function switchDirect() {
    if (switched || !direct?.open) return;
    switched = true;
    const replay = retained.splice(0);
    for (const item of replay) {
      await direct.send(item.record); directUsed = true; stats.directBytes += item.record.byteLength;
      retainedBytes -= item.record.byteLength;
    }
    reportTransport();
  }
  async function waitForSocketDrain(size) {
    const started = performance.now();
    while (socket.bufferedAmount + size > DIRECT_BUFFER_BYTES) {
      if (cancelled || closedError) throw closedError || new RelaySendError('Transfer canceled.');
      if (direct?.open) return;
      if (socket.readyState !== 1 || performance.now() - started > TRANSFER_IDLE_MS) throw new RelaySendError('The relay send buffer stalled. Check your connection and send again.');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!direct?.open && socket.readyState !== 1) throw new RelaySendError('Lost the connection to CD. Send again for a fresh transfer.');
  }


  function attachPump() {
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') deliver(event);
      else receiveRecord(event.data);
    });
    socket.addEventListener('close', (event) => {
      if (directUsed || complete) return;
      closedError = new RelaySendError(event.code === 4408
        ? 'The code expired before anyone used it. Send again for a fresh code.'
        : 'Lost the connection to CD. Check your network and try again.');
      for (const waiter of waiters.splice(0)) waiter(null);
    });
  }

  function pump(timeoutMs, handle, timeoutMessage) {
    return new Promise((resolve, reject) => {
      if (cancelled) {
        reject(new RelaySendError('Transfer canceled.'));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = waiters.indexOf(entry);
        if (index !== -1) waiters.splice(index, 1);
        reject(new RelaySendError(timeoutMessage));
      }, timeoutMs);
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const entry = (event) => {
        if (event === null) {
          finish(cancelled ? new RelaySendError('Transfer canceled.') : closedError);
          return;
        }
        void Promise.resolve()
          .then(() => handle(event))
          .then((result) => {
            if (result === null || result === undefined) {
              // Not what this wait wanted; keep waiting for the next message.
              if (!settled) next();
              return;
            }
            finish(null, result);
          })
          .catch((error) => finish(error));
      };
      const next = () => {
        if (closedError) { entry(null); return; }
        if (incoming.length > 0) {
          const item = incoming.shift(); incomingBytes -= item.size; entry(item.event);
        } else waiters.push(entry);
      };
      next();
    });
  }

  function waitForText(type, timeoutMs, timeoutMessage) {
    return pump(timeoutMs, (event) => {
      if (typeof event.data !== 'string') return null;
      let value;
      try { value = JSON.parse(event.data); } catch { return null; }
      if (value?.protocol !== 'cd-transfer-v1') return null;
      if (value.type === 'peer-left') throw new RelaySendError('The receiver left.');
      return value.type === type ? value : null;
    }, timeoutMessage);
  }

  function waitForRecord(opener, kinds, timeoutMs, timeoutMessage) {
    return pump(timeoutMs, async (event) => {
      if (typeof event.data === 'string') {
        let value;
        try { value = JSON.parse(event.data); } catch { return null; }
        if (value?.type === 'peer-left' && !directUsed) throw new RelaySendError('The receiver left.');
        return null;
      }
      const { kind, plaintext } = await opener.open(event.data);
      if (kind === KIND_SIGNAL) {
        if (plaintext.byteLength > 64 * 1024) throw new RelaySendError('The receiver sent oversized direct signaling.');
        if (direct && !switched) {
          try { await direct.signal(JSON.parse(new TextDecoder().decode(plaintext))); }
          catch (error) {
            if (directUsed) throw new RelaySendError('The direct connection failed. Send again for a fresh transfer.');
            direct.close(); direct = null; retained.length = 0; retainedBytes = 0;
          }
        }
        return null;
      }
      if (!kinds.includes(kind)) throw new RelaySendError('The receiver sent a message out of order.');
      return { kind, plaintext };
    }, timeoutMessage);
  }

  function decodeCounts(value) {
    if (value.byteLength !== 12) throw new RelaySendError('The receiver sent invalid progress.');
    const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
    return { chunks: view.getUint32(0), bytes: BigInt(view.getBigUint64(4)) };
  }

  function encodeCounts(chunks, bytes) {
    const value = new Uint8Array(12);
    const view = new DataView(value.buffer);
    view.setUint32(0, chunks);
    view.setBigUint64(4, bytes);
    return value;
  }

  const onPageHide = () => {
    direct?.close();
    try { socket?.close(1000, 'sender left'); } catch { /* Best effort. */ }
  };

  async function run() {
    onState('connecting');
    onStatus('Getting a code...');
    const id = crypto.getRandomValues(new Uint8Array(16));
    const key = crypto.getRandomValues(new Uint8Array(32));
    const invitation = { id, key };
    const { digest } = await receiverAdmission(invitation);
    const encodedId = encodeBase64Url(id);
    const encodedKey = encodeBase64Url(key);
    const shareUrl = `${window.location.origin}/s/${encodedId}#v1.${encodedKey}`;

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${scheme}://${window.location.host}/ws/v1/${encodedId}`);
    socket.binaryType = 'arraybuffer';
    await new Promise((resolve, reject) => {
      const unreachable = () => reject(new RelaySendError('Could not reach CD. Check your connection and try again.'));
      const timer = setTimeout(unreachable, ADMISSION_WAIT_MS);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); unreachable(); }, { once: true });
    });
    attachPump();
    window.addEventListener('pagehide', onPageHide, { once: true });
    if (cancelled) throw new RelaySendError('Transfer canceled.');

    // shareKey asks the relay to claim the share code during the join.
    socket.send(JSON.stringify({
      type: 'join', protocol: 'cd-transfer-v1', role: 'sender',
      receiverTokenHash: encodeBase64Url(digest), shareKey: encodedKey
    }));
    const accepted = await waitForText('accepted', ADMISSION_WAIT_MS, 'CD did not answer. Check your connection and try again.');
    // Relays that predate join-time codes: claim one separately.
    const code = isShortCode(accepted.code) ? accepted.code : await claimShareCode(encodedId, encodedKey);
    if (cancelled) throw new RelaySendError('Transfer canceled.');
    onShare({ code, url: shareUrl });
    onState('waiting');
    onStatus('Waiting for the receiver. The code works for 15 minutes.');
    const offerPromise = typeof RTCPeerConnection === 'function' ? offerDirect({
      onRecord: (record) => { directUsed = true; receiveRecord(record); },
      onOpen: () => {
        sendChain = sendChain.then(() => switchDirect()).catch((error) => failPump(new RelaySendError(error.message)));
      },
      onLost: (error) => {
        if (directUsed && !complete) failPump(new RelaySendError(error.message));
        else if (!complete) { direct?.close(); direct = null; retained.length = 0; retainedBytes = 0; }
      }
    }).then((path) => {
      if (cancelled || closedError || complete) { path.close(); return null; }
      direct = path;
      return path;
    }).catch(() => null) : Promise.resolve(null);
    await waitForText('peer-joined', PEER_WAIT_MS, 'Nobody used the code within 15 minutes. Send again for a fresh code.');

    direct = await offerPromise;
    if (cancelled) { direct?.close(); throw new RelaySendError('Transfer canceled.'); }
    const [sealer, opener] = await Promise.all([
      createSealer(invitation, SENDER_DIRECTION),
      createOpener(invitation, RECEIVER_DIRECTION)
    ]);
    const send = (kind, payload = new Uint8Array(), endingBytes = 0n) => {
      sendChain = sendChain.then(async () => {
        if (cancelled || closedError) throw closedError || new RelaySendError('Transfer canceled.');
        const record = await sealer.seal(kind, payload);
        if (direct?.open) {
          await switchDirect();
          await direct.send(record); directUsed = true; stats.directBytes += record.byteLength;
        } else {
          if (direct && !switched) {
            if (retained.length >= MAX_RETAINED_RECORDS || retainedBytes + record.byteLength > MAX_RETAINED_BYTES) throw new RelaySendError('The direct replay buffer is full. Send again for a fresh transfer.');
            retained.push({ record, endingBytes }); retainedBytes += record.byteLength;
            stats.maxRetainedBytes = Math.max(stats.maxRetainedBytes, retainedBytes);
          }
          await waitForSocketDrain(record.byteLength);
          if (direct?.open) { await switchDirect(); }
          else { socket.send(record); stats.relayBytes += record.byteLength; }
        }
        reportTransport();
      });
      return sendChain;
    };

    onState('connecting');
    onStatus('Receiver connected. Waiting for them to accept...');
    await send(KIND_OFFER, encoder.encode(JSON.stringify({
      name: source.name,
      mediaType: source.type || 'application/octet-stream',
      size: String(source.size),
      chunkSize: CHUNK_SIZE,
      maxChunkSize: LARGE_CHUNK_SIZE,
      ...(source.bundle ? { bundle: true, files: source.files } : {}),
      ...(direct ? { direct: { sdp: direct.sdp } } : {})
    })));
    const acceptance = await waitForRecord(opener, [KIND_ACCEPT], CONSENT_WAIT_MS, 'The receiver did not accept within 10 minutes.');
    const chunkSize = acceptedSendChunkSize(acceptance.plaintext);
    releaseRetained(0n);

    onState('transferring');
    onStatus('Sending...');
    const total = BigInt(source.size);
    let sent = 0n;
    let acknowledged = 0n;
    let chunks = 0;
    // Two negotiated chunks must fit before the receiver's 1 MiB ACK.
    windowController = createSendWindow({ minBytes: Math.max(1024 * 1024, 2 * chunkSize) });
    onProgress(0, source.size);
    const awaitAck = async () => {
      const { plaintext } = await waitForRecord(opener, [KIND_ACK], TRANSFER_IDLE_MS, 'The transfer stalled: no progress for 90 seconds.');
      const ack = decodeCounts(plaintext);
      if (ack.chunks > chunks || ack.bytes < acknowledged || ack.bytes > sent) {
        throw new RelaySendError('The receiver sent invalid progress.');
      }
      acknowledged = ack.bytes;
      try { windowController.acked(acknowledged); } catch { throw new RelaySendError('The receiver sent invalid progress.'); }
      releaseRetained(acknowledged);
      onProgress(Number(acknowledged), source.size);
    };
    let wakeSender;
    let progressChanged = new Promise(resolve => { wakeSender = resolve; });
    const readAcknowledgements = async () => {
      try {
        while (acknowledged < total) {
          await awaitAck();
          const wake = wakeSender;
          progressChanged = new Promise(resolve => { wakeSender = resolve; });
          wake();
        }
      } catch (error) {
        failPump(error);
        wakeSender();
        throw error;
      }
    };
    const wireChunks = async function* () {
      for await (const chunk of source.bundle ? rechunk(source.stream(), chunkSize) : source.stream()) {
        // Browser WebSockets perform better with the original frame size.
        // The negotiated value is an upper bound, including after an upgrade.
        const size = direct?.open ? chunkSize : Math.min(CHUNK_SIZE, chunkSize);
        for (let offset = 0; offset < chunk.byteLength; offset += size) yield chunk.subarray(offset, offset + size);
      }
    };
    const sendSource = async () => {
      try {
        for await (const chunk of wireChunks()) {
          if (sent + BigInt(chunk.byteLength) > total) throw new RelaySendError('A file changed while it was being sent.');
          while (!windowController.canSend(chunk.byteLength)) {
            if (cancelled || closedError) throw closedError || new RelaySendError('Transfer canceled.');
            await progressChanged;
          }
          // Account before yielding to the transport: an ACK can arrive during send.
          sent += BigInt(chunk.byteLength);
          chunks += 1;
          windowController.sent(sent);
          await send(KIND_CHUNK, chunk, sent);
        }
        if (sent !== total) throw new RelaySendError('A file changed while it was being sent.');
      } catch (error) {
        failPump(error);
        throw error;
      }
    };
    await Promise.all([sendSource(), readAcknowledgements()]);

    await send(KIND_END, encodeCounts(chunks, sent));
    const { plaintext } = await waitForRecord(opener, [KIND_COMPLETE], TRANSFER_IDLE_MS, 'The receiver did not confirm the file.');
    const done = decodeCounts(plaintext);
    if (done.bytes !== sent || done.chunks !== chunks) throw new RelaySendError('The receiver did not verify the transfer.');
    onProgress(source.size, source.size);
    complete = true;
    onState('complete');
    onStatus('The receiver has every byte.');
    window.removeEventListener('pagehide', onPageHide);
    direct?.close();
    socket.close(1000, 'complete');
  }

  const done = run().catch((error) => {
    window.removeEventListener('pagehide', onPageHide);
    direct?.close();
    try { socket?.close(cancelled ? 1000 : 4400, cancelled ? 'sender canceled' : 'sender failed'); } catch { /* Best effort. */ }
    if (cancelled) throw new RelaySendError('Transfer canceled.');
    throw error instanceof RelaySendError ? error : new RelaySendError('The transfer failed. Try again.');
  });

  return {
    done,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      direct?.close();
      try { socket?.close(1000, 'sender canceled'); } catch { /* Best effort. */ }
      for (const waiter of waiters.splice(0)) waiter(null);
    }
  };
}

// mountRelaySender wires startRelaySend to the standalone `/send` page.
// `els` provides: fileInput, pickBtn, fileLine, shareBox, shareCode,
// shareLink, receiveCommand, copyCodeBtn, copyLinkBtn, copyCmdBtn, progress,
// progressBar, progressFill, progressCopy, status, cancelBtn, againBtn.
export function mountRelaySender(els) {
  let active = null;
  let shareUrl = '';
  let shareCode = '';

  function paintProgress(sent, total) {
    const percent = total === 0 ? 100 : Math.min((sent / total) * 100, 100);
    els.progress.hidden = false;
    els.progressFill.style.transform = `scaleX(${percent / 100})`;
    els.progressBar.setAttribute('aria-valuenow', percent.toFixed(1));
    els.progressCopy.textContent = `${percent.toFixed(1)}% · ${formatSize(sent)} / ${formatSize(total)}`;
  }

  function sendFile(file) {
    els.pickBtn.disabled = true;
    els.cancelBtn.hidden = false;
    els.againBtn.hidden = true;
    els.fileLine.textContent = `${file.name} · ${formatSize(file.size)}`;
    active = startRelaySend(fileSource(file), {
      onShare({ code, url }) {
        shareCode = code;
        shareUrl = url;
        els.shareBox.hidden = false;
        els.shareCode.textContent = code;
        els.shareLink.textContent = url;
        els.receiveCommand.textContent = `cdx receive ${code}`;
      },
      onStatus(text) { els.status.textContent = text; },
      onProgress: paintProgress
    });
    active.done.then(() => {
      els.cancelBtn.hidden = true;
      els.againBtn.hidden = false;
    }, (error) => {
      els.status.textContent = error.message;
      els.cancelBtn.hidden = true;
      els.againBtn.hidden = false;
    });
  }

  async function copyText(text, button) {
    const original = button.textContent;
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = original; }, 1400);
  }

  els.pickBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) sendFile(file);
  });
  els.cancelBtn.addEventListener('click', () => {
    active?.cancel();
    els.shareBox.hidden = true;
    els.progress.hidden = true;
    els.pickBtn.disabled = false;
  });
  els.againBtn.addEventListener('click', () => {
    els.shareBox.hidden = true;
    els.progress.hidden = true;
    els.fileInput.value = '';
    els.fileLine.textContent = 'No file chosen yet.';
    els.pickBtn.disabled = false;
    els.againBtn.hidden = true;
    els.status.textContent = '';
  });
  els.copyLinkBtn.addEventListener('click', () => void copyText(shareUrl, els.copyLinkBtn));
  els.copyCodeBtn.addEventListener('click', () => void copyText(shareCode, els.copyCodeBtn));
  els.copyCmdBtn.addEventListener('click', () => void copyText(`cdx receive ${shareCode}`, els.copyCmdBtn));

  return { sendFile };
}
