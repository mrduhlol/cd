import {
  createResumeOpener, createResumeSealer, resumeNonceProof, resumeReceiverAdmission,
  signResumeCheckpoint, verifyResumeCheckpoint
} from './resume-protocol.js';
import { KIND_ACCEPT, KIND_ACK, KIND_CHUNK, KIND_COMPLETE, KIND_END, KIND_OFFER, RECEIVER_DIRECTION, SENDER_DIRECTION, encodeBase64Url } from './agent-protocol.js';
import { IncrementalSHA256 } from './incremental-sha256.js';
import { downloadUrlFor } from './sink.js';
import { createResumeWriter } from './resume-opfs.js';

export const RESUME_CHUNK_SIZE = 256 * 1024;
export const RESUME_LIMIT_MS = 24 * 60 * 60 * 1000;
export const RESUME_DB_NAME = 'cd-resume-v2';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function reportResumeProgress(hooks, role, done, total, metrics) {
  hooks.onProgress?.(done, total, metrics);
  try { globalThis.__CD_RESUME_TEST_OBSERVER__?.({ role, done, total, ...metrics }); } catch { /* Test instrumentation is optional. */ }
}

export function parseResumeLink(value, base = globalThis.location?.href) {
  const url = new URL(value, base);
  const path = /^\/s\/([A-Za-z0-9_-]{22})\/?$/.exec(url.pathname);
  const hash = /^#v2\.([A-Za-z0-9_-]{43})$/.exec(url.hash);
  if (!path || !hash) throw new Error('This resumable CD link is invalid.');
  const id = decodeBase64Url(path[1]);
  const key = decodeBase64Url(hash[1]);
  if (id.byteLength !== 16 || key.byteLength !== 32 || encodeBase64Url(id) !== path[1] || encodeBase64Url(key) !== hash[1]) throw new Error('This resumable CD link is invalid.');
  return { id, key, rootId: path[1], url };
}

export function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url value.');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashFile(file, { length = file.size, chunkSize = RESUME_CHUNK_SIZE, onBytes = () => {} } = {}) {
  if (!Number.isSafeInteger(file.size) || !Number.isSafeInteger(length) || length < 0 || length > file.size) {
    throw new Error('The selected file size is invalid.');
  }
  const hash = new IncrementalSHA256();
  for (let offset = 0; offset < length; offset += chunkSize) {
    const bytes = new Uint8Array(await file.slice(offset, Math.min(length, offset + chunkSize)).arrayBuffer());
    hash.update(bytes);
    onBytes(offset + bytes.byteLength);
  }
  return hash;
}

export function openResumeDatabase(indexedDB = globalThis.indexedDB) {
  if (!indexedDB) return Promise.reject(new Error('This browser cannot keep resumable transfer data locally.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RESUME_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('checkpoints')) db.createObjectStore('checkpoints');
      if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local resume storage.'));
  });
}

export function createResumeKV(db, storeName) {
  return {
    get(key) { return idbRequest(db, storeName, 'readonly', (store) => store.get(key)); },
    put(key, value) { return idbRequest(db, storeName, 'readwrite', (store) => store.put(value, key)); },
    delete(key) { return idbRequest(db, storeName, 'readwrite', (store) => store.delete(key)); },
    keys() { return idbRequest(db, storeName, 'readonly', (store) => store.getAllKeys()); }
  };
}

function idbRequest(db, name, mode, invoke) {
  return new Promise((resolve, reject) => {
    let transaction;
    try { transaction = db.transaction(name, mode, { durability: 'strict' }); }
    catch { transaction = db.transaction(name, mode); }
    const request = invoke(transaction.objectStore(name));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error('Local resume storage failed.'));
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error('Local resume storage failed.'));
  });
}

export { cleanExpiredResumeRecords } from './resume-retention.js';

export function newStagingId() { return `cd-rx-${crypto.randomUUID()}`; }
export function isOpaqueStagingId(value) { return typeof value === 'string' && /^cd-rx-[0-9a-f-]{36}$/.test(value); }

function checkpointFor({ role, rootId, offer, offset, prefixSha256, stagingId, destination, expiresAt, priorSessionNonce }) {
  return {
    version: 2, role, rootId, filename: offer.name, size: Number(offer.size), chunkSize: RESUME_CHUNK_SIZE,
    wholeSha256: offer.wholeSha256, offset: Number(offset), prefixSha256, stagingId,
    destination, expiresAt, priorSessionNonce
  };
}

