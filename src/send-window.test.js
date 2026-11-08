import assert from 'node:assert/strict';
import test from 'node:test';
import { createSendWindow } from './send-window.js';

const MiB = 1024 * 1024;

test('capacity admits complete chunks and prevents an extra chunk overflow', () => {
  const window = createSendWindow();
  assert.equal(window.canSend(4 * MiB), true);
  window.sent(4n * BigInt(MiB), 0);
  assert.equal(window.capacity, 0);
  assert.equal(window.canSend(256 * 1024), false);
  assert.throws(() => window.sent(4n * BigInt(MiB) + 1n, 0), /available window/);
  window.acked(1n * BigInt(MiB), 100);
  assert.equal(window.capacity, MiB);
});

test('slow delivery shrinks the window while outstanding data remains accounted', () => {
  const window = createSendWindow();
  window.sent(4 * MiB, 0);
  window.acked(MiB, 1000);
  window.acked(2 * MiB, 3000);
  assert.equal(window.size, MiB);
  assert.equal(window.inFlight, 2 * MiB);
  assert.equal(window.capacity, 0);
  window.acked(4 * MiB, 5000);
  assert.equal(window.inFlight, 0);
  assert(window.size >= MiB);
});

test('sustained full-window receipts grow within the configured maximum', () => {
  const window = createSendWindow();
  let sent = 0;
  for (let cycle = 0; cycle < 20; cycle++) {
    sent += window.capacity;
    window.sent(sent, cycle * 100);
    window.acked(sent, cycle * 100 + 100);
    assert(window.size <= 12 * MiB);
    assert.equal(window.inFlight, 0);
  }
  assert.equal(window.size, 12 * MiB);
});

test('ACK compression and zero RTT do not inflate a window without a delivery interval', () => {
  const window = createSendWindow();
  window.sent(4 * MiB, 0);
  window.acked(MiB, 0);
  window.acked(2 * MiB, 0);
  window.acked(3 * MiB, 1);
  window.acked(4 * MiB, 1);
  assert.equal(window.size, 4 * MiB);
  assert.equal(window.snapshot().sampleCount, 0);
});

test('invalid ACKs and clocks leave accounting unchanged', () => {
  const window = createSendWindow();
  window.sent(MiB, 10);
  window.acked(MiB / 2, 20);
  const before = window.snapshot();
  for (const [bytes, at] of [[MiB / 4, 30], [2 * MiB, 30], [MiB, 19], [-1, 30], [Number.MAX_SAFE_INTEGER + 1, 30]]) {
    assert.throws(() => window.acked(bytes, at), RangeError);
    assert.deepEqual(window.snapshot(), before);
  }
  assert.equal(window.acked(MiB / 2, 20), false);
});

test('tiny chunks use bounded metadata and payload is never retained', () => {
  const window = createSendWindow();
  for (let i = 1; i <= 100_000; i++) window.sent(i, i);
  assert.equal(window.snapshot().sampleCount, 64);
  window.acked(100_000n, 100_001);
  assert.equal(window.snapshot().sampleCount, 0);
});

test('bounds reject unsafe allocations', () => {
  for (const options of [{ maxBytes: 32 * MiB }, { minBytes: 8 * MiB }, { initialBytes: 0 }, { maxBytes: Infinity }]) {
    assert.throws(() => createSendWindow(options), RangeError);
  }
});

test('cumulative counts remain exact beyond Number safe integer range', () => {
  const base = 2n ** 80n;
  const window = createSendWindow({ initialOffset: base });
  window.sent(base + 4n * BigInt(MiB), 0);
  window.acked(base + 3n * BigInt(MiB), 100);
  window.sent(base + 7n * BigInt(MiB), 100);
  assert.equal(window.snapshot().sent, base + 7n * BigInt(MiB));
  assert.equal(window.snapshot().acknowledged, base + 3n * BigInt(MiB));
  assert.equal(window.inFlight, 4 * MiB);
  assert.throws(() => window.acked(Number(base), 200), /safe integer/);
});

function simulate({ total = 64 * MiB, receiverBytesPerSecond, rtt = 0, fixedWindow = null }) {
  const window = fixedWindow ? null : createSendWindow();
  const chunk = 256 * 1024;
  let sent = 0;
  let acked = 0;
  let now = 0;
  let maxInFlight = 0;
  let maxSamples = 0;
  const queue = [];
  while (acked < total) {
    while (sent < total && (window ? window.canSend(Math.min(chunk, total - sent)) : sent - acked + chunk <= fixedWindow)) {
      const count = Math.min(chunk, total - sent);
      sent += count;
      window?.sent(BigInt(sent), now);
      const deliveryAt = Math.max(now + rtt, queue.at(-1)?.at ?? now + rtt) + count / receiverBytesPerSecond * 1000;
      queue.push({ offset: sent, at: deliveryAt });
      maxInFlight = Math.max(maxInFlight, sent - acked);
      maxSamples = Math.max(maxSamples, window?.snapshot().sampleCount ?? 0);
    }
    assert(queue.length > 0, 'sender and receiver must keep making progress');
    const delivered = queue.shift();
    now = delivered.at;
    acked = delivered.offset;
    window?.acked(BigInt(acked), now);
  }
  return { seconds: now / 1000, mibPerSecond: total / MiB / (now / 1000), maxInFlight, maxSamples, finalWindow: window?.size };
}

test('repeatable slow receiver keeps outstanding bytes and metadata bounded', (t) => {
  const runs = Array.from({ length: 3 }, () => simulate({ receiverBytesPerSecond: MiB }));
  assert.deepEqual(runs[0], runs[1]);
  assert.deepEqual(runs[1], runs[2]);
  assert.equal(runs[0].mibPerSecond, 1);
  assert(runs[0].maxInFlight <= 12 * MiB);
  assert(runs[0].maxSamples <= 64);
  assert.equal(runs[0].finalWindow, MiB);
  t.diagnostic(`slow receiver ${JSON.stringify(runs[0])}`);
});

test('adaptive window improves a high bandwidth delayed path without exceeding its cap', (t) => {
  const options = { total: 256 * MiB, receiverBytesPerSecond: 128 * MiB, rtt: 300 };
  const adaptive = simulate(options);
  const fixed = simulate({ ...options, fixedWindow: 8 * MiB });
  assert(adaptive.mibPerSecond > fixed.mibPerSecond);
  assert(adaptive.maxInFlight <= 12 * MiB);
  assert(adaptive.maxSamples <= 64);
  t.diagnostic(`delayed path adaptive=${JSON.stringify(adaptive)} fixed=${JSON.stringify(fixed)}`);
});

test('duplicate acknowledgements still advance the monotonic clock', () => {
  const window = createSendWindow();
  window.sent(MiB, 10);
  window.acked(MiB / 2, 20);
  assert.equal(window.acked(MiB / 2, 100), false);
  assert.throws(() => window.acked(MiB, 99), /monotonic/);
  assert.throws(() => window.sent(MiB + 1, 99), /monotonic/);
  assert.equal(window.acked(MiB, 100), true);
});
