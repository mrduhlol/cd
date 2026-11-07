import test from 'node:test';
import assert from 'node:assert/strict';
import { frameMetadata, numericProgress, safeRoute, sanitizeDiagnostic, settle } from './v2-browser-diagnostics.mjs';

test('diagnostics remove capability paths, fragments, queries and userinfo', () => {
  const root = 'R'.repeat(22), key = 'K'.repeat(43);
  for (const protocol of ['https:', 'wss:']) {
    const url = `${protocol}//user:password@cd-test.example/s/${root}?key=${key}#v2.${key}`;
    const message = sanitizeDiagnostic(`request failed ${url}`);
    for (const secret of [root, key, 'user:', 'password', '?key=', '#v2.']) assert.equal(message.includes(secret), false);
    assert.match(message, /cd-test.example\/s\/\[transfer\]/);
  }
  assert.equal(safeRoute(`wss://cd-test.example/ws/v2/${root}`), 'wss://cd-test.example/ws/v2/[transfer]');
  assert.equal(safeRoute('https://cd-test.example/api/codes/12345'), 'https://cd-test.example/api/codes/[code]');
});

test('raw keys and nonce-like values are redacted but useful status remains', () => {
  const secret = 'abc_DEF-0123456789'.repeat(3);
  const message = sanitizeDiagnostic(`HTTP 429 closed 4429 key=${secret}`);
  assert.equal(message.includes(secret), false);
  assert.match(message, /HTTP 429 closed 4429/);
  assert.ok(sanitizeDiagnostic('x '.repeat(5000)).length <= 4000);
});

test('early rejected waits are captured rather than masking another failure', async () => {
  const original = new Error('original download failure');
  const outcome = settle(Promise.reject(original));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await outcome).error, original);
  assert.deepEqual(await settle(Promise.resolve(5)), { value: 5 });
});

test('binary frame diagnostics expose only the public v2 header, not payload', () => {
  const secret = Buffer.from('PRIVATE_FILE_CONTENTS_AND_KEY_MATERIAL');
  for (const [kind, name] of [[1, 'OFFER'], [2, 'CHUNK'], [3, 'END'], [4, 'ACCEPT'], [5, 'ACK'], [6, 'COMPLETE'], [9, 'SIGNAL']]) {
    const record = Buffer.alloc(12 + secret.length + 16);
    record.set([67, 68, 2, kind]);
    record.writeUInt32BE(0xffffffff, 4);
    record.writeUInt32BE(secret.length, 8);
    secret.copy(record, 12);
    const metadata = frameMetadata(2, record.toString('base64'));
    assert.deepEqual(metadata, { opcode: 2, bytes: record.length, kind: name, sequence: 0xffffffff, plaintextBytes: secret.length });
    for (const value of [secret.toString(), secret.toString('base64'), record.toString('base64')]) assert.equal(JSON.stringify(metadata).includes(value), false);
  }
  assert.deepEqual(frameMetadata(2, secret.toString('base64')), { opcode: 2, bytes: secret.length, record: 'unknown' });
  assert.deepEqual(frameMetadata(2, 'AA=='), { opcode: 2, bytes: 1, record: 'unknown' });
});

test('text frame diagnostics discard private joins, nonces, proofs, URLs and arbitrary messages', () => {
  const secret = 'sensitive-short-key';
  for (const type of ['join', 'accepted', 'peer-joined', 'peer-left', 'complete', 'completed', 'exhausted']) {
    const payload = JSON.stringify({ type, protocol: 'cd-transfer-v2', senderToken: secret, receiverToken: secret, sessionNonce: secret, nonceProof: secret, url: `https://example.test/s/${secret}#v2.${secret}` });
    assert.deepEqual(frameMetadata(1, payload), { opcode: 1, bytes: Buffer.byteLength(payload), control: type });
    assert.equal(JSON.stringify(frameMetadata(1, payload)).includes(secret), false);
  }
  for (const payload of [secret, JSON.stringify({ type: secret, protocol: 'cd-transfer-v2' }), JSON.stringify({ type: 'join', protocol: secret }), 'null']) {
    assert.deepEqual(frameMetadata(1, payload), { opcode: 1, bytes: Buffer.byteLength(payload), control: 'unknown' });
  }
  assert.deepEqual(frameMetadata(8, secret), { opcode: 8 });
  assert.deepEqual(frameMetadata(2, undefined), { opcode: 2, unavailable: true });
});

test('progress diagnostics accept only bounded numeric progress, never filenames or arbitrary text', () => {
  assert.deepEqual(numericProgress('25.0% · 262144 / 1048653 bytes'), { percent: 25, done: 262144, total: 1048653 });
  for (const value of ['', 'private-name.bin', '25.0% · 2 / 1 bytes', '101% · 1 / 1 bytes', '1% · 1 / 9007199254740992 bytes', '1% · 1 / 1 bytes\nprivate-key']) assert.equal(numericProgress(value), null);
});

test('bounded full diagnostic reports retain the frame trail without exposing capability values', () => {
  const secret = 'K'.repeat(43);
  const message = `${'safe event; '.repeat(500)} private=${secret}; last-frame=ACK`;
  assert.equal(sanitizeDiagnostic(message, 20000).includes(secret), false);
  assert.ok(sanitizeDiagnostic(message, 20000).endsWith('last-frame=ACK'));
  assert.equal(sanitizeDiagnostic('x'.repeat(10) + ' '.repeat(25000), 20000).length, 20000);
});