export async function createReceiverStage({ invitation, rootId, offer, storage = globalThis.navigator?.storage, checkpoints, secrets, now = Date.now() }) {
  if (!storage?.getDirectory) throw new Error('Resume needs browser durable storage (OPFS). Open this link in a supported browser with site storage enabled.');
  if (!Number.isSafeInteger(Number(offer.size)) || Number(offer.size) < 0 || String(Number(offer.size)) !== String(offer.size)) throw new Error('The sender offered an invalid file size.');
  if (offer.chunkSize !== RESUME_CHUNK_SIZE || !/^[0-9a-f]{64}$/.test(offer.wholeSha256)) throw new Error('The sender offered invalid resumable file details.');
  const directory = await storage.getDirectory();
  const checkpointKey = `receiver:${rootId}`;
  let checkpoint = await checkpoints.get(checkpointKey);
  let handle;
  let offset = 0;
  let stagingId;
  let hash = new IncrementalSHA256();
  const destination = 'browser-download';
  const secret = invitation.key;
  if (checkpoint) {
    if (!(await verifyResumeCheckpoint(checkpoint, secret, now)) || checkpoint.role !== 'receiver' || checkpoint.rootId !== rootId || checkpoint.filename !== offer.name || checkpoint.size !== Number(offer.size) || checkpoint.wholeSha256 !== offer.wholeSha256 || checkpoint.destination !== destination || checkpoint.expiresAt <= now || !isOpaqueStagingId(checkpoint.stagingId)) {
      throw new Error('Saved receive progress failed its integrity or file identity check. Cancel it and ask the sender to start a new resumable transfer.');
    }
    offset = checkpoint.offset;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > Number(offer.size) || (offset % RESUME_CHUNK_SIZE !== 0 && offset !== Number(offer.size))) {
      throw new Error('Saved receive progress has an invalid offset. Cancel it and start a new transfer.');
    }
    stagingId = checkpoint.stagingId;
    handle = await directory.getFileHandle(stagingId);
    const file = await handle.getFile();
    if (file.size < offset) throw new Error('Saved receive data is truncated. Cancel it and start a new transfer.');
    hash = await hashFile(file, { length: offset });
    if (hash.digestHex() !== checkpoint.prefixSha256) throw new Error('Saved receive data failed its integrity check. Cancel it and start a new transfer.');
    if (file.size !== offset) {
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.truncate(offset);
      await writable.close();
    }
  } else {
    stagingId = newStagingId();
    handle = await directory.getFileHandle(stagingId, { create: true });
  }

  const writer = await createResumeWriter(handle);
  const expiresAt = checkpoint?.expiresAt ?? Math.min(now + RESUME_LIMIT_MS, Number(offer.expiresAt) || now + RESUME_LIMIT_MS);
  let currentOffset = offset;
  let closed = false;
  async function persist(nextOffset, nextHash, priorSessionNonce) {
    const unsigned = checkpointFor({ role: 'receiver', rootId, offer, offset: nextOffset, prefixSha256: nextHash.digestHex(), stagingId, destination, expiresAt, priorSessionNonce });
    checkpoint = await signResumeCheckpoint(unsigned, secret);
    await checkpoints.put(checkpointKey, checkpoint);
  }
  let operation = Promise.resolve();
  async function appendInner(bytes, priorSessionNonce) {
    if (closed) throw new Error('The saved receive stage is closed.');
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const nextOffset = currentOffset + value.byteLength;
    if (!value.byteLength || value.byteLength > RESUME_CHUNK_SIZE || nextOffset > Number(offer.size) || (nextOffset < Number(offer.size) && value.byteLength !== RESUME_CHUNK_SIZE)) throw new Error('The sender sent an invalid chunk boundary.');
    const nextHash = hash.clone().update(value);
    await writer.write(value, currentOffset);
    await persist(nextOffset, nextHash, priorSessionNonce);
    currentOffset = nextOffset;
    hash = nextHash;
  }
  function append(bytes, priorSessionNonce) {
    const current = operation.then(() => appendInner(bytes, priorSessionNonce));
    operation = current.catch(() => {});
    return current;
  }
  async function finishInner() {
    if (closed) throw new Error('The saved receive stage is closed.');
    if (currentOffset !== Number(offer.size) || hash.digestHex() !== offer.wholeSha256) throw new Error('The received file did not match the sender’s whole-file digest.');
    closed = true;
    await writer.close();
    return handle.getFile();
  }
  function finish() {
    const current = operation.then(finishInner);
    operation = current.catch(() => {});
    return current;
  }
  async function release() {
    closed = true;
    await operation.catch(() => {});
    await writer.close();
  }
  async function cancel() {
    try { await release(); }
    finally {
      try { await directory.removeEntry(stagingId); } catch { /* Best effort. */ }
      await checkpoints.delete(checkpointKey);
    }
  }
  function bindSession(priorSessionNonce) {
    const current = operation.then(() => {
      if (closed) throw new Error('The saved receive stage is closed.');
      return persist(currentOffset, hash, priorSessionNonce);
    });
    operation = current.catch(() => {});
    return current;
  }
  return { offset, prefixSha256: hash.digestHex(), expiresAt, stagingId, bindSession, append, finish, cancel, release, get currentOffset() { return currentOffset; }, get wholeHash() { return hash.digestHex(); } };
}

export async function hashFilePrefix(file, offset) {
  return (await hashFile(file, { length: offset })).digestHex();
}

