import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  KIND_OFFER, KIND_CHUNK, KIND_END, KIND_ACCEPT, KIND_ACK, KIND_COMPLETE,
  SENDER_DIRECTION, RECEIVER_DIRECTION, encodeBase64Url
} from './agent-protocol.js';
import { createResumeOpener, createResumeSealer, resumeNonceProof, verifyResumeCheckpoint } from './resume-protocol.js';
const {
  startResumableSend, parseResumeLink, decodeBase64Url, RESUME_CHUNK_SIZE,
  encodeResumeAck, encodeResumeCounts, decodeResumeCounts
} = await import(process.env.CD_RESUME_SENDER_MODULE || './resume-browser.js');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encoder = new TextEncoder();
function kv() {
  const values = new Map(), writes = [];
  return { values, writes, async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); writes.push(value); }, async delete(key) { values.delete(key); } };
}

// Only the network is substituted. Both peers use the actual authenticated v2 records.
async function transfer({ chunks = 9, tail = 19, latency = 0, hold = false, invalidAck = false, resumed = 0, failRead = false } = {}) {
  const bytes = Uint8Array.from({ length: chunks * RESUME_CHUNK_SIZE + tail }, (_, i) => i % 251);
  const file = new File([bytes], 'pipeline.bin');
  const secrets = kv(), checkpoints = kv();
  let wire, operation, rootId, invitation, opener, sealer, wholeSha256;
  let received = resumed, count = Math.ceil(resumed / RESUME_CHUNK_SIZE), flight = 0, maxFlight = 0;
  let delivery = Promise.resolve(), ackDelivery = Promise.resolve(), peerError;
  const held = [], output = [];
  class Socket extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    constructor() { super(); wire = this; queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    emit(data) { this.dispatchEvent(new MessageEvent('message', { data })); }
    close(code = 1000) { this.readyState = 3; const event = new Event('close'); event.code = code; this.dispatchEvent(event); }
    send(data) {
      if (typeof data === 'string') {
        this.join = JSON.parse(data);
        this.emit(JSON.stringify({ type: 'accepted', protocol: 'cd-transfer-v2' }));
      } else {
        if (data[3] === KIND_CHUNK) { flight++; maxFlight = Math.max(maxFlight, flight); }
        delivery = delivery.then(async () => {
          const record = await opener.open(data);
          if (record.kind === KIND_OFFER) {
            const offer = JSON.parse(new TextDecoder().decode(record.plaintext));
            wholeSha256 = offer.wholeSha256;
            assert.equal(wholeSha256, sha(bytes));
            this.emit(await sealer.seal(KIND_ACCEPT, encoder.encode(JSON.stringify({ offset: String(resumed), prefixSha256: sha(bytes.subarray(0, resumed)) }))));
          } else if (record.kind === KIND_CHUNK) {
            output.push(record.plaintext);
            received += record.plaintext.length; count++;
            const ack = await sealer.seal(KIND_ACK, encodeResumeAck(count, invalidAck ? received + 1 : received));
            const deliver = () => { flight--; this.emit(ack); };
            if (hold) held.push(deliver);
            else {
              // Latency starts at receipt, allowing ACKs for multiple records to travel together.
              const ready = delay(latency);
              ackDelivery = ackDelivery.then(async () => { await ready; deliver(); });
            }
          } else if (record.kind === KIND_END) {
            assert.deepEqual(decodeResumeCounts(record.plaintext), { chunks: count, bytes: BigInt(bytes.length), wholeSha256: sha(bytes) });
            assert.deepEqual(Buffer.concat(output.map(x => Buffer.from(x))), Buffer.from(bytes.subarray(resumed)));
            this.emit(await sealer.seal(KIND_COMPLETE, encodeResumeCounts(count, received, wholeSha256)));
            this.emit(JSON.stringify({ type: 'completed', protocol: 'cd-transfer-v2' }));
          } else assert.fail('unexpected sender record');
        }).catch(error => { peerError = error; this.close(1011); });
      }
    }
  }
  const originalSocket = globalThis.WebSocket, originalLocation = globalThis.location;
  globalThis.WebSocket = Socket;
  globalThis.location = { protocol: 'https:', host: 'cd.example', origin: 'https://cd.example' };
  const started = performance.now();
  let reads = 0;
  const source = failRead ? { size: file.size, name: file.name, slice(...args) { if (++reads > chunks + 1 + 2) throw new Error('source unavailable'); return file.slice(...args); } } : file;
  operation = startResumableSend(source, { secrets, checkpoints, hooks: { onShare({ url, rootId: id }) {
    rootId = id;
    const parsed = parseResumeLink(url); invitation = { id: parsed.id, key: parsed.key };
    const sessionNonce = decodeBase64Url(wire.join.sessionNonce), receiverNonce = new Uint8Array(32).fill(37);
    const session = { sessionNonce, receiverNonce };
    void Promise.all([createResumeOpener(invitation, SENDER_DIRECTION, session), createResumeSealer(invitation, RECEIVER_DIRECTION, session), resumeNonceProof(invitation, 'receiver', receiverNonce)]).then(([o, s, proof]) => {
      opener = o; sealer = s;
      wire.emit(JSON.stringify({ type: 'peer-joined', protocol: 'cd-transfer-v2', sessionNonce: wire.join.sessionNonce, receiverNonce: encodeBase64Url(receiverNonce), receiverNonceProof: encodeBase64Url(proof) }));
    }).catch(error => { peerError = error; wire.close(1011); });
  } } });
  operation.done.catch(() => {});
  return {
    operation, checkpoints, secrets, bytes,
    get held() { return held; }, get flight() { return flight; }, get maxFlight() { return maxFlight; }, get rootId() { return rootId; },
    async waitFor(predicate) { const deadline = Date.now() + 3000; while (!predicate()) { if (peerError) throw peerError; assert.ok(Date.now() < deadline, 'sender did not make expected progress'); await delay(2); } },
    close() { wire.close(1006); },
    async finish() { try { const result = await operation.done; if (peerError) throw peerError; return { ...result, elapsedMs: performance.now() - started }; } finally { globalThis.WebSocket = originalSocket; globalThis.location = originalLocation; } },
    restore() { globalThis.WebSocket = originalSocket; globalThis.location = originalLocation; }
  };
}

