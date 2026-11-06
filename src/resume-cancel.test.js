import assert from 'node:assert/strict';
import { it } from 'node:test';
import { encodeBase64Url } from './agent-protocol.js';
import { IncrementalSHA256 } from './incremental-sha256.js';
import { createReceiverStage, RESUME_CHUNK_SIZE } from './resume-browser.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function makeKV({ blockPut } = {}) {
  const values = new Map();
  return {
    async get(key) { return values.get(key); },
    async put(key, value) {
      if (blockPut) {
        blockPut.entered.resolve();
        await blockPut.release.promise;
      }
      values.set(key, structuredClone(value));
    },
    async delete(key) { values.delete(key); },
    values
  };
}

function makeStorage(blockClose) {
  const files = new Map();
  const directory = {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw new Error('Not found');
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { return new Blob([files.get(name).slice()]); },
        async createWritable({ keepExistingData = false } = {}) {
          let data = keepExistingData ? files.get(name).slice() : new Uint8Array();
          let cursor = 0;
          return {
            async seek(position) { cursor = position; },
            async write(input) {
              const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
              const next = new Uint8Array(Math.max(data.length, cursor + bytes.length));
              next.set(data);
              next.set(bytes, cursor);
              data = next;
              cursor += bytes.length;
            },
            async close() {
              if (blockClose) {
                blockClose.entered.resolve();
                await blockClose.release.promise;
              }
              files.set(name, data);
            },
            async abort() {}
          };
        }
      };
    },
    async removeEntry(name) { files.delete(name); }
  };
  return { files, storage: { async getDirectory() { return directory; } } };
}

it('cancel waits for an in-flight append and removes any checkpoint it finishes writing', async () => {
  const closeGate = { entered: deferred(), release: deferred() };
  const putGate = { entered: deferred(), release: deferred() };
  const { storage, files } = makeStorage(closeGate);
  const checkpoints = makeKV({ blockPut: putGate });
  const id = Uint8Array.from({ length: 16 }, (_, index) => index);
  const key = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  const invitation = { id, key };
  const rootId = encodeBase64Url(id);
  const chunk = Uint8Array.of(42);
  const offer = {
    name: 'cancel.bin', size: String(chunk.length), chunkSize: RESUME_CHUNK_SIZE,
    wholeSha256: new IncrementalSHA256().update(chunk).digestHex(), expiresAt: Date.now() + 60_000
  };
  const stage = await createReceiverStage({ invitation, rootId, offer, storage, checkpoints, secrets: makeKV() });

  const append = stage.append(chunk, 'A'.repeat(43));
  await closeGate.entered.promise;
  const cancelling = stage.cancel();
  let cancelSettled = false;
  void cancelling.then(() => { cancelSettled = true; });
  await Promise.resolve();
  assert.equal(cancelSettled, false, 'cancel must wait for the in-flight file close');

  closeGate.release.resolve();
  await putGate.entered.promise;
  await Promise.resolve();
  assert.equal(cancelSettled, false, 'cancel must wait for the in-flight checkpoint write');

  putGate.release.resolve();
  await append;
  await cancelling;
  assert.equal(files.size, 0, 'cancel removes the staged file after append settles');
  assert.equal(checkpoints.values.has(`receiver:${rootId}`), false, 'cancel removes a checkpoint written by the in-flight append');
  await assert.rejects(stage.append(chunk, 'B'.repeat(43)), /stage is closed/);
  assert.equal(files.size, 0, 'a later append cannot recreate staged data');
  assert.equal(checkpoints.values.has(`receiver:${rootId}`), false, 'a later append cannot recreate the checkpoint');
});

it('worker flush completes before the checkpoint, and cancellation waits then closes before cleanup', async () => {
  const originalWorker = globalThis.Worker;
  const flushGate = { entered: deferred(), release: deferred() };
  const putGate = { entered: deferred(), release: deferred() };
  const { storage, files } = makeStorage();
  let worker;
  globalThis.Worker = class {
    constructor() { worker = this; }
    postMessage(data) {
      void (async () => {
        if (data.type === 'write') {
          flushGate.entered.resolve();
          await flushGate.release.promise;
          const name = [...files.keys()][0];
          files.set(name, data.bytes.slice());
        }
        if (data.type === 'close') this.closed = true;
        this.onmessage({ data: { ok: true } });
      })();
    }
    terminate() { this.terminated = true; }
  };
  try {
    const checkpoints = makeKV({ blockPut: putGate });
    const id = new Uint8Array(16), key = new Uint8Array(32).fill(1), bytes = Uint8Array.of(42);
    const rootId = encodeBase64Url(id);
    const offer = { name: 'worker.bin', size: '1', chunkSize: RESUME_CHUNK_SIZE, wholeSha256: new IncrementalSHA256().update(bytes).digestHex(), expiresAt: Date.now() + 60_000 };
    const stage = await createReceiverStage({ invitation: { id, key }, rootId, offer, storage, checkpoints, secrets: makeKV() });
    const append = stage.append(bytes, 'A'.repeat(43));
    await flushGate.entered.promise;
    assert.equal(checkpoints.values.size, 0);
    assert.equal(stage.currentOffset, 0);
    const cancel = stage.cancel();
    flushGate.release.resolve();
    await putGate.entered.promise;
    assert.equal(stage.currentOffset, 0);
    assert.equal(worker.closed, undefined);
    putGate.release.resolve();
    await append;
    await cancel;
    assert.equal(worker.closed, true);
    assert.equal(worker.terminated, true);
    assert.equal(files.size, 0);
    assert.equal(checkpoints.values.size, 0);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});

it('explicit cancellation removes its checkpoint and staging even when worker close fails', async () => {
  const originalWorker = globalThis.Worker;
  let terminated = false;
  globalThis.Worker = class {
    postMessage(data) { queueMicrotask(() => this.onmessage({ data: data.type === 'close' ? { error: 'Close failed' } : { ok: true } })); }
    terminate() { terminated = true; }
  };
  try {
    const { storage, files } = makeStorage();
    const checkpoints = makeKV(), id = new Uint8Array(16), key = new Uint8Array(32).fill(2);
    const rootId = encodeBase64Url(id);
    const offer = { name: 'empty.bin', size: '0', chunkSize: RESUME_CHUNK_SIZE, wholeSha256: new IncrementalSHA256().digestHex(), expiresAt: Date.now() + 60_000 };
    const stage = await createReceiverStage({ invitation: { id, key }, rootId, offer, storage, checkpoints, secrets: makeKV() });
    await stage.bindSession('A'.repeat(43));
    await assert.rejects(stage.cancel(), /Close failed/);
    assert.equal(terminated, true);
    assert.equal(files.size, 0);
    assert.equal(checkpoints.values.size, 0);
  } finally {
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});