export function assertResumeSourceIdentity(checkpoint, file, wholeSha256) {
  if (!checkpoint || checkpoint.role !== 'sender' || checkpoint.filename !== file.name || checkpoint.size !== file.size || checkpoint.wholeSha256 !== wholeSha256) {
    throw new Error('The selected file does not match the saved source. Choose the original file and try again.');
  }
  return true;
}

export async function createPrivateSenderCapability({ origin = globalThis.location?.origin, secrets }) {
  const id = crypto.getRandomValues(new Uint8Array(16));
  const key = crypto.getRandomValues(new Uint8Array(32));
  const senderToken = crypto.getRandomValues(new Uint8Array(32));
  const rootId = encodeBase64Url(id);
  const invitation = { id, key };
  const receiver = await resumeReceiverAdmission(invitation);
  const expiresAt = Date.now() + RESUME_LIMIT_MS;
  await secrets.put(`sender:${rootId}`, { senderToken: encodeBase64Url(senderToken), expiresAt });
  return { invitation, rootId, senderToken, receiverToken: receiver.token, receiverTokenHash: receiver.digest, expiresAt, url: `${origin}/s/${rootId}#v2.${encodeBase64Url(key)}` };
}

export async function createV2Socket(invitation, role, token, { senderTokenHash, receiverTokenHash, sessionNonce, onSocket, WebSocketCtor = globalThis.WebSocket, location = globalThis.location } = {}) {
  const { token: receiverToken } = await resumeReceiverAdmission(invitation);
  const nonce = sessionNonce || crypto.getRandomValues(new Uint8Array(32));
  const proofRole = role === 'sender' ? 'sender' : 'receiver';
  const proof = await resumeNonceProof(invitation, proofRole, nonce);
  const encodedId = encodeBase64Url(invitation.id);
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocketCtor(`${scheme}://${location.host}/ws/v2/${encodedId}`);
  onSocket?.(socket);
  socket.binaryType = 'arraybuffer';
  const inbox = createSocketInbox(socket);
  await waitSocketOpen(socket);
  if (socket.readyState !== 1) throw new Error('The transfer connection was closed before joining.');
  const join = role === 'sender'
    ? { type: 'join', protocol: 'cd-transfer-v2', role, senderToken: encodeBase64Url(token), senderTokenHash, receiverTokenHash, sessionNonce: encodeBase64Url(nonce), nonceProof: encodeBase64Url(proof) }
    : { type: 'join', protocol: 'cd-transfer-v2', role, receiverToken: encodeBase64Url(receiverToken), receiverNonce: encodeBase64Url(nonce), nonceProof: encodeBase64Url(proof) };
  socket.send(JSON.stringify(join));
  return { socket, nonce, receiverToken, inbox };
}

function createSocketInbox(socket) {
  const pending = [];
  const waiters = [];
  let failure = null;
  let queuedBytes = 0;
  socket.addEventListener('message', (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(event);
    else {
      const size = typeof event.data === 'string' ? textEncoder.encode(event.data).byteLength : event.data?.byteLength ?? 0;
      // CLI senders allow 4 MiB outstanding, plus encrypted headers and control records.
      if (pending.length >= 32 || queuedBytes + size > 4 * 1024 * 1024 + 64 * 1024) {
        failure = new Error('The peer exceeded the bounded resume receive queue.');
        try { socket.close(4429, 'receive queue full'); } catch { /* Best effort. */ }
        while (waiters.length) waiters.shift().reject(failure);
        return;
      }
      pending.push({ event, size });
      queuedBytes += size;
    }
  });
  socket.addEventListener('close', (event) => {
    failure = new Error(event.code === 4408 ? 'This resumable CD transfer has expired.' : 'The transfer connection was interrupted. Your saved progress can be resumed from the same private link.');
    while (waiters.length) waiters.shift().reject(failure);
  });
  socket.addEventListener('error', () => {
    failure ||= new Error('The transfer connection failed. Your saved progress can be resumed from the same private link.');
  });
  return { next(timeout = 90_000) {
    if (pending.length) {
      const item = pending.shift();
      queuedBytes -= item.size;
      return Promise.resolve(item.event);
    }
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const waiter = { resolve: (event) => { clearTimeout(timer); resolve(event); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error('The transfer timed out waiting for the other device.'));
      }, timeout);
      waiters.push(waiter);
    });
  } };
}

async function waitForRelayEvent(inbox, types, timeout) {
  while (true) {
    const event = await inbox.next(timeout);
    if (typeof event.data !== 'string') return event;
    let value;
    try { value = JSON.parse(event.data); } catch { throw new Error('CD sent an invalid resume response.'); }
    if (value.protocol !== 'cd-transfer-v2') throw new Error('The relay uses an incompatible resume protocol.');
    if (value.type === 'peer-left') throw new Error('The other device disconnected. Your saved progress can be resumed from the same private link.');
    if (types.includes(value.type)) return value;
    if (value.type === 'completed') return value;
  }
}

