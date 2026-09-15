import {
  KIND_ACCEPT,
  KIND_ACK,
  KIND_CHUNK,
  KIND_COMPLETE,
  KIND_END,
  KIND_OFFER,
  MAX_RECORD_BYTES,
  RECEIVER_DIRECTION,
  SENDER_DIRECTION,
  createOpener,
  createSealer,
  encodeBase64Url,
  parseInvitation,
  receiverAdmission
} from './agent-protocol.js';
import { createSink as createDownloadSink } from './sink.js';
import './style.css';

const ACK_INTERVAL = 256n * 1024n;
const MAX_PENDING_BYTES = 2 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
let failureShown = false;

document.body.innerHTML = `
  <main class="shell share-transfer-page">
    <header class="brand-rail">
      <div class="brand-lockup"><h1>cd</h1><p class="tagline">/di·rect/ — no cloud detour</p></div>
    </header>
    <section class="workbench">
      <div class="share-panel">
        <span class="panel-kicker">incoming transfer</span>
        <p id="status" class="status" role="status">Connecting securely...</p>
        <div id="offer" class="agent-offer" hidden>
          <strong id="file-name"></strong>
          <span id="file-size"></span>
          <button id="accept" class="primary-btn" type="button">Accept &amp; download</button>
        </div>
        <div id="receive-progress" class="agent-progress" hidden>
          <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="progress-fill"></div>
            <span class="progress-dino" aria-hidden="true">🦕</span>
          </div>
          <span id="progress-copy">0%</span>
        </div>
        <a id="download" class="primary-btn share-download" hidden>Download file</a>
        <ul class="trust-strip" aria-label="privacy guarantees">
          <li>key stays in link</li>
          <li>never stored</li>
          <li>nothing moves until you accept</li>
        </ul>
      </div>
    </section>
    <p class="watermark">encrypted in your browser · <a href="/">cd.yash0.in</a></p>
  </main>`;

const elements = {
  status: document.getElementById('status'),
  offer: document.getElementById('offer'),
  fileName: document.getElementById('file-name'),
  fileSize: document.getElementById('file-size'),
  accept: document.getElementById('accept'),
  progress: document.getElementById('receive-progress'),
  progressBar: document.querySelector('#receive-progress .progress-bar'),
  progressFill: document.querySelector('#receive-progress .progress-fill'),
  progressCopy: document.getElementById('progress-copy'),
  download: document.getElementById('download')
};

