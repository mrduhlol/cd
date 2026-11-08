import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createZipBundle, crc32, fileSource, rechunk } from './zip-bundle.js';

async function collect(iterable) {
  const parts = [];
  for await (const part of iterable) parts.push(part);
  return Buffer.concat(parts.map((part) => Buffer.from(part)));
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('zip bundle size is exact and unzip restores every file', async () => {
  const files = [
    new File(['hello world'], 'a.txt'),
    new File([new Uint8Array(300_000).fill(7)], 'big.bin'),
    new File([], 'empty'),
    new File(['dup'], 'a.txt')
  ];
  const bundle = createZipBundle(files, { chunkBytes: 4096 });
  const bytes = await collect(bundle.stream());
  assert.equal(bytes.length, bundle.size);
  assert.match(bundle.name, /^cd-\d{8}-\d{6}\.zip$/);

  const dir = mkdtempSync(join(tmpdir(), 'cd-zip-'));
  writeFileSync(join(dir, 'b.zip'), bytes);
  execFileSync('unzip', ['-q', 'b.zip'], { cwd: dir });
  assert.equal(readFileSync(join(dir, 'a.txt'), 'utf8'), 'hello world');
  assert.equal(readFileSync(join(dir, 'a (2).txt'), 'utf8'), 'dup');
  assert.equal(readFileSync(join(dir, 'big.bin')).length, 300_000);
  assert.equal(readFileSync(join(dir, 'empty')).length, 0);
});

test('rechunk emits fixed-size pieces', async () => {
  const source = fileSource(new File([new Uint8Array(10_000)], 'x'), { chunkBytes: 333 });
  const sizes = [];
  for await (const piece of rechunk(source.stream(), 4096)) sizes.push(piece.length);
  assert.deepEqual(sizes, [4096, 4096, 1808]);
});

test('rechunk yields exact-size pieces from the source without copying', async () => {
  const first = new Uint8Array(4096).fill(1);
  const second = new Uint8Array(4096).fill(2);
  async function* source() {
    yield first;
    yield second;
  }
  const out = [];
  for await (const piece of rechunk(source(), 4096)) out.push(piece);
  assert.equal(out.length, 2);
  assert.equal(out[0], first);
  assert.equal(out[1], second);
});

test('rechunk mixes fast-path and buffered pieces in order', async () => {
  const bytes = Uint8Array.from({ length: 10 }, (_, index) => index);
  async function* source() {
    yield bytes.slice(0, 3); // partial: starts buffering
    yield bytes.slice(3, 7); // 4 bytes: completes the first chunk
    yield bytes.slice(7, 11); // 3 bytes: not exact, goes through the buffer
  }
  const out = [];
  for await (const piece of rechunk(source(), 4)) out.push(Array.from(piece));
  assert.deepEqual(out, [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9]]);

  // A buffered partial piece is copied; once the buffer flushes to empty, an
  // exact-size piece takes the fast path and is yielded as the same object.
  const data = Uint8Array.from({ length: 14 }, (_, index) => index);
  const exact = data.slice(8, 12);
  async function* mixed() {
    yield data.slice(0, 2); // buffered
    yield data.slice(2, 8); // completes [0..3], leaves [4..7] to copy
    yield exact; // exact size with nothing buffered
    yield data.slice(12, 14); // tail, flushed at end
  }
  const result = [];
  for await (const piece of rechunk(mixed(), 4)) result.push(piece);
  assert.deepEqual(result.map((piece) => Array.from(piece)), [[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13]]);
  assert.equal(result[2], exact);
});

test('three large recordings expose ZIP64 metadata without reading payloads', async () => {
  let reads = 0;
  const files = [5, 5, 3].map((gb, index) => ({
    name: `recording-${index}.mp4`,
    size: gb * 1024 ** 3,
    slice() { reads++; throw new Error('payload read'); }
  }));
  const source = createZipBundle(files);
  assert.ok(source.size > 13 * 1024 ** 3);
  assert.equal(source.files, 3);
  assert.equal(reads, 0);
  const iterator = source.stream();
  const { value: header } = await iterator.next();
  const view = new DataView(header.buffer);
  assert.equal(view.getUint16(4, true), 45);
  assert.equal(view.getUint32(18, true), 0xffffffff);
  const extra = 30 + view.getUint16(26, true);
  assert.equal(view.getBigUint64(extra + 4, true), BigInt(files[0].size));
  assert.equal(reads, 0);
  await iterator.return();
});

test('ZIP64 count trailer interoperates with Python without payload allocation', async () => {
  const files = Array.from({ length: 65535 }, (_, i) => new File([], String(i)));
  const source = createZipBundle(files);
  const bytes = await collect(source.stream());
  assert.equal(bytes.length, source.size);
  const dir = mkdtempSync(join(tmpdir(), 'cd-zip64-'));
  const path = join(dir, 'count.zip');
  writeFileSync(path, bytes);
  execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert len(z.infolist()) == 65535; assert z.read("65534") == b""', path]);
});

test('bundle rejects unsafe sizes and oversized UTF8 names before reading', () => {
  for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createZipBundle([{ name: 'x', size }]), /invalid file size/);
  }
  assert.throws(() => createZipBundle([{ name: 'é'.repeat(32768), size: 0 }]), /file name too long/);
  assert.throws(() => createZipBundle([{ name: 'x', size: Number.MAX_SAFE_INTEGER }]), /bundle too large/);
});

test('zip rejects names that overflow the UTF-8 filename length field', () => {
  assert.throws(() => createZipBundle([new File(['x'], 'é'.repeat(32768))]), /name too long/);
});