async function authenticateV2Peer(invitation, role, ownNonce, inbox, onAccepted) {
  let relayEvent = await waitForRelayEvent(inbox, ['accepted', 'peer-joined'], 15 * 60_000);
  if (relayEvent.type === 'accepted') await onAccepted?.(Number(relayEvent.expiresAt) || 0);
  while (!relayEvent.sessionNonce || !relayEvent.receiverNonce) {
    relayEvent = await waitForRelayEvent(inbox, ['accepted', 'peer-joined'], 15 * 60_000);
  }
  if (relayEvent.type === 'peer-joined') await onAccepted?.(Number(relayEvent.expiresAt) || 0);
  const sessionNonceText = relayEvent.sessionNonce;
  const receiverNonceText = relayEvent.receiverNonce;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionNonceText || '') || !/^[A-Za-z0-9_-]{43}$/.test(receiverNonceText || '')) throw new Error('The relay did not bind this transfer to a fresh session.');
  const sessionNonce = decodeBase64Url(sessionNonceText);
  const receiverNonce = decodeBase64Url(receiverNonceText);
  if (role === 'sender' && !constantTimeEqual(sessionNonce, ownNonce)) throw new Error('The relay returned a stale sender session.');
  if (role === 'receiver' && !constantTimeEqual(receiverNonce, ownNonce)) throw new Error('The relay returned a stale receiver session.');
  const peerRole = role === 'sender' ? 'receiver' : 'sender';
  const proofText = role === 'sender' ? relayEvent.receiverNonceProof : relayEvent.senderNonceProof;
  if (typeof proofText !== 'string' || !(await verifyPeerNonce(invitation, peerRole, role === 'sender' ? receiverNonce : sessionNonce, decodeBase64Url(proofText)))) {
    throw new Error('The other device could not prove its private transfer capability.');
  }
  return { sessionNonce, receiverNonce, sessionNonceText, receiverNonceText, expiresAt: Number(relayEvent.expiresAt) || 0 };
}

function sendRecord(socket, record) {
  if (socket.readyState !== 1) throw new Error('The transfer connection was interrupted.');
  socket.send(record);
}

async function nextRecord(inbox, opener, expectedKind) {
  while (true) {
    const event = await inbox.next();
    if (typeof event.data === 'string') {
      let value;
      try { value = JSON.parse(event.data); } catch { continue; }
      if (value.type === 'peer-left') throw new Error('The other device disconnected. Your saved progress can be resumed from the same private link.');
      continue;
    }
    const opened = await opener.open(event.data);
    if (opened.kind !== expectedKind) throw new Error('The other device sent messages out of order.');
    return opened.plaintext;
  }
}

function sessionParams(session) { return { sessionNonce: session.sessionNonce, receiverNonce: session.receiverNonce }; }

function hashBytes(value) {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('The peer sent an invalid file digest.');
  return Uint8Array.from(value.match(/../g), (pair) => Number.parseInt(pair, 16));
}

