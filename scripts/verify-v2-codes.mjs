import assert from 'node:assert/strict';
import { randomBytes, createHash, createHmac, hkdfSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorker, withTimeout } from './harness.mjs';

const work = await mkdtemp(join(tmpdir(), 'cd-v2-codes-'));
const sockets = [];
let worker;
try {
  worker = await startWorker(work);
  const id = randomBytes(16), key = randomBytes(32), senderToken = randomBytes(32);
  const encode = bytes => Buffer.from(bytes).toString('base64url');
  const hash = bytes => encode(createHash('sha256').update(bytes).digest());
  const receiverToken = Buffer.from(hkdfSync('sha256', key, id, 'cd-transfer-v2 receiver join', 32));
  const cap = { transferId: encode(id), key: encode(key), version: 2, senderToken: encode(senderToken) };
  const proof = (role, nonce) => encode(createHmac('sha256', key).update(Buffer.concat([Buffer.from(`cd-transfer-v2 ${role} nonce`), id, nonce])).digest());
  async function peer(role) {
    const ws = new WebSocket(`${worker.publicBase.replace('http', 'ws')}/ws/v2/${cap.transferId}`);
    sockets.push(ws);
    const messages = [], waiting = [];
    ws.addEventListener('message', event => { const value = JSON.parse(event.data); const next = waiting.shift(); if (next) next(value); else messages.push(value); });
    const next = () => withTimeout(messages.length ? Promise.resolve(messages.shift()) : new Promise(resolve => waiting.push(resolve)), 10_000, 'relay event timed out');
    await withTimeout(new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); }), 10_000, 'socket timed out');
    const nonce = randomBytes(32);
    ws.send(JSON.stringify({ type: 'join', protocol: 'cd-transfer-v2', role, ...(role === 'sender' ? {
      senderToken: cap.senderToken, senderTokenHash: hash(senderToken), receiverTokenHash: hash(receiverToken), sessionNonce: encode(nonce)
    } : { receiverToken: encode(receiverToken), receiverNonce: encode(nonce) }), nonceProof: proof(role, nonce) }));
    assert.equal((await next()).type, 'accepted');
    return { ws, next };
  }
  const sender = await peer('sender');
  const post = body => fetch(`${worker.publicBase}/api/codes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ ...cap, senderToken: encode(randomBytes(32)) })).status, 403);
  assert.equal((await post({ ...cap, key: encode(randomBytes(32)) })).status, 403);
  const responses = await Promise.all(Array.from({ length: 5 }, () => post(cap)));
  const response = responses.shift();
  assert.equal(response.status, 200, 'admitted v2 sender must be able to claim a numeric code');
  const claim = await response.json();
  assert.match(claim.code, /^\d{5}$/);
  for (const other of responses) { assert.equal(other.status, 200); assert.equal((await other.json()).code, claim.code); }
  assert.ok(claim.expiresAt > Date.now() && claim.expiresAt <= Date.now() + 15 * 60_000);
  assert.equal((await (await post(cap)).json()).code, claim.code);
  const lookup = await fetch(`${worker.publicBase}/api/codes/${claim.code}`);
  assert.deepEqual(await lookup.json(), { transferId: cap.transferId, key: cap.key, version: 2 });
  assert.equal((await post({ ...cap, version: 3 })).status, 400);
  await peer('receiver');
  assert.equal((await sender.next()).type, 'peer-joined');
  assert.equal((await fetch(`${worker.publicBase}/api/codes/${claim.code}`)).status, 404);
  assert.equal((await post(cap)).status, 403);
  console.log('v2 numeric codes: authenticated claim, key proof, version, TTL, reuse and one-receiver release passed');
} finally {
  for (const socket of sockets) socket.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
