// Direct path for relay transfers, browser side (see cmd/cdx/direct.go).
// The sender offers WebRTC SDP inside its encrypted file offer; this page
// answers with a signal record, trickles its ICE candidates, and the two
// exchange the same encrypted records over a pre-negotiated data channel
// once it opens. Records are split into 64 KiB messages and rebuilt from
// their plaintext header; both paths feed one merger that orders records by
// sequence number and drops the second copy of any record.

const HEADER_BYTES = 12;
const TAG_BYTES = 16;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
const MAX_PENDING_RECORDS = 256;
// The CLI can stripe a 24 MiB unacknowledged window across both paths.
const MAX_ORDERING_BYTES = 32 * 1024 * 1024;
export const DIRECT_PENDING_BYTES = 16 * 1024 * 1024;
export const DIRECT_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_CANDIDATES = 64;
export const DIRECT_CHANNEL_ID = 1;
export const DIRECT_PIECE_BYTES = 64 * 1024;
export const DIRECT_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' }
];

// parseDirectOffer returns the sender's offer SDP, or null if it offered none.
export function parseDirectOffer(offer) {
  const sdp = offer?.direct?.sdp;
  return typeof sdp === 'string' && sdp.length > 0 && sdp.length <= MAX_SDP_BYTES ? sdp : null;
}

export function splitRecord(record) {
  const pieces = [];
  for (let start = 0; start < record.byteLength; start += DIRECT_PIECE_BYTES) {
    pieces.push(record.subarray(start, Math.min(start + DIRECT_PIECE_BYTES, record.byteLength)));
  }
  return pieces;
}

export function createRecordAssembler() {
  const header = new Uint8Array(HEADER_BYTES);
  let buffer = header;
  let filled = 0;
  return {
    get bufferedBytes() { return filled; },
    push(piece) {
      const bytes = piece instanceof Uint8Array ? piece : new Uint8Array(piece);
      if (bytes.byteLength > DIRECT_PIECE_BYTES) throw new Error('The direct connection exceeded its assembly buffer.');
      const records = [];
      for (let at = 0; at < bytes.byteLength;) {
        const count = Math.min(buffer.byteLength - filled, bytes.byteLength - at);
        buffer.set(bytes.subarray(at, at + count), filled);
        filled += count;
        at += count;
        if (filled !== buffer.byteLength) continue;
        if (buffer === header) {
          if (header[0] !== 0x43 || header[1] !== 0x44 || header[2] !== 1) throw new Error('The direct connection sent an invalid record.');
          const length = HEADER_BYTES + new DataView(header.buffer).getUint32(8) + TAG_BYTES;
          if (length > MAX_RECORD_BYTES) throw new Error('The direct connection sent an oversized record.');
          buffer = new Uint8Array(length);
          buffer.set(header);
        } else {
          records.push(buffer);
          buffer = header;
          filled = 0;
        }
      }
      return records;
    }
  };
}

// createRecordMerger orders records from both paths by their header
// sequence number and drops second copies (the sender re-sends relay
// records on the direct path when it opens).
export function createRecordMerger() {
  let expected = 0;
  const pending = new Map();
  let pendingBytes = 0;
  return {
    get pendingBytes() { return pendingBytes; },
    get pendingRecords() { return pending.size; },
    push(record) {
      const bytes = record instanceof Uint8Array ? record : new Uint8Array(record);
      if (bytes.byteLength < HEADER_BYTES + TAG_BYTES || bytes.byteLength > MAX_RECORD_BYTES || bytes[0] !== 0x43 || bytes[1] !== 0x44 || bytes[2] !== 1 || bytes.byteLength !== HEADER_BYTES + new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0) + TAG_BYTES) throw new Error('The sender sent an invalid record.');
      const sequence = new DataView(bytes.buffer, bytes.byteOffset + 4, 4).getUint32(0);
      if (sequence < expected || pending.has(sequence)) return [];
      if (pending.size >= MAX_PENDING_RECORDS) throw new Error('The sender sent too many records out of order.');
      if (pendingBytes + bytes.byteLength > MAX_ORDERING_BYTES) throw new Error('The sender exceeded the safe ordering buffer.');
      pending.set(sequence, bytes);
      pendingBytes += bytes.byteLength;
      const ready = [];
      while (pending.has(expected)) {
        ready.push(pending.get(expected));
        pendingBytes -= pending.get(expected).byteLength;
        pending.delete(expected);
        expected += 1;
      }
      return ready;
    }
  };
}

