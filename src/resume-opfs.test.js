import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import { createResumeWriter } from './resume-opfs.js';

const workerSource = await readFile(new URL('./resume-opfs-worker.js', import.meta.url), 'utf8');
function workerClass() {
  return class {
    terminated = false;
    constructor() {
      this.scope = { postMessage: data => queueMicrotask(() => this.onmessage?.({ data })) };
      runInNewContext(workerSource, { self: this.scope, Uint8Array, Number, Error });
    }
    postMessage(data) { queueMicrotask(() => this.scope.onmessage({ data })); }
    terminate() { this.terminated = true; }
  };
}

it('worker writes all partial writes and flushes before acknowledging, then closes once', async () => {
  const events = [];
  const file = {
    async createSyncAccessHandle() {
      return {
        write(bytes, { at }) { events.push(['write', at, [...bytes]]); return Math.min(2, bytes.length); },
        flush() { events.push(['flush']); },
        close() { events.push(['close']); }
      };
    }
  };
  const writer = await createResumeWriter(file, workerClass());
  await writer.write(Uint8Array.of(1, 2, 3, 4, 5), 17);
  assert.deepEqual(events, [['write', 17, [1, 2, 3, 4, 5]], ['write', 19, [3, 4, 5]], ['write', 21, [5]], ['flush']]);
  await Promise.all([writer.close(), writer.close()]);
  assert.deepEqual(events.at(-1), ['close']);
  assert.equal(events.filter(event => event[0] === 'close').length, 1);
  await assert.rejects(writer.write(Uint8Array.of(1), 0), /storage is closed/);
});

it('uses the writable-stream fallback only when sync worker initialization is unavailable', async () => {
  for (const WorkerImpl of [undefined, class { constructor() { throw new Error('Worker unavailable'); } }, workerClass()]) {
    const events = [];
    const file = {
      async createSyncAccessHandle() { throw new Error('Not supported'); },
      async createWritable(options) {
        assert.deepEqual(options, { keepExistingData: true });
        return {
          async seek(offset) { events.push(['seek', offset]); },
          async write(bytes) { events.push(['write', [...bytes]]); },
          async close() { events.push(['close']); }
        };
      }
    };
    const writer = await createResumeWriter(file, WorkerImpl);
    await writer.write(Uint8Array.of(7, 8), 23);
    await writer.close();
    assert.deepEqual(events, [['seek', 23], ['write', [7, 8]], ['close']]);
  }
});

it('propagates zero writes and flush failures without falling back after initialization', async () => {
  for (const failure of ['short-write', 'flush']) {
    let closes = 0;
    const file = {
      async createSyncAccessHandle() {
        return {
          write(bytes) { return failure === 'short-write' ? 0 : bytes.length; },
          flush() { throw new DOMException('Disk quota exceeded', 'QuotaExceededError'); },
          close() { closes++; }
        };
      },
      async createWritable() { assert.fail('must not fall back after a storage error'); }
    };
    const writer = await createResumeWriter(file, workerClass());
    await assert.rejects(writer.write(Uint8Array.of(1), 0), failure === 'short-write' ? /incomplete write/ : { name: 'QuotaExceededError' });
    await assert.rejects(writer.write(Uint8Array.of(2), 0));
    await writer.close();
    assert.equal(closes, 1);
  }
});

it('propagates worker crashes during writes and releases the worker', async () => {
  let instance;
  class CrashingWorker {
    constructor() { instance = this; }
    postMessage(data) {
      if (data.type === 'open') queueMicrotask(() => this.onmessage({ data: { ok: true } }));
      else queueMicrotask(() => this.onerror({ message: 'Worker crashed' }));
    }
    terminate() { this.terminated = true; }
  }
  const writer = await createResumeWriter({}, CrashingWorker);
  await assert.rejects(writer.write(Uint8Array.of(1), 0), /Worker crashed/);
  await writer.close();
  assert.equal(instance.terminated, true);
});
