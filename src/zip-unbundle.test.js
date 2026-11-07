import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createZipBundle } from './zip-bundle.js';
import { downloadNames, readBundle, safeEntryPath } from './zip-unbundle.js';

async function collect(iterable) {
  const parts = [];
  for await (const part of iterable) parts.push(part);
  return new Blob(parts);
}

test('readBundle returns every file from a browser bundle', async () => {
  const big = new Uint8Array(300_000).map((_, index) => index % 251);
  const files = [new File(['hello'], 'a.txt'), new File([big], 'big.bin'), new File([], 'empty'), new File(['dup'], 'a.txt')];
  const read = await readBundle(await collect(createZipBundle(files, { chunkBytes: 4096 }).stream()));
  assert.deepEqual(read.map((file) => [file.path, file.size]), [['a.txt', 5], ['big.bin', 300_000], ['empty', 0], ['a (2).txt', 3]]);
  assert.equal(await read[0].blob.text(), 'hello');
  assert.deepEqual(new Uint8Array(await read[1].blob.arrayBuffer()), big);
});

test('readBundle reads folders from a Go-built bundle', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cd-unbundle-'));
  mkdirSync(join(dir, 'docs', 'deep'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'deep', 'note.md'), 'nested');
  writeFileSync(join(dir, 'top.txt'), 'top');
  try {
    execFileSync('zip', ['-0', '-qr', 'out.zip', 'docs', 'top.txt'], { cwd: dir });
  } catch {
    t.skip('zip is not installed');
    return;
  }
  const read = await readBundle(new Blob([readFileSync(join(dir, 'out.zip'))]));
  assert.deepEqual(read.map((file) => file.path).sort(), ['docs/deep/note.md', 'top.txt']);
  assert.equal(await read.find((file) => file.path === 'top.txt').blob.text(), 'top');
});

test('readBundle refuses archives it cannot hand out as-is', async () => {
  await assert.rejects(readBundle(new Blob(['not a zip'])));
});

test('safeEntryPath rejects escapes and control characters', () => {
  assert.equal(safeEntryPath('a/b.txt'), 'a/b.txt');
  assert.equal(safeEntryPath('folder/'), 'folder');
  for (const name of ['../x', '/etc/passwd', 'a/../b', 'a\\b', 'a\u0000b', '', 'a//b', './a']) assert.equal(safeEntryPath(name), null, name);
});

test('downloadNames flattens only colliding paths', () => {
  assert.deepEqual(downloadNames(['a.txt', 'x/b.txt', 'y/b.txt']), ['a.txt', 'x_b.txt', 'y_b.txt']);
});

test('downloadNames reserves unique basenames against flattened collisions', () => {
  assert.deepEqual(
    downloadNames(['x/a.txt', 'y/a.txt', 'x_a.txt']),
    ['x_a (2).txt', 'y_a.txt', 'x_a.txt']
  );
  assert.deepEqual(
    downloadNames(['x/a.txt', 'y/a.txt', 'x_a.txt', 'x_a (2).txt']),
    ['x_a (3).txt', 'y_a.txt', 'x_a.txt', 'x_a (2).txt']
  );
});

test('downloadNames avoids case-insensitive and Unicode-equivalent collisions', () => {
  assert.deepEqual(
    downloadNames(['A.txt', 'a.txt', 'a (2).txt']),
    ['A.txt', 'a (3).txt', 'a (2).txt']
  );
  const names = downloadNames(['x/café.txt', 'x/cafe\u0301.txt']);
  assert.equal(new Set(names.map((name) => name.normalize('NFC').toLowerCase())).size, names.length);
});

test('downloadNames is deterministic and keeps all suggested names distinct', () => {
  const paths = ['x/a.txt', 'y/a.txt', 'x_a.txt', 'x_a (2).txt', 'z/a.txt'];
  const first = downloadNames(paths);
  assert.deepEqual(downloadNames(paths), first);
  assert.equal(new Set(first.map((name) => name.normalize('NFC').toLowerCase())).size, paths.length);
});


test('bundle directory limits reject oversized metadata before reading it', async () => {
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(10, 1, true);
  view.setUint32(12, 64 * 1024 * 1024, true);
  const reads = [];
  const size = 64 * 1024 * 1024 + 22;
  const blob = { size, slice(start, finish) {
    reads.push(finish - start);
    if (finish - start > 65557) throw new Error('oversized allocation requested');
    const bytes = new Uint8Array(finish - start);
    bytes.set(end, bytes.length - 22);
    return new Blob([bytes]);
  } };
  await assert.rejects(readBundle(blob), /bundle directory exceeds/);
  assert.ok(reads.every(size => size <= 65557));
});

test('ZIP64 metadata must use safe integer offsets', async () => {
  const bytes = new Uint8Array(98);
  const view = new DataView(bytes.buffer);
  view.setUint32(76, 0x06054b50, true);
  view.setUint16(86, 0xffff, true);
  view.setUint32(56, 0x07064b50, true);
  view.setBigUint64(64, 2n ** 53n + 1n, true);
  await assert.rejects(readBundle(new Blob([bytes])), /bundle is truncated/);
});