// Both roles use channel ID 1 and the same ciphertext framing as the CLI.
// Native buffering is limited independently of the application ACK window.
function directPath({ onRecord, onOpen = () => {}, onLost = () => {}, RTCPeerConnectionImpl = globalThis.RTCPeerConnection }) {
  const connection = new RTCPeerConnectionImpl({ iceServers: DIRECT_ICE_SERVERS });
  const channel = connection.createDataChannel('cd-direct', { negotiated: true, id: DIRECT_CHANNEL_ID, ordered: true });
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = DIRECT_BUFFER_BYTES / 2;
  const assembler = createRecordAssembler();
  let lost = false;
  let sending = Promise.resolve();
  let queuedSendBytes = 0;
  let queuedSends = 0;
  const lose = (error) => {
    if (lost) return;
    lost = true;
    onLost(error);
  };
  channel.addEventListener('open', () => onOpen());
  channel.addEventListener('close', () => lose(new Error('The direct connection closed. Send again for a fresh transfer.')));
  channel.addEventListener('error', () => lose(new Error('The direct connection failed. Send again for a fresh transfer.')));
  channel.addEventListener('message', (event) => {
    try {
      if (typeof event.data === 'string') throw new Error('The direct connection sent text.');
      for (const record of assembler.push(event.data)) onRecord(record);
    } catch (error) { lose(error); connection.close(); }
  });
  connection.addEventListener('connectionstatechange', () => {
    if (connection.connectionState === 'failed' || connection.connectionState === 'closed') lose(new Error('The direct connection failed. Send again for a fresh transfer.'));
  });
  const path = {
    connection,
    get open() { return !lost && channel.readyState === 'open'; },
    get bufferedAmount() { return channel.bufferedAmount; },
    get queuedSendBytes() { return queuedSendBytes; },
    send(record) {
      if (record.byteLength > MAX_RECORD_BYTES) return Promise.reject(new Error('The direct record is too large.'));
      if (queuedSends >= MAX_PENDING_RECORDS || queuedSendBytes + record.byteLength > DIRECT_PENDING_BYTES) return Promise.reject(new Error('The direct send queue is full.'));
      queuedSends += 1; queuedSendBytes += record.byteLength;
      sending = sending.then(async () => {
        const started = performance.now();
        for (const piece of splitRecord(record)) {
          while (channel.bufferedAmount + piece.byteLength > DIRECT_BUFFER_BYTES) {
            if (!path.open) throw new Error('The direct connection closed while sending.');
            if (performance.now() - started > 90_000) throw new Error('The direct send buffer stalled. Send again for a fresh transfer.');
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!path.open) throw new Error('The direct connection closed while sending.');
          channel.send(piece);
        }
      }).finally(() => { queuedSends -= 1; queuedSendBytes -= record.byteLength; });
      return sending;
    },
    close() { lost = true; connection.close(); }
  };
  return path;
}

// Offers include bounded host-candidate gathering because sender frame kinds
// cannot carry trickled signaling. Creation starts while waiting for a receiver.
export async function offerDirect(options) {
  const path = directPath(options);
  try {
    await path.connection.setLocalDescription(await path.connection.createOffer());
    if (path.connection.iceGatheringState !== 'complete') {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timer); path.connection.removeEventListener('icegatheringstatechange', changed); resolve(); };
        const changed = () => { if (path.connection.iceGatheringState === 'complete') done(); };
        const timer = setTimeout(done, 250);
        path.connection.addEventListener('icegatheringstatechange', changed);
      });
    }
    const sdp = path.connection.localDescription.sdp;
    if (!sdp || sdp.length > MAX_SDP_BYTES) throw new Error('The direct offer is too large.');
    let answered = false;
    let candidates = 0;
    Object.defineProperty(path, 'sdp', {
      get() {
        // Gathering continues while the recipient enters the code.
        const current = path.connection.localDescription?.sdp;
        if (!current || current.length > MAX_SDP_BYTES) throw new Error('The direct offer is too large.');
        return current;
      }
    });
    return Object.assign(path, {
      async signal(value) {
        if (value?.sdp && !answered) {
          if (typeof value.sdp !== 'string' || value.sdp.length > MAX_SDP_BYTES) throw new Error('Invalid direct answer.');
          await path.connection.setRemoteDescription({ type: 'answer', sdp: value.sdp });
          answered = true;
        } else if (value?.candidate && answered) {
          if (++candidates > MAX_CANDIDATES || JSON.stringify(value.candidate).length > 4096) throw new Error('Too many direct candidates.');
          await path.connection.addIceCandidate(value.candidate);
        }
      }
    });
  } catch (error) { path.close(); throw error; }
}

export async function answerDirect({ offerSdp, onSignal, ...options }) {
  if (typeof offerSdp !== 'string' || offerSdp.length === 0 || offerSdp.length > MAX_SDP_BYTES) throw new Error('Invalid direct offer.');
  const path = directPath(options);
  let answered = false;
  const early = [];
  let candidates = 0;
  const signal = (value) => { Promise.resolve(onSignal(value)).catch((error) => { path.close(); options.onLost?.(error); }); };
  path.connection.addEventListener('icecandidate', (event) => {
    if (!event.candidate || ++candidates > MAX_CANDIDATES) return;
    const value = { candidate: event.candidate.toJSON() };
    if (JSON.stringify(value).length > 4096) return;
    if (answered) signal(value); else early.push(value);
  });
  try {
    await path.connection.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    await path.connection.setLocalDescription(await path.connection.createAnswer());
    signal({ sdp: path.connection.localDescription.sdp });
    answered = true;
    for (const value of early.splice(0)) signal(value);
    return path;
  } catch (error) { path.close(); throw error; }
}