it('pipelines bounded encrypted chunks and checkpoints only acknowledged prefix bytes', async () => {
  const t = await transfer({ hold: true });
  try {
    await t.waitFor(() => t.held.length === 4);
    assert.equal(t.flight, 4);
    assert.equal(t.checkpoints.values.get(`sender:${t.rootId}`).offset, 0);
    await delay(20);
    assert.equal(t.held.length, 4, 'a stalled receiver must bound sent records');
    t.held.shift()();
    await t.waitFor(() => t.checkpoints.values.get(`sender:${t.rootId}`).offset === RESUME_CHUNK_SIZE);
    const checkpoint = t.checkpoints.values.get(`sender:${t.rootId}`);
    assert.equal(checkpoint.prefixSha256, sha(t.bytes.subarray(0, RESUME_CHUNK_SIZE)));
    const token = decodeBase64Url(t.secrets.values.get(`sender:${t.rootId}`).senderToken);
    assert.equal(await verifyResumeCheckpoint(checkpoint, token), true);
    const deadline = Date.now() + 3000;
    while (t.checkpoints.values.has(`sender:${t.rootId}`)) {
      assert.ok(Date.now() < deadline, 'sender did not finish draining ACKs');
      for (const release of t.held.splice(0)) release();
      await delay(2);
    }
    const result = await t.finish();
    assert.equal(result.bytesSent, t.bytes.length);
    assert.equal(t.maxFlight, 4);
    assert.ok(result.maxWorkingBytes < 2 * 1024 * 1024);
    assert.equal(t.secrets.values.size, 0);
  } finally { t.restore(); }
});

it('retains only acknowledged progress after interruption with chunks in flight', async () => {
  const t = await transfer({ hold: true });
  try {
    await t.waitFor(() => t.held.length === 4);
    t.held.shift()();
    await t.waitFor(() => t.checkpoints.values.get(`sender:${t.rootId}`).offset === RESUME_CHUNK_SIZE);
    t.close();
    await assert.rejects(t.finish(), /interrupted/);
    const checkpoint = t.checkpoints.values.get(`sender:${t.rootId}`);
    assert.equal(checkpoint.offset, RESUME_CHUNK_SIZE);
    assert.equal(checkpoint.prefixSha256, sha(t.bytes.subarray(0, RESUME_CHUNK_SIZE)));
  } finally { t.restore(); }
});

it('rejects invalid durable ACKs without advancing its checkpoint', async () => {
  const t = await transfer({ invalidAck: true });
  try {
    await assert.rejects(t.finish(), /invalid saved progress/);
    assert.equal(t.checkpoints.values.get(`sender:${t.rootId}`).offset, 0);
  } finally { t.restore(); }
});

it('preserves its last durable checkpoint when the source fails with records in flight', async () => {
  const t = await transfer({ hold: true, failRead: true });
  try {
    await assert.rejects(t.finish(), /source unavailable/);
    assert.equal(t.checkpoints.values.get(`sender:${t.rootId}`).offset, 0);
    assert.ok(t.flight > 0 && t.flight <= 4);
  } finally { t.restore(); }
});

it('cancel removes sender secrets and checkpoints while ACKs are pending', async () => {
  const t = await transfer({ hold: true });
  try {
    await t.waitFor(() => t.held.length === 4);
    t.operation.cancel();
    await assert.rejects(t.finish(), /interrupted|canceled/);
    await t.waitFor(() => t.secrets.values.size === 0 && t.checkpoints.values.size === 0);
  } finally { t.restore(); }
});

it('completes resumed, empty, and short encrypted sources', async () => {
  for (const options of [{ resumed: RESUME_CHUNK_SIZE * 2 }, { chunks: 0, tail: 0 }, { chunks: 0, tail: 7 }]) {
    const t = await transfer(options);
    try { const result = await t.finish(); assert.equal(result.bytesSent, t.bytes.length - (options.resumed || 0)); } finally { t.restore(); }
  }
});

if (process.env.CD_RESUME_BENCH === '1') {
  it('measures encrypted resumable sending with delayed durable ACKs', async () => {
    const rows = [];
    for (let i = 0; i < Number(process.env.CD_RESUME_BENCH_RUNS || 7); i++) {
      const t = await transfer({ chunks: 32, tail: 0, latency: 30 });
      try { rows.push(await t.finish()); } finally { t.restore(); }
    }
    console.log(JSON.stringify({ benchmark: '8MiB encrypted v2, 30ms ACK latency', rows }));
  });
}
