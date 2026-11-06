import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecordAssembler, createRecordMerger, parseDirectOffer, splitRecord, offerDirect, DIRECT_BUFFER_BYTES } from './direct-link.js';

function record(sequence, plaintextLength) {
  const value = new Uint8Array(12 + plaintextLength + 16).fill(sequence & 0xff);
  value.set([0x43, 0x44, 1, 2]);
  const view = new DataView(value.buffer);
  view.setUint32(4, sequence);
  view.setUint32(8, plaintextLength);
  return value;
}

test('records split into 64 KiB pieces rebuild exactly', () => {
  const first = record(0, 200_000);
  const second = record(1, 10);
  const assembler = createRecordAssembler();
  const rebuilt = [];
  for (const piece of [...splitRecord(first), ...splitRecord(second)]) {
    assert.ok(piece.byteLength <= 64 * 1024);
    rebuilt.push(...assembler.push(piece));
  }
  assert.deepEqual(rebuilt, [first, second]);
  assert.throws(() => createRecordAssembler().push(new TextEncoder().encode('garbage text here')));
});

test('the merger orders both paths and drops second copies', () => {
  const merger = createRecordMerger();
  const records = [0, 1, 2, 3].map((sequence) => record(sequence, 4));
  assert.deepEqual(merger.push(records[2]), []);
  assert.deepEqual(merger.push(records[0]), [records[0]]);
  assert.deepEqual(merger.push(records[2]), []);
  assert.deepEqual(merger.push(records[1]), [records[1], records[2]]);
  assert.deepEqual(merger.push(records[1]), []);
  assert.deepEqual(merger.push(records[3].buffer), [records[3]]);
});

test('direct offers are optional and bounded', () => {
  assert.equal(parseDirectOffer({ name: 'a' }), null);
  assert.equal(parseDirectOffer({ direct: { sdp: 'v=0' } }), 'v=0');
  assert.equal(parseDirectOffer({ direct: { sdp: 'x'.repeat(70_000) } }), null);
  assert.equal(parseDirectOffer({ direct: { sdp: 5 } }), null);
});

test('assembly rejects oversized native messages before buffering', () => {
  const assembler = createRecordAssembler();
  assert.throws(() => assembler.push(new Uint8Array(64 * 1024 + 1)), /assembly buffer/);
  assert.equal(assembler.bufferedBytes, 0);
});

test('ordering bytes and record count both remain bounded', () => {
  const merger = createRecordMerger();
  for (let sequence = 1; sequence <= 32; sequence += 1) merger.push(record(sequence, 1024 * 1024 - 28));
  assert.equal(merger.pendingBytes, 32 * 1024 * 1024);
  assert.throws(() => merger.push(record(33, 1)), /ordering buffer/);
  assert.equal(merger.pendingRecords, 32);
  const countBound = createRecordMerger();
  for (let sequence = 1; sequence <= 256; sequence += 1) countBound.push(record(sequence, 0));
  assert.throws(() => countBound.push(record(257, 0)), /too many records/);
  assert.equal(countBound.pendingRecords, 256);
});

test('merger validates header and record length before retaining bytes', () => {
  const malformed = record(1, 2); malformed[0] = 0;
  assert.throws(() => createRecordMerger().push(malformed), /invalid record/);
  assert.throws(() => createRecordMerger().push(record(1, 2).subarray(0, 28)), /invalid record/);
});


test('direct native sends and queued ciphertext have independent hard caps', async () => {
  class Channel extends EventTarget {
    readyState = 'open'; bufferedAmount = 0; maxBuffered = 0; records = [];
    send(piece) {
      this.records.push(piece.slice()); this.bufferedAmount += piece.byteLength;
      this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
      setTimeout(() => { this.bufferedAmount -= piece.byteLength; }, 2);
    }
  }
  class Connection extends EventTarget {
    iceGatheringState = 'complete'; channel = new Channel();
    createDataChannel() { return this.channel; }
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription() {}
    async addIceCandidate() {}
    close() {}
  }
  const path = await offerDirect({ RTCPeerConnectionImpl: Connection, onRecord() {} });
  const bytes = record(0, 1024 * 1024 - 28);
  const sends = Array.from({ length: 16 }, () => path.send(bytes));
  await assert.rejects(path.send(bytes), /send queue is full/);
  await Promise.all(sends);
  assert.ok(path.connection.channel.maxBuffered <= DIRECT_BUFFER_BYTES);
  assert.equal(path.queuedSendBytes, 0);
  assert.deepEqual(path.connection.channel.records.slice(0, 16), splitRecord(bytes));
  await path.signal({ sdp: 'answer' });
  for (let index = 0; index < 64; index += 1) await path.signal({ candidate: { candidate: 'x' } });
  await assert.rejects(path.signal({ candidate: { candidate: 'x' } }), /Too many direct candidates/);
  path.close();
});

test('offer includes public candidates discovered after the gathering deadline', async () => {
  class Connection extends EventTarget {
    iceGatheringState = 'gathering';
    createDataChannel() { return new EventTarget(); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=candidate:host' }; }
    async setLocalDescription(value) { this.localDescription = value; }
    close() {}
  }
  const path = await offerDirect({ RTCPeerConnectionImpl: Connection, onRecord() {} });
  path.connection.localDescription = { type: 'offer', sdp: 'v=0\r\na=candidate:public typ srflx' };
  assert.match(path.sdp, /typ srflx/);
  path.close();
});

test('assembly accepts fragmented headers and coalesced records without aliasing input', () => {
  const expected = [record(0, 1), record(1, 100_000), record(2, 0)];
  const wire = Buffer.concat(expected.map(value => Buffer.from(value)));
  for (const size of [1, 7, 13, 4096, 65536]) {
    const assembler = createRecordAssembler();
    const received = [];
    for (let at = 0; at < wire.length; at += size) {
      const piece = new Uint8Array(wire.subarray(at, at + size));
      received.push(...assembler.push(piece));
      piece.fill(0);
    }
    assert.deepEqual(received, expected);
    assert.equal(assembler.bufferedBytes, 0);
  }
});

test('the merger releases its byte budget after ordered records drain', () => {
  const merger = createRecordMerger();
  for (let sequence = 1; sequence <= 31; sequence += 1) merger.push(record(sequence, 1024 * 1024 - 28));
  assert.equal(merger.push(record(0, 1)).length, 32);
  for (let sequence = 33; sequence <= 64; sequence += 1) assert.deepEqual(merger.push(record(sequence, 1024 * 1024 - 28)), []);
});

test('a delayed relay record can reorder the CLI 24 MiB striped window', () => {
  const merger = createRecordMerger();
  const directRecords = [];
  for (let sequence = 1; sequence <= 96; sequence += 1) {
    const value = record(sequence, 256 * 1024);
    directRecords.push(value);
    assert.deepEqual(merger.push(value), []);
  }
  assert.ok(merger.pendingBytes > 24 * 1024 * 1024);
  const delayedRelay = record(0, 1);
  assert.deepEqual(merger.push(delayedRelay), [delayedRelay, ...directRecords]);
  assert.equal(merger.pendingBytes, 0);
});
