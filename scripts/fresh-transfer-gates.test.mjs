import assert from 'node:assert/strict';
import test from 'node:test';
import { transferGateErrors } from './fresh-transfer-gates.mjs';
function result() {
  const input = { bytes: 64 * 1048576, sha256: 'a'.repeat(64) };
  return { schema: 1, runs: 3, input, rows: Array.from({ length: 3 }, (_, run) => ['auto', 'relay'].map(route => ({ run, route, ok: true, receiveMs: 2000, received: { ...input }, transport: { direct: route === 'auto' ? input.bytes : 0, relay: route === 'relay' ? input.bytes : 0, maxGapMs: 100 } }))).flat() };
}
test('accepts complete repeated direct and relay transfers', () => assert.deepEqual(transferGateErrors(result()), []));
test('rejects the reported KB/s failure even if a report claims a high speed', () => {
  const report = result(); report.rows[0].receiveMs = 640000; report.rows[0].mibPerSecond = 1000;
  assert.ok(transferGateErrors(report).includes('0/auto fell below 8 MiB/s'));
});
test('rejects long stalls, wrong hashes, and failed downloads', () => {
  for (const mutate of [r => r.rows[0].transport.maxGapMs = 30000, r => r.rows[0].received.sha256 = 'b'.repeat(64), r => r.rows[0].ok = false]) {
    const report = result(); mutate(report); assert.ok(transferGateErrors(report).length > 0);
  }
});
test('rejects missing, duplicate and misrouted repetitions', () => {
  for (const mutate of [r => r.rows.pop(), r => r.rows.push(r.rows[0]), r => r.rows[0].transport.direct = 0, r => r.rows[1].transport.direct = 1, r => r.rows[0].run = -1]) {
    const report = result(); mutate(report); assert.ok(transferGateErrors(report).length > 0);
  }
});
test('rejects smoke reports, invalid timing, and absent evidence', () => {
  for (const mutate of [r => r.runs = 1, r => r.input.bytes = 1048576, r => r.rows[0].receiveMs = 0, r => delete r.rows[0].transport, r => r.error = 'interrupted']) {
    const report = result(); mutate(report); assert.ok(transferGateErrors(report).length > 0);
  }
});
