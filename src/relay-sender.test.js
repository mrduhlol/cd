import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startRelaySend } from './relay-sender.js';
import { createZipBundle } from './zip-bundle.js';
import { createOpener, createSealer, decodeBase64Url, KIND_ACCEPT, KIND_ACK, KIND_COMPLETE, KIND_OFFER, KIND_CHUNK, KIND_END, SENDER_DIRECTION, RECEIVER_DIRECTION } from './agent-protocol.js';

function setup(t, payload, { largeChunks = false } = {}) {
  let instance;
  const installed = ['window', 'WebSocket', 'RTCPeerConnection'].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const events = new EventTarget();
  globalThis.window = { location: new URL('http://localhost:9999'), addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
  globalThis.RTCPeerConnection = undefined;
  class FakeSocket extends EventTarget {
    bufferedAmount = 0;
    readyState = 1;
    received = [];
    acknowledged = 0;
    chain = Promise.resolve();
    constructor(url) { super(); instance = this; this.id = new URL(url).pathname.split('/').at(-1); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    message(data) { const event = new Event('message'); event.data = data; this.dispatchEvent(event); }
    send(data) {
      this.chain = this.chain.then(async () => {
        if (typeof data === 'string') {
          const join = JSON.parse(data);
          const invitation = { id: decodeBase64Url(this.id), key: decodeBase64Url(join.shareKey) };
          this.opener = await createOpener(invitation, SENDER_DIRECTION);
          this.sealer = await createSealer(invitation, RECEIVER_DIRECTION);
          // Both arriving in one turn exercises pump resubscription while queued.
          this.message(JSON.stringify({ protocol: 'cd-transfer-v1', type: 'accepted', code: '11111' }));
          this.message(JSON.stringify({ protocol: 'cd-transfer-v1', type: 'peer-joined' }));
          return;
        }
        const { kind, plaintext } = await this.opener.open(data);
        if (kind === KIND_OFFER) {
          const offer = JSON.parse(new TextDecoder().decode(plaintext));
          const selection = largeChunks ? new TextEncoder().encode(JSON.stringify({ chunkSize: offer.maxChunkSize })) : new Uint8Array();
          this.message(await this.sealer.seal(KIND_ACCEPT, selection)); return;
        }
        if (kind === KIND_CHUNK) {
          this.received.push(plaintext);
          const size = this.received.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          if (size - this.acknowledged >= 1024 * 1024 || size === payload.length) {
            this.acknowledged = size;
            const counts = new Uint8Array(12); const view = new DataView(counts.buffer);
            view.setUint32(0, this.received.length); view.setBigUint64(4, BigInt(size));
            if (this.prefixAck) this.message('{}');
            this.message(await this.sealer.seal(KIND_ACK, counts));
          }
          return;
        }
        if (kind === KIND_END) this.message(await this.sealer.seal(KIND_COMPLETE, plaintext));
      });
      this.chain.catch(() => {});
    }
    close() { this.readyState = 3; const event = new Event('close'); event.code = 1000; this.dispatchEvent(event); }
  }
  globalThis.WebSocket = FakeSocket;
  t.after(() => { for (const [name, descriptor] of installed) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  return () => instance;
}

function source(payload, pause = 0) {
  return { name: 'payload.bin', type: 'application/octet-stream', size: payload.length, async *stream() { if (pause) await delay(pause); yield payload; } };
}

test('relay fallback preserves exact encrypted bytes and drains queued admission events', async (t) => {
  const payload = new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251);
  const socket = setup(t, payload);
  const stats = [];
  const transfer = startRelaySend(source(payload), { onTransport: (value) => stats.push(value) });
  await transfer.done;
  const received = Buffer.concat(socket().received.map((chunk) => Buffer.from(chunk)));
  assert.deepEqual(received, Buffer.from(payload));
  assert.equal(stats.at(-1).transport, 'relay');
  assert.equal(stats.at(-1).directBytes, 0);
  assert.ok(stats.at(-1).relayBytes > payload.length);
  assert.ok(stats.every((value) => value.retainedBytes === 0 && value.incomingBytes <= 4 * 1024 * 1024));
});

test('bundled source fragments retain exact archive bytes through negotiated relay records', async (t) => {
  const bundle = createZipBundle([new File([new Uint8Array(3 * 1024 * 1024 + 17).fill(71)], 'part.bin')]);
  const parts = [];
  for await (const part of bundle.stream()) parts.push(Buffer.from(part));
  const payload = Buffer.concat(parts);
  const socket = setup(t, payload, { largeChunks: true });
  await startRelaySend(bundle).done;
  assert.deepEqual(Buffer.concat(socket().received.map(part => Buffer.from(part))), payload);
  assert.ok(socket().received.every(part => part.byteLength <= 262144));
});

test('negotiated limits allow relay-sized frames with cumulative ACKs and an adaptive window', { timeout: 5000 }, async (t) => {
  const payload = new Uint8Array(9 * 1024 * 1024 + 17).map((_, index) => index % 251);
  const socket = setup(t, payload, { largeChunks: true });
  await startRelaySend(source(payload)).done;
  assert.equal(socket().received[0].byteLength, 262144);
  assert.equal(socket().received.at(-1).byteLength, 17);
  assert.deepEqual(Buffer.concat(socket().received.map(chunk => Buffer.from(chunk))), Buffer.from(payload));
});

test('relay native queue applies backpressure and resumes after drain', async (t) => {
  const payload = new Uint8Array(1024 * 1024);
  const socket = setup(t, payload);
  let timer;
  const transfer = startRelaySend(source(payload), { onState(state) { if (state === 'transferring') { socket().bufferedAmount = 4 * 1024 * 1024; timer = setTimeout(() => { socket().bufferedAmount = 0; }, 25); } } });
  t.after(() => clearTimeout(timer));
  await transfer.done;
  assert.equal(socket().received.length, 4);
});

test('unsolicited responses cannot grow the sender queue without limit', async (t) => {
  const payload = new Uint8Array(1024 * 1024);
  const socket = setup(t, payload);
  const transfer = startRelaySend(source(payload, 25), { onState(state) { if (state === 'transferring') { for (let index = 0; index < 300; index += 1) socket().message('{}'); } } });
  await assert.rejects(transfer.done, /safe response buffer/);
});

test('ACKs advance progress while the next source read is blocked', async (t) => {
  const payload = new Uint8Array(2 * 1024 * 1024);
  const socket = setup(t, payload);
  let acknowledged = false;
  let wake;
  const progress = new Promise(resolve => { wake = resolve; });
  let timer;
  t.after(() => clearTimeout(timer));
  const input = {
    name: 'payload.bin', type: 'application/octet-stream', size: payload.length,
    async *stream() {
      yield payload.subarray(0, 1024 * 1024);
      await Promise.race([progress, new Promise(resolve => { timer = setTimeout(resolve, 250); })]);
      assert.equal(acknowledged, true, 'delivered bytes must be acknowledged while source is waiting');
      yield payload.subarray(1024 * 1024);
    }
  };
  const transfer = startRelaySend(input, { onProgress(bytes) {
    if (bytes >= 1024 * 1024) { acknowledged = true; wake(); }
  } });
  await transfer.done;
  assert.equal(socket().received.length, 8);
});


test('source failure stops the concurrent ACK reader', async (t) => {
  setup(t, new Uint8Array(1024 * 1024));
  const input = { name: 'broken.bin', size: 1024 * 1024, async *stream() { throw new Error('read failed'); } };
  await assert.rejects(startRelaySend(input).done, /transfer failed/i);
});

test('empty source completes without waiting for an ACK', async (t) => {
  const payload = new Uint8Array();
  const socket = setup(t, payload);
  await startRelaySend(source(payload)).done;
  assert.equal(socket().received.length, 0);
});

test('short source fails instead of leaving the ACK reader waiting', async (t) => {
  const payload = new Uint8Array(1024 * 1024);
  setup(t, payload);
  const input = source(payload);
  input.size += 1;
  await assert.rejects(startRelaySend(input).done, /file changed/);
});


test('ignored control events do not strand a queued ACK', { timeout: 2000 }, async (t) => {
  const payload = new Uint8Array(1024 * 1024);
  const socket = setup(t, payload);
  const transfer = startRelaySend(source(payload), { onState(state) {
    if (state === 'transferring') socket().prefixAck = true;
  } });
  t.after(() => transfer.cancel());
  await transfer.done;
});