export function startResumableSend(file, { link = '', secrets, checkpoints, hooks = {}, origin = globalThis.location?.origin } = {}) {
  let socket;
  let cancelled = false;
  let privateRootId = '';
  const done = (async () => {
    if (!file || typeof file.slice !== 'function' || !Number.isSafeInteger(file.size)) throw new Error('Choose one file to send with resume enabled.');
    const capability = link
      ? await loadSenderCapability(link, { secrets, checkpoints, origin })
      : await createPrivateSenderCapability({ origin, secrets });
    const { invitation, rootId, senderToken, receiverToken, receiverTokenHash, expiresAt, url, reconnect, saved } = capability;
    privateRootId = rootId;
    if (cancelled) {
      await checkpoints.delete(`sender:${rootId}`);
      await secrets.delete(`sender:${rootId}`);
      throw new Error('Transfer canceled.');
    }
    hooks.onStatus?.('Checking the file before sharing…');
    const fullHash = await hashFile(file);
    const wholeSha256 = fullHash.digestHex();
    if (cancelled) throw new Error('Transfer canceled.');
    if (reconnect) assertResumeSourceIdentity(saved, file, wholeSha256);
    const chunkCount = Math.ceil(file.size / RESUME_CHUNK_SIZE);
    let sourceBytesRead = file.size;
    let maxWorkingBytes = RESUME_CHUNK_SIZE * 2 + 64;
    let sessionNonce = crypto.getRandomValues(new Uint8Array(32));
    if (!reconnect) {
      const emptyPrefix = new IncrementalSHA256().digestHex();
      await checkpoints.put(`sender:${rootId}`, await signResumeCheckpoint({
        version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: RESUME_CHUNK_SIZE,
        wholeSha256, offset: 0, prefixSha256: emptyPrefix, stagingId: 'sender-source', destination: 'source-reselect',
        expiresAt, priorSessionNonce: encodeBase64Url(sessionNonce)
      }, senderToken));
    }
    if (cancelled) throw new Error('Transfer canceled.');
    const tokenHashBytes = await crypto.subtle.digest('SHA-256', senderToken);
    if (cancelled) throw new Error('Transfer canceled.');
    const connection = await createV2Socket(invitation, 'sender', senderToken, {
      senderTokenHash: encodeBase64Url(new Uint8Array(tokenHashBytes)),
      receiverTokenHash: encodeBase64Url(receiverTokenHash), sessionNonce,
      onSocket(value) { socket = value; if (cancelled) { try { value.close(1000, 'sender canceled'); } catch { /* Best effort. */ } } }, location: globalThis.location
    });
    socket = connection.socket;
    let sharePublished = false;
    const publishShare = async (relayExpiry) => {
      if (cancelled) throw new Error('Transfer canceled.');
      const authoritativeExpiry = relayExpiry || expiresAt;
      if (!Number.isSafeInteger(authoritativeExpiry) || authoritativeExpiry <= Date.now() || authoritativeExpiry > Date.now() + RESUME_LIMIT_MS + 60_000) {
        throw new Error('The relay returned an invalid resume expiry.');
      }
      if (reconnect && authoritativeExpiry !== saved.expiresAt) {
        throw new Error('The relay expiry does not match this saved transfer.');
      }
      if (!reconnect && authoritativeExpiry !== expiresAt) {
        await secrets.put(`sender:${rootId}`, { senderToken: encodeBase64Url(senderToken), expiresAt: authoritativeExpiry });
        const checkpoint = await checkpoints.get(`sender:${rootId}`);
        if (checkpoint) await checkpoints.put(`sender:${rootId}`, await signResumeCheckpoint({ ...checkpoint, expiresAt: authoritativeExpiry }, senderToken));
      }
      if (cancelled) throw new Error('Transfer canceled.');
      if (!sharePublished) {
        hooks.onShare?.({ url, rootId, resumed: Boolean(reconnect) });
        sharePublished = true;
      }
    };
    const session = await authenticateV2Peer(invitation, 'sender', sessionNonce, connection.inbox, publishShare);
    if (cancelled) throw new Error('Transfer canceled.');
    const activeExpiry = session.expiresAt || expiresAt;
    if (!reconnect && session.expiresAt) {
      await secrets.put(`sender:${rootId}`, { senderToken: encodeBase64Url(senderToken), expiresAt: activeExpiry });
      await checkpoints.put(`sender:${rootId}`, await signResumeCheckpoint({
        version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: RESUME_CHUNK_SIZE,
        wholeSha256, offset: 0, prefixSha256: new IncrementalSHA256().digestHex(), stagingId: 'sender-source', destination: 'source-reselect',
        expiresAt: activeExpiry, priorSessionNonce: encodeBase64Url(session.sessionNonce)
      }, senderToken));
    }
    const [sealer, opener] = await Promise.all([
      createResumeSealer(invitation, SENDER_DIRECTION, sessionParams(session)),
      createResumeOpener(invitation, RECEIVER_DIRECTION, sessionParams(session))
    ]);
    const offer = { name: file.name, size: String(file.size), chunkSize: RESUME_CHUNK_SIZE, wholeSha256, expiresAt: activeExpiry };
    sendRecord(socket, await sealer.seal(KIND_OFFER, textEncoder.encode(JSON.stringify(offer))));
    const acceptanceBytes = await nextRecord(connection.inbox, opener, KIND_ACCEPT);
    if (acceptanceBytes.byteLength > 2048) throw new Error('The receiver sent oversized saved progress.');
    let acceptance;
    try { acceptance = JSON.parse(textDecoder.decode(acceptanceBytes)); } catch { throw new Error('The receiver sent invalid saved progress.'); }
    const offset = Number(acceptance.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size || (offset % RESUME_CHUNK_SIZE !== 0 && offset !== file.size)) throw new Error('The receiver sent an invalid resume offset.');
    if (!/^[0-9a-f]{64}$/.test(acceptance.prefixSha256 || '')) throw new Error('The receiver sent an invalid saved digest.');
    const prefixState = await hashFile(file, { length: offset });
    sourceBytesRead += offset;
    const prefixSha256 = prefixState.digestHex();
    if (prefixSha256 !== acceptance.prefixSha256) throw new Error('The selected file does not match the saved source. Choose the original file and try again.');
    if (hashBytes(wholeSha256).length !== 32 || fullHash.digestHex() !== wholeSha256) throw new Error('The selected file changed while it was being checked.');
    const checkpoint = await signResumeCheckpoint({
      version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: RESUME_CHUNK_SIZE,
      wholeSha256, offset, prefixSha256, stagingId: 'sender-source', destination: 'source-reselect',
      expiresAt: activeExpiry, priorSessionNonce: encodeBase64Url(session.sessionNonce)
    }, senderToken);
    await checkpoints.put(`sender:${rootId}`, checkpoint);
    let bytesSent = offset;
    let chunksSent = Math.ceil(offset / RESUME_CHUNK_SIZE);
    let ackedBytes = offset;
    reportResumeProgress(hooks, 'sender', offset, file.size, { bytesRead: sourceBytesRead, resumedBytes: offset, maxWorkingBytes });
    const outstanding = [];
    let position = offset;
    while (position < file.size || outstanding.length) {
      if (cancelled) throw new Error('Transfer canceled.');
      // Four records fit the receiver's bounded inbox while durable ACKs are in flight.
      if (position < file.size && outstanding.length < 4) {
        const block = new Uint8Array(await file.slice(position, Math.min(file.size, position + RESUME_CHUNK_SIZE)).arrayBuffer());
        if (cancelled) throw new Error('Transfer canceled.');
        if (block.byteLength !== Math.min(RESUME_CHUNK_SIZE, file.size - position)) throw new Error('The selected file changed while sending.');
        sourceBytesRead += block.byteLength;
        const sealed = await sealer.seal(KIND_CHUNK, block);
        if (cancelled) throw new Error('Transfer canceled.');
        maxWorkingBytes = Math.max(maxWorkingBytes, block.byteLength + sealed.byteLength + outstanding.length * (RESUME_CHUNK_SIZE + 28));
        sendRecord(socket, sealed);
        bytesSent += block.byteLength;
        chunksSent++;
        position += block.byteLength;
        prefixState.update(block);
        outstanding.push({ bytes: bytesSent, chunks: chunksSent, prefixSha256: prefixState.digestHex() });
        continue;
      }
      const ack = decodeResumeAck(await nextRecord(connection.inbox, opener, KIND_ACK));
      const expected = outstanding.shift();
      if (ack.bytes !== BigInt(expected.bytes) || ack.chunks !== expected.chunks) throw new Error('The receiver acknowledged invalid saved progress.');
      ackedBytes = expected.bytes;
      const savedCheckpoint = await signResumeCheckpoint({
        version: 2, role: 'sender', rootId, filename: file.name, size: file.size, chunkSize: RESUME_CHUNK_SIZE,
        wholeSha256, offset: ackedBytes, prefixSha256: expected.prefixSha256, stagingId: 'sender-source', destination: 'source-reselect',
        expiresAt: activeExpiry, priorSessionNonce: encodeBase64Url(session.sessionNonce)
      }, senderToken);
      await checkpoints.put(`sender:${rootId}`, savedCheckpoint);
      reportResumeProgress(hooks, 'sender', ackedBytes, file.size, { bytesRead: sourceBytesRead, resumedBytes: offset, maxWorkingBytes });
    }
    if (cancelled) throw new Error('Transfer canceled.');
    sendRecord(socket, await sealer.seal(KIND_END, encodeResumeCounts(chunksSent, bytesSent, wholeSha256)));
    const result = decodeResumeCounts(await nextRecord(connection.inbox, opener, KIND_COMPLETE));
    if (result.bytes !== BigInt(file.size) || result.chunks !== chunkCount || result.wholeSha256 !== wholeSha256) throw new Error('The receiver did not verify the complete file.');
    await waitForRelayEvent(connection.inbox, ['completed'], 15000);
    await checkpoints.delete(`sender:${rootId}`);
    await secrets.delete(`sender:${rootId}`);
    reportResumeProgress(hooks, 'sender', file.size, file.size, { bytesRead: sourceBytesRead, resumedBytes: offset, maxWorkingBytes });
    hooks.onComplete?.();
    return { rootId, url, bytesRead: sourceBytesRead, bytesSent: file.size - offset, resumedBytes: offset, retainedBytes: 0, maxWorkingBytes };
  })();
  done.catch((error) => { if (!cancelled) hooks.onError?.(error); }).finally(() => {
    if (cancelled && privateRootId) {
      void checkpoints.delete(`sender:${privateRootId}`).catch(() => {});
      void secrets.delete(`sender:${privateRootId}`).catch(() => {});
    }
  });
  return { done, cancel() {
    cancelled = true;
    try { socket?.close(1000, 'sender canceled'); } catch { /* Best effort. */ }
    // Cleanup waits until active hashing and checkpoint writes have settled.
    // A socket loss or page close never calls this method.
  } };
}

