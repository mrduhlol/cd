import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

// Exercise the public Worker and real SQLite-backed DOs. No debug routes or internet egress.
const work = await mkdtemp(join(tmpdir(), 'cd-v2-relay-'));
const origin = 'https://cd.yash0.in';
const sockets = [];
const random = () => randomBytes(32).toString('base64url');
const digest = value => createHash('sha256').update(Buffer.from(value, 'base64url')).digest('base64url');
let serial = 0;
let mf;

function credentials() {
  const senderToken = random(), receiverToken = random();
  return { id: randomBytes(16).toString('base64url'), senderToken, receiverToken,
    senderTokenHash: digest(senderToken), receiverTokenHash: digest(receiverToken) };
}
const senderJoin = (c, sessionNonce = random()) => ({
  type: 'join', protocol: 'cd-transfer-v2', role: 'sender', senderToken: c.senderToken,
  senderTokenHash: c.senderTokenHash, receiverTokenHash: c.receiverTokenHash,
  sessionNonce, nonceProof: random(),
});
const receiverJoin = (c, receiverNonce = random()) => ({
  type: 'join', protocol: 'cd-transfer-v2', role: 'receiver', receiverToken: c.receiverToken,
  receiverNonce, nonceProof: random(),
});

function request(path, init = {}, ip) {
  const n = serial++;
  return mf.dispatchFetch(origin + path, { ...init,
    headers: { 'CF-Connecting-IP': ip ?? `198.18.${Math.floor(n / 250)}.${n % 250 + 1}`, ...init.headers } });
}

async function connect(c, joinMessage, version = 2, headers = {}) {
  const response = await request(`/ws/v${version}/${c.id}`, { headers: { Upgrade: 'websocket', ...headers } });
  assert.equal(response.status, 101, `upgrade refused: ${await response.text()}`);
  const ws = response.webSocket;
  assert.ok(ws);
  sockets.push(ws);
  const events = [];
  let closed = false;
  ws.addEventListener('message', event => events.push(typeof event.data === 'string' ? JSON.parse(event.data) : event.data));
  ws.addEventListener('close', event => { closed = true; events.push({ type: 'closed', code: event.code, reason: event.reason }); });
  ws.accept();
  ws.send(JSON.stringify(joinMessage));
  return { ws, events, get closed() { return closed; }, async event(type) {
    const deadline = performance.now() + 5000;
    while (performance.now() < deadline) {
      const index = events.findIndex(event => type === 'binary' ? event instanceof ArrayBuffer : event?.type === type);
      if (index !== -1) return events.splice(index, 1)[0];
      await delay(5);
    }
    throw new Error(`Missing ${type}; queued event types: ${events.map(event => event?.type ?? 'binary').join(', ')}`);
  } };
}

async function pair(c, sj = senderJoin(c), rj = receiverJoin(c)) {
  const sender = await connect(c, sj);
  const accepted = await sender.event('accepted');
  assert.equal(accepted.protocol, 'cd-transfer-v2');
  assert.equal(accepted.sessionNonce, sj.sessionNonce);
  assert.equal(accepted.senderNonceProof, sj.nonceProof);
  assert.ok(!('code' in accepted), 'private v2 must not create a share code');
  const receiver = await connect(c, rj);
  const bound = await receiver.event('accepted');
  assert.equal(bound.receiverNonce, rj.receiverNonce);
  assert.equal(bound.receiverNonceProof, rj.nonceProof);
  assert.equal(bound.sessionNonce, sj.sessionNonce);
  assert.equal(bound.expiresAt, accepted.expiresAt);
  await sender.event('peer-joined');
  await receiver.event('peer-joined');
  return { sender, receiver, sj, rj, expiry: accepted.expiresAt };
}

async function interrupt(p) {
  p.receiver.ws.close(1000, 'test interruption');
  assert.equal((await p.sender.event('closed')).code, 4404);
}

