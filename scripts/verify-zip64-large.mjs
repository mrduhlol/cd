import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createZipBundle } from '../src/zip-bundle.js';
import { readBundle } from '../src/zip-unbundle.js';

// Real >4 GiB offsets with bounded memory and sparse zero payload storage.
const work = await mkdtemp(join(tmpdir(), 'cd-zip64-large-'));
try {
  const chunkBytes = 8 * 1024 * 1024;
  const zeros = new ArrayBuffer(chunkBytes);
  const large = { name: 'large.bin', size: 2 ** 32 + 123, slice(start, end) {
    return { arrayBuffer: async () => end - start === chunkBytes ? zeros : new ArrayBuffer(end - start) };
  } };
  const source = createZipBundle([large, new File(['last file bytes'], 'last.txt')], { chunkBytes });
  const path = join(work, 'large.zip');
  const file = await open(path, 'wx');
  try {
    let offset = 0;
    for await (const part of source.stream()) {
      if (part.length < 1024) await file.write(part, 0, part.length, offset);
      offset += part.length;
    }
    assert.equal(offset, source.size);
    await file.truncate(offset);
    assert.ok((await file.stat()).blocks * 512 < 1024 * 1024, 'fixture must stay sparse');
  } finally { await file.close(); }
  execFileSync('python3', ['-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.getinfo("large.bin").file_size == 2**32+123; assert z.read("last.txt") == b"last file bytes"', path]);
  const reader = await open(path, 'r');
  try {
    function slice(start, end) {
      return { size: end - start, slice: (a, b) => slice(start + a, start + b), async arrayBuffer() {
        const buffer = Buffer.alloc(end - start);
        await reader.read({ buffer, position: start, length: buffer.length });
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
      } };
    }
    const entries = await readBundle(slice(0, source.size));
    assert.equal(entries[0].size, 2 ** 32 + 123);
    assert.equal(Buffer.from(await entries[1].blob.arrayBuffer()).toString(), 'last file bytes');
  } finally { await reader.close(); }
  console.log('ZIP64 >4 GiB sizes and offsets verified by Python and the browser bundle reader');
} finally { await rm(work, { recursive: true, force: true }); }