async function loadSenderCapability(link, { secrets, checkpoints, origin }) {
  const parsed = parseResumeLink(link, `${origin}/`);
  const secret = await secrets.get(`sender:${parsed.rootId}`);
  const checkpoint = await checkpoints.get(`sender:${parsed.rootId}`);
  if (!secret || !checkpoint || secret.expiresAt <= Date.now() || !(await verifyResumeCheckpoint(checkpoint, decodeBase64Url(secret.senderToken))) || checkpoint.role !== 'sender') {
    throw new Error('This device has no active sender resume record for that private link. Resume on the device that started the send.');
  }
  return {
    invitation: { id: parsed.id, key: parsed.key }, rootId: parsed.rootId,
    senderToken: decodeBase64Url(secret.senderToken), receiverTokenHash: (await resumeReceiverAdmission({ id: parsed.id, key: parsed.key })).digest,
    expiresAt: checkpoint.expiresAt, url: parsed.url.href, reconnect: true, saved: checkpoint
  };
}

export function mountResumableReceiver(container, link, { storage = globalThis.navigator?.storage, checkpoints, secrets, download = true, hooks = {} } = {}) {
  let stopped = false;
  let discard = false;
  let socket;
  container.classList.add('share-panel');
  container.innerHTML = '<span class="panel-kicker">resumable transfer</span><p role="status" data-resume-status>Connecting securely…</p><strong data-resume-name></strong><div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="progress-fill"></div></div><span data-resume-progress></span><button type="button" class="secondary-btn" data-resume-cancel>Cancel saved progress</button>';
  const status = container.querySelector('[data-resume-status]');
  const filename = container.querySelector('[data-resume-name]');
  const progress = container.querySelector('[data-resume-progress]');
  const fill = container.querySelector('.progress-fill');
  const cancel = container.querySelector('[data-resume-cancel]');
  let stage;
  const cancelClick = () => {
    stopped = true;
    discard = true;
    void stage?.cancel().catch(error => {
      status.textContent = error.message || 'Could not remove saved progress.';
      hooks.onError?.(error);
    });
    try { socket?.close(1000, 'receiver canceled'); } catch { /* Best effort. */ }
    status.textContent = 'Saved progress removed.';
  };
  cancel.addEventListener('click', cancelClick);
  const done = (async () => {
    if (!storage?.getDirectory) throw new Error('Resume needs browser durable storage (OPFS). Open this link in a supported browser with site storage enabled.');
    const parsed = parseResumeLink(link);
    const invitation = { id: parsed.id, key: parsed.key };
    const { socket: activeSocket, nonce, inbox } = await createV2Socket(invitation, 'receiver', null, { onSocket(value) { socket = value; } });
    socket = activeSocket;
    const session = await authenticateV2Peer(invitation, 'receiver', nonce, inbox);
    if (stopped) return;
    const [opener, sealer] = await Promise.all([
      createResumeOpener(invitation, SENDER_DIRECTION, sessionParams(session)),
      createResumeSealer(invitation, RECEIVER_DIRECTION, sessionParams(session))
    ]);
    const rawOffer = await nextRecord(inbox, opener, KIND_OFFER);
    if (stopped) return;
    if (rawOffer.byteLength > 16 * 1024) throw new Error('The sender offered oversized file metadata.');
    let offer;
    try { offer = JSON.parse(textDecoder.decode(rawOffer)); } catch { throw new Error('The sender offered invalid file details.'); }
    if (!resumeSafeFilename(offer.name) || !Number.isSafeInteger(offer.expiresAt) || offer.expiresAt <= Date.now() || (session.expiresAt && offer.expiresAt !== session.expiresAt)) throw new Error('The sender offered an invalid or expired file.');
    filename.textContent = offer.name;
    stage = await createReceiverStage({ invitation, rootId: parsed.rootId, offer, storage, checkpoints, secrets, now: Date.now() });
    if (stopped) {
      if (discard) await stage.cancel();
      else { await stage.bindSession(encodeBase64Url(session.sessionNonce)); await stage.release(); }
      return;
    }
    await stage.bindSession(encodeBase64Url(session.sessionNonce));
    if (stopped) { if (discard) await stage.cancel(); else await stage.release(); return; }
    const resumeControl = { offset: String(stage.offset), prefixSha256: stage.prefixSha256 };
    sendRecord(socket, await sealer.seal(KIND_ACCEPT, textEncoder.encode(JSON.stringify(resumeControl))));
    let chunks = Math.ceil(stage.offset / RESUME_CHUNK_SIZE);
    let maxWorkingBytes = 0;
    while (true) {
      const event = await inbox.next();
      if (typeof event.data === 'string') continue;
      const opened = await opener.open(event.data);
      if (opened.kind === KIND_CHUNK) {
        maxWorkingBytes = Math.max(maxWorkingBytes, event.data.byteLength + opened.plaintext.byteLength * 2);
        await stage.append(opened.plaintext, encodeBase64Url(session.sessionNonce));
        chunks++;
        const ack = encodeResumeAck(chunks, stage.currentOffset);
        sendRecord(socket, await sealer.seal(KIND_ACK, ack));
        const percent = offer.size === '0' ? 100 : Math.min(stage.currentOffset * 100 / Number(offer.size), 100);
        fill.style.transform = `scaleX(${percent / 100})`;
        progress.textContent = `${percent.toFixed(1)}% · ${stage.currentOffset} / ${offer.size} bytes`;
        reportResumeProgress(hooks, 'receiver', stage.currentOffset, Number(offer.size), { writtenBytes: stage.currentOffset, resumedBytes: stage.offset, retainedBytes: stage.currentOffset, maxWorkingBytes });
        continue;
      }
      if (opened.kind !== KIND_END) throw new Error('The sender ended the transfer out of order.');
      const end = decodeResumeCounts(opened.plaintext);
      if (end.chunks !== chunks || end.bytes !== BigInt(offer.size) || end.wholeSha256 !== offer.wholeSha256 || stage.currentOffset !== Number(offer.size)) throw new Error('The sender’s final counts did not match the staged file.');
      const stagedFile = await stage.finish();
      if (stopped) { if (discard) await stage.cancel(); else await stage.release(); return; }
      const endHash = await hashFile(stagedFile);
      if (stopped) { if (discard) await stage.cancel(); else await stage.release(); return; }
      if (endHash.digestHex() !== offer.wholeSha256) throw new Error('The received file failed its whole-file digest check.');
      let publishedDownload;
      if (download) {
        publishedDownload = downloadUrlFor(stagedFile, offer.name, () => stage.cancel());
        const anchor = document.createElement('a');
        anchor.href = publishedDownload.url;
        anchor.download = publishedDownload.name;
        anchor.click();
        setTimeout(publishedDownload.revoke, 60_000);
        globalThis.addEventListener?.('pagehide', publishedDownload.revoke, { once: true });
      }
      sendRecord(socket, await sealer.seal(KIND_COMPLETE, encodeResumeCounts(chunks, stage.currentOffset, offer.wholeSha256)));
      socket.send(JSON.stringify({ type: 'complete', protocol: 'cd-transfer-v2', sessionNonce: encodeBase64Url(session.sessionNonce), receiverNonce: encodeBase64Url(session.receiverNonce) }));
      await waitForRelayEvent(inbox, ['completed'], 15000);
      // OPFS-backed download URLs read lazily; revoke owns their staging cleanup.
      if (!publishedDownload) await stage.cancel();
      status.textContent = 'File received and verified.';
      hooks.onComplete?.();
      return { bytesWritten: Number(offer.size), resumedBytes: stage.offset, retainedBytes: publishedDownload ? stage.currentOffset : 0, maxWorkingBytes };
    }
  })().catch(async (error) => {
    await stage?.release().catch(() => {});
    try { socket?.close(1011, 'receiver failed'); } catch { /* Best effort. */ }
    if (stopped) { if (discard) status.textContent = 'Saved progress removed.'; return; }
    status.textContent = error.message || 'The resumable transfer failed.';
    hooks.onError?.(error);
    throw error;
  });
  return { done, stop() { stopped = true; void stage?.release().catch(() => {}); try { socket?.close(1000, 'receiver left'); } catch { /* Best effort. */ } }, cancel: cancelClick };
}