try {
  const scriptPath = join(work, 'worker.mjs');
  await build({ entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'neutral',
    external: ['cloudflare:workers'], outfile: scriptPath });
  const { workerOptions } = unstable_getMiniflareWorkerOptions('wrangler.jsonc');
  mf = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: workerOptions.compatibilityDate, compatibilityFlags: workerOptions.compatibilityFlags,
    durableObjects: workerOptions.durableObjects, ratelimits: workerOptions.ratelimits,
    name: 'cd-v2-relay', rootPath: work, modulesRoot: work,
    modules: true, scriptPath, port: 0, inspectorPort: 0,
    durableObjectsPersist: join(work, 'state'), unsafeInspectDurableObjects: true,
    log: new Log(LogLevel.WARN), outboundService: () => { throw new Error('Unexpected internet egress'); },
  }));
  await mf.ready;
  const health = await (await request('/api/health')).json();
  assert.equal(health.protocol, 'cd-transfer-v1', 'legacy health protocol field changed');
  assert.deepEqual(health.protocols, ['cd-transfer-v1', 'cd-transfer-v2']);
  const c = credentials();
  assert.equal((await request(`/ws/v2/${c.id}`)).status, 426);
  assert.equal((await request('/ws/v2/invalid', { headers: { Upgrade: 'websocket' } })).status, 404);
  for (const headers of [{ Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await request(`/ws/v2/${c.id}`, { headers: { Upgrade: 'websocket', ...headers } })).status, 403);
  }
  const attempts = [];
  for (let i = 1; i <= 35; i++) {
    const response = await request(`/ws/v2/${credentials().id}`, { headers: { Upgrade: 'websocket' } }, `2001:db8:1234:5678::${i.toString(16)}`);
    attempts.push(response.status);
    if (response.webSocket) { response.webSocket.accept(); sockets.push(response.webSocket); response.webSocket.close(); }
  }
  assert.ok(attempts.includes(429), 'rotating IPv6 addresses bypassed the shared /64 upgrade budget');
  assert.ok(attempts.every(status => status === 101 || status === 429));
  console.log('PASS v2 route, advertised support, origin restrictions, native access and normalized upgrade limits');

  const v1 = await connect(c, { type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: c.receiverTokenHash }, 1);
  assert.equal((await v1.event('accepted')).protocol, 'cd-transfer-v1');
  const sj = senderJoin(c);
  const sender = await connect(c, sj, 2, { Origin: origin });
  const admitted = await sender.event('accepted');
  const wrongSender = await connect(c, { ...senderJoin(c), senderToken: random() });
  assert.equal((await wrongSender.event('closed')).code, 4401);
  const wrongReceiver = await connect(c, { ...receiverJoin(c), receiverToken: random() });
  assert.equal((await wrongReceiver.event('closed')).code, 4401);
  await mf.unsafeEvictDurableObject('cd-v2-relay', 'TransferRoom', { name: `v2:${c.id}`, webSockets: 'hibernate' });
  const rj = receiverJoin(c);
  const receiver = await connect(c, rj);
  const bound = await receiver.event('accepted');
  assert.equal(bound.expiresAt, admitted.expiresAt);
  assert.equal(bound.sessionNonce, sj.sessionNonce);
  assert.equal(bound.receiverNonceProof, rj.nonceProof);
  await sender.event('peer-joined');
  await receiver.event('peer-joined');
  const duplicateReceiver = await connect(c, receiverJoin(c));
  assert.equal((await duplicateReceiver.event('closed')).code, 4401);
  const record = Uint8Array.from([67, 68, 2, 2, ...randomBytes(40)]);
  sender.ws.send(record);
  assert.deepEqual(new Uint8Array(await receiver.event('binary')), record, 'relay altered opaque record bytes');
  await interrupt({ sender, receiver });
  assert.equal(v1.closed, false, 'v2 disconnect terminated the v1 room with the same id');
  const v1Receiver = await connect(c, { type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: c.receiverToken }, 1);
  await v1Receiver.event('accepted');
  await v1.event('peer-joined');
  const replay = await connect(c, senderJoin(c, sj.sessionNonce));
  assert.equal((await replay.event('closed')).code, 4409);
  const alias = value => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    return value.slice(0, -1) + alphabet[alphabet.indexOf(value.at(-1)) ^ 1];
  };
  const aliasedSender = await connect(c, senderJoin(c, alias(sj.sessionNonce)));
  assert.equal((await aliasedSender.event('closed')).code, 4406, 'sender nonce alias bypassed canonical admission');
  const freshSender = await connect(c, senderJoin(c));
  await freshSender.event('accepted');
  const aliasedReceiver = await connect(c, receiverJoin(c, alias(rj.receiverNonce)));
  assert.equal((await aliasedReceiver.event('closed')).code, 4406, 'receiver nonce alias bypassed canonical admission');
  freshSender.ws.close();
  await freshSender.event('closed');
  const resumed = await pair(c);
  assert.equal(resumed.expiry, admitted.expiresAt, 'resume extended root expiry');
  assert.notEqual(resumed.sj.sessionNonce, sj.sessionNonce);
  await interrupt(resumed);
  console.log('PASS v1/v2 isolation, hibernation, token checks, opaque relay, nonce replay and explicit recovery');

  const privateRoot = credentials();
  const privateSender = await connect(privateRoot, senderJoin(privateRoot));
  const privateAccepted = await privateSender.event('accepted');
  assert.ok(!('code' in privateAccepted));
  const claim = await request('/api/codes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transferId: privateRoot.id, key: random() }) });
  assert.equal(claim.status, 403, 'v2 root must not authorize a v1 key-directory claim');
  privateSender.ws.close();
  console.log('PASS private v2 does not issue codes or admit directory claims');

  const finishing = await pair(credentials());
  const control = { type: 'complete', protocol: 'cd-transfer-v2', sessionNonce: finishing.sj.sessionNonce, receiverNonce: finishing.rj.receiverNonce };
  finishing.receiver.ws.send(JSON.stringify(control));
  assert.equal((await finishing.receiver.event('closed')).code, 4403, 'completion accepted without a forwarded COMPLETE record');
  await finishing.sender.event('closed');
  const terminalCredentials = credentials();
  const terminal = await pair(terminalCredentials);
  // The relay cannot decrypt records. This is a frame-header/state test, not a cipher test.
  const completeRecord = new Uint8Array(28); completeRecord.set([67, 68, 2, 6]);
  terminal.receiver.ws.send(completeRecord);
  assert.deepEqual(new Uint8Array(await terminal.sender.event('binary')), completeRecord);
  terminal.receiver.ws.send(JSON.stringify({ ...control, sessionNonce: terminal.sj.sessionNonce, receiverNonce: terminal.rj.receiverNonce }));
  await terminal.sender.event('completed');
  await terminal.receiver.event('completed');
  assert.equal((await request(`/ws/v2/${terminalCredentials.id}`, { headers: { Upgrade: 'websocket' } })).status, 410);
  console.log('PASS authenticated-role completion ordering and terminal tombstone');

  const invalidJoin = await connect(credentials(), { ...senderJoin(credentials()), padding: 'x'.repeat(2048) });
  assert.equal((await invalidJoin.event('closed')).code, 4406);
  const expiring = credentials();
  const expiry = Date.now() + 500;
  const expiringSender = await connect(expiring, { ...senderJoin(expiring), expiresAt: expiry });
  assert.equal((await expiringSender.event('accepted')).expiresAt, expiry);
  assert.equal((await expiringSender.event('closed')).code, 4408);
  console.log('PASS bounded joins and fixed root expiry through the actual alarm dispatcher');

  const history = credentials();
  const firstSenderNonce = random(), firstReceiverNonce = random();
  for (let i = 0; i < 65; i++) {
    const p = await pair(history, senderJoin(history, i === 0 ? firstSenderNonce : random()), receiverJoin(history, i === 0 ? firstReceiverNonce : random()));
    await interrupt(p);
  }
  await mf.unsafeEvictDurableObject('cd-v2-relay', 'TransferRoom', { name: `v2:${history.id}` });
  const oldSender = await connect(history, senderJoin(history, firstSenderNonce));
  assert.equal((await oldSender.event('closed')).code, 4409, 'earliest sender nonce replayed after 65 paired sessions');
  const historySender = await connect(history, senderJoin(history));
  await historySender.event('accepted');
  const oldReceiver = await connect(history, receiverJoin(history, firstReceiverNonce));
  assert.equal((await oldReceiver.event('closed')).code, 4409, 'earliest receiver nonce replayed after 65 paired sessions');
  historySender.ws.close();
  console.log('PASS complete sender and receiver nonce history survives more than 64 paired sessions');

  const budget = credentials();
  for (let i = 0; i < 128; i++) {
    const s = await connect(budget, senderJoin(budget));
    await s.event('accepted'); s.ws.close(); await s.event('closed');
  }
  const exhausted = await connect(budget, senderJoin(budget));
  assert.deepEqual(await exhausted.event('exhausted'), { type: 'exhausted', protocol: 'cd-transfer-v2', reason: 'session_limit' });
  assert.equal((await exhausted.event('closed')).code, 4410);
  console.log('PASS 128-session cap and actionable exhaustion event');
} finally {
  for (const socket of sockets) try { socket.close(); } catch {}
  await mf?.dispose();
  await rm(work, { recursive: true, force: true });
}