function formatSize(bytes) {
  const value = Number(bytes);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function parseOffer(plaintext) {
  let value;
  try { value = JSON.parse(decoder.decode(plaintext)); } catch { throw new Error('The sender offered invalid file details.'); }
  if (!value || typeof value !== 'object') throw new Error('The sender offered invalid file details.');
  const { name, mediaType, size, chunkSize } = value;
  if (typeof name !== 'string' || new TextEncoder().encode(name).byteLength > 255 || name.length === 0 || name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw new Error('The sender offered an unsafe filename.');
  }
  if (typeof mediaType !== 'string' || mediaType.length > 127 || !/^[\x20-\x7e]+$/.test(mediaType)) throw new Error('The sender offered an invalid file type.');
  if (typeof size !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(size)) throw new Error('The sender offered an invalid file size.');
  const byteSize = BigInt(size);
  if (byteSize > 0xffffffffffffffffn || chunkSize !== 64 * 1024) throw new Error('The sender uses unsupported transfer limits.');
  return { name, mediaType, size: byteSize };
}

function encodeCounts(chunks, bytes) {
  const value = new Uint8Array(12);
  const view = new DataView(value.buffer);
  view.setUint32(0, chunks);
  view.setBigUint64(4, bytes);
  return value;
}

function decodeCounts(value) {
  if (value.byteLength !== 12) throw new Error('The sender sent invalid completion details.');
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return { chunks: view.getUint32(0), bytes: view.getBigUint64(4) };
}

async function createSink(offer) {
  return createDownloadSink({ name: offer.name, size: offer.size, mediaType: offer.mediaType });
}

function waitForAcceptance(offer) {
  elements.fileName.textContent = offer.name;
  elements.fileSize.textContent = formatSize(offer.size);
  elements.offer.hidden = false;
  elements.status.textContent = 'Ready when you are. The file stays with the sender until you accept.';
  return new Promise((resolve, reject) => {
    elements.accept.addEventListener('click', async () => {
      elements.accept.disabled = true;
      try { resolve(await createSink(offer)); }
      catch (error) {
        elements.accept.disabled = false;
        if (error?.name === 'AbortError') return;
        reject(error);
      }
    });
  });
}

function renderProgress(received, total) {
  const percent = total === 0n ? 100 : Math.min(Number(received * 1000n / total) / 10, 100);
  elements.progress.hidden = false;
  elements.progressFill.style.transform = `scaleX(${percent / 100})`;
  elements.progressBar.style.setProperty('--progress', `${percent}%`);
  elements.progressBar.setAttribute('aria-valuenow', percent.toFixed(1));
  elements.progressCopy.textContent = `${percent.toFixed(1)}% · ${formatSize(received)} / ${formatSize(total)}`;
}

function fail(error, socket, sink) {
  if (failureShown) return;
  failureShown = true;
  if (sink) void sink.abort().catch(() => {});
  if (socket?.readyState === WebSocket.OPEN) socket.close(4400, 'receiver failed');
  elements.offer.hidden = true;
  elements.progress.hidden = true;
  elements.status.textContent = error instanceof Error ? error.message : 'The transfer failed.';
}

function closeReasonMessage(event) {
  switch (event?.code) {
    case 4401:
      return 'This CD link key does not match. Ask the sender for a fresh link.';
    case 4404:
      return 'The sender is no longer available.';
    case 4408:
      return 'This CD link has expired. Ask the sender for a fresh link.';
    case 4409:
      return 'This CD link is already claimed or expired. Ask the sender for a fresh link.';
    default:
      return 'The sender is no longer available.';
  }
}

async function receive() {
  const invitation = parseInvitation(new URL(window.location.href));
  history.replaceState(null, '', window.location.pathname);
  const [{ token }, opener, sealer] = await Promise.all([
    receiverAdmission(invitation),
    createOpener(invitation, SENDER_DIRECTION),
    createSealer(invitation, RECEIVER_DIRECTION)
  ]);
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${scheme}://${location.host}/ws/v1/${encodeBase64Url(invitation.id)}`);
  socket.binaryType = 'arraybuffer';
  let state = 'connecting';
  let offer;
  let sink;
  let received = 0n;
  let acknowledged = 0n;
  let chunks = 0;
  let pendingBytes = 0;
  let queue = Promise.resolve();

  async function send(kind, payload = new Uint8Array()) {
    socket.send(await sealer.seal(kind, payload));
  }

  async function processMessage(data) {
    if (typeof data === 'string') {
      const value = JSON.parse(data);
      if (value.protocol !== 'cd-transfer-v1') throw new Error('The sender uses an incompatible CD version.');
      if (value.type === 'peer-left') throw new Error('The sender is no longer available.');
      if (value.type === 'accepted') elements.status.textContent = 'Connected. Waiting for file details...';
      return;
    }
    const { kind, plaintext } = await opener.open(data);
    if (state === 'connecting' && kind === KIND_OFFER) {
      offer = parseOffer(plaintext);
      state = 'offered';
      sink = await waitForAcceptance(offer);
      if (failureShown) {
        await sink.abort();
        return;
      }
      elements.offer.hidden = true;
      elements.status.textContent = `Receiving ${offer.name}...`;
      state = 'receiving';
      renderProgress(0n, offer.size);
      await send(KIND_ACCEPT);
      return;
    }
    if (state === 'receiving' && kind === KIND_CHUNK) {
      if (received + BigInt(plaintext.byteLength) > offer.size) throw new Error('The sender sent more data than promised.');
      await sink.write(plaintext);
      received += BigInt(plaintext.byteLength);
      chunks += 1;
      renderProgress(received, offer.size);
      if (received - acknowledged >= ACK_INTERVAL || received === offer.size) {
        await send(KIND_ACK, encodeCounts(chunks, received));
        acknowledged = received;
      }
      return;
    }
    if (state === 'receiving' && kind === KIND_END) {
      const ended = decodeCounts(plaintext);
      if (ended.bytes !== offer.size || ended.bytes !== received || ended.chunks !== chunks) throw new Error('The transfer ended before the complete file arrived.');
      const result = await sink.close();
      state = 'complete';
      renderProgress(received, offer.size);
      await send(KIND_COMPLETE, encodeCounts(chunks, received));
      if (sink.kind === 'download') {
        elements.download.href = result.url;
        elements.download.download = offer.name;
        elements.download.textContent = `Download ${offer.name}`;
        elements.download.hidden = false;
        elements.status.textContent = 'File verified and ready to download.';
        let revoked = false;
        const revoke = () => {
          if (revoked) return;
          revoked = true;
          result.revoke();
        };
        elements.download.addEventListener('click', () => setTimeout(revoke, 60_000), { once: true });
        window.addEventListener('pagehide', revoke, { once: true });
      } else elements.status.textContent = 'File verified and saved.';
      socket.close(1000, 'complete');
      return;
    }
    throw new Error('The sender sent a message out of order.');
  }

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: encodeBase64Url(token)
    }));
  });
  socket.addEventListener('message', (event) => {
    const size = typeof event.data === 'string' ? event.data.length : event.data.byteLength;
    pendingBytes += size;
    if (pendingBytes > MAX_PENDING_BYTES + MAX_RECORD_BYTES) {
      fail(new Error('The sender exceeded the safe receive buffer.'), socket, sink);
      return;
    }
    queue = queue.then(() => processMessage(event.data)).finally(() => { pendingBytes -= size; });
    queue.catch((error) => fail(error, socket, sink));
  });
  socket.addEventListener('error', () => fail(new Error('This CD transfer is unavailable or has expired.'), socket, sink));
  const connectTimeout = setTimeout(() => {
    if (state === 'connecting') fail(new Error('Could not reach the CD relay. Check your connection and reload the link.'), socket, sink);
  }, 15_000);
  socket.addEventListener('close', (event) => {
    clearTimeout(connectTimeout);
    if (state !== 'complete') fail(new Error(closeReasonMessage(event)), null, sink);
  });
}

receive().catch((error) => fail(error));