function waitSocketOpen(socket, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Could not reach CD. Check your connection and try again.')), timeout);
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener('error', () => finish(new Error('Could not reach CD. Check your connection and try again.')), { once: true });
    socket.addEventListener('close', () => finish(new Error('Transfer canceled before the connection opened.')), { once: true });
  });
}

export function verifyPeerNonce(invitation, role, nonce, proof) {
  return resumeNonceProof(invitation, role, nonce).then((expected) => constantTimeEqual(expected, proof));
}

function constantTimeEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function encodeResumeCounts(chunks, bytes, wholeSha256) {
  const result = new Uint8Array(44);
  const view = new DataView(result.buffer);
  view.setUint32(0, chunks);
  view.setBigUint64(4, BigInt(bytes));
  result.set(typeof wholeSha256 === 'string' ? Uint8Array.from(wholeSha256.match(/../g).map((x) => Number.parseInt(x, 16))) : wholeSha256, 12);
  return result;
}

export function decodeResumeCounts(value) {
  if (value.byteLength !== 44) throw new Error('The peer sent invalid final transfer counts.');
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return { chunks: view.getUint32(0), bytes: view.getBigUint64(4), wholeSha256: bytesToHex(value.subarray(12)) };
}

export function encodeResumeAck(chunks, bytes) {
  const result = new Uint8Array(12);
  const view = new DataView(result.buffer);
  view.setUint32(0, chunks);
  view.setBigUint64(4, BigInt(bytes));
  return result;
}

export function decodeResumeAck(value) {
  if (value.byteLength !== 12) throw new Error('The peer sent invalid transfer progress.');
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  return { chunks: view.getUint32(0), bytes: view.getBigUint64(4) };
}

export function resumeSafeFilename(value) {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC') && !/[\\/\0]/.test(value) && value !== '.' && value !== '..';
}

export { KIND_ACCEPT, KIND_ACK, KIND_CHUNK, KIND_COMPLETE, KIND_END, KIND_OFFER, RECEIVER_DIRECTION, SENDER_DIRECTION, createResumeOpener, createResumeSealer, textEncoder, textDecoder };
