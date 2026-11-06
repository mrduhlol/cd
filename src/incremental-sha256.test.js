import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IncrementalSHA256 } from './incremental-sha256.js';

test('incremental SHA256 matches node across chunk boundaries and clone/final is nonmutating', () => {
  for (const size of [0,1,55,56,63,64,65,255,256,257,65539]) {
    const bytes=Uint8Array.from({length:size},(_,i)=>(i*37+11)&255), hasher=new IncrementalSHA256();
    for(let i=0;i<bytes.length;i+=17)hasher.update(bytes.subarray(i,i+17));
    const expected=createHash('sha256').update(bytes).digest('hex');
    assert.equal(hasher.digestHex(),expected);assert.equal(hasher.clone().digestHex(),expected);assert.equal(hasher.digestHex(),expected);
  }
});

test('hashes offset views and retains only an owned partial block across updates', () => {
  const source = Uint8Array.from({ length: 4099 }, (_, i) => (i * 73 + 19) & 255);
  for (const chunkSize of [1, 31, 63, 64, 65, 127, 256, 1024, 4099]) {
    const hash = new IncrementalSHA256();
    const reference = createHash('sha256');
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      const chunk = source.slice(offset, offset + chunkSize);
      const storage = new Uint8Array(chunk.length + 14);
      storage.set(chunk, 7);
      hash.update(storage.subarray(7, 7 + chunk.length));
      reference.update(chunk);
      storage.fill(0);
      const prefix = reference.copy().digest('hex');
      assert.equal(hash.digestHex(), prefix);
      assert.equal(hash.clone().update(new Uint8Array()).digestHex(), prefix);
    }
    assert.equal(hash.digestHex(), reference.digest('hex'));
  }
});
