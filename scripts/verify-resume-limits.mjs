import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createResumeSealer, createResumeOpener } from '../src/resume-protocol.js';

const minute = 60_000;
let clock = Date.now();
const random = () => randomBytes(32).toString('base64url');
const digest = token => createHash('sha256').update(Buffer.from(token, 'base64url')).digest('base64url');
const sockets = [];
// Clock/storage/attachment access exists only in this generated test Worker.
// Production exposes no debug route or environment override for these checks.
const fixture = `
import { DurableObject } from 'cloudflare:workers';
import { ResumeRoomProtocol } from ${JSON.stringify(resolve('worker/resume-room.ts'))};
export class TestResumeRoom extends DurableObject {
 constructor(ctx,env){super(ctx,env);this.protocol=new ResumeRoomProtocol(ctx,env);}
 async fetch(request){
  const url=new URL(request.url),action=url.pathname.split('/')[3];
  if(url.pathname.startsWith('/__test/')){
   if(action==='seed'){await this.ctx.storage.put('resume-room',await request.json());}
   if(action==='clock'){const value=await request.json();Date.now=()=>value.now;}
   if(action==='alarm')await this.protocol.alarm();
   if(action==='legacy')for(const socket of this.ctx.getWebSockets()){const a=socket.deserializeAttachment();if(a?.kind==='resume-peer'){delete a.lastActivityAt;socket.serializeAttachment(a);}}
   if(action==='reconstruct')this.protocol=new ResumeRoomProtocol(this.ctx,this.env);
   return Response.json({state:await this.ctx.storage.get('resume-room'),alarm:await this.ctx.storage.getAlarm(),attachments:this.ctx.getWebSockets().map(s=>({readyState:s.readyState,...s.deserializeAttachment()}))});
  }
  return this.protocol.fetch(request,url.pathname.split('/').at(-1));
 }
 async webSocketMessage(socket,message){await this.protocol.message(socket,message);}
 async webSocketClose(socket){await this.protocol.close(socket);}
 async webSocketError(socket){await this.protocol.close(socket);}
 async alarm(){await this.protocol.alarm();}
}
export default {fetch(request,env){const name=new URL(request.url).pathname.split('/')[2];return env.ROOMS.getByName(name).fetch(request);}};
`;
const bundle = await build({ stdin: { contents: fixture, resolveDir: process.cwd(), sourcefile: 'resume-limits-verification.ts', loader: 'ts' }, bundle: true, format: 'esm', platform: 'browser', external: ['cloudflare:workers'], write: false });
const worker = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-12', durableObjects: { ROOMS: { className: 'TestResumeRoom', useSQLite: true } } }));
async function until(read, description) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) { const value = await read(); if (value) return value; await delay(5); }
  throw new Error(`timed out: ${description}`);
}
async function debug(root, action = 'inspect', body) {
  const response = await worker.dispatchFetch(`http://localhost/__test/${root}/${action}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return response.json();
}
async function setClock(root, now) { clock = now; return debug(root, 'clock', { now }); }
async function connect(root, join) {
  const response = await worker.dispatchFetch(`http://localhost/ws/${root}`, { headers: { Upgrade: 'websocket' } });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  assert.ok(socket);
  const messages = [];
  socket.addEventListener('message', event => messages.push(typeof event.data === 'string' ? JSON.parse(event.data) : event.data));
  socket.addEventListener('close', event => messages.push({ type: 'closed', code: event.code, reason: event.reason }));
  socket.accept();
  sockets.push(socket);
  socket.send(JSON.stringify(join));
  return { socket, messages, event: type => until(() => messages.find(m => m?.type === type), `${root} ${type}: ${JSON.stringify(messages)}`) };
}
function credentials() {
  const senderToken = random(), receiverToken = random();
  return { senderToken, receiverToken, senderTokenHash: digest(senderToken), receiverTokenHash: digest(receiverToken) };
}
const senderJoin = (c, sessionNonce = random()) => ({ type: 'join', protocol: 'cd-transfer-v2', role: 'sender', senderToken: c.senderToken, senderTokenHash: c.senderTokenHash, receiverTokenHash: c.receiverTokenHash, sessionNonce, nonceProof: random() });
const receiverJoin = (c, receiverNonce = random()) => ({ type: 'join', protocol: 'cd-transfer-v2', role: 'receiver', receiverToken: c.receiverToken, receiverNonce, nonceProof: random() });
async function seed(root, c, sessions, nonces = []) {
  await debug(root, 'seed', { status: 'interrupted', expiresAt: clock + 24 * 60 * minute, senderTokenHash: c.senderTokenHash, receiverTokenHash: c.receiverTokenHash, sessions, nonces });
}
async function rejected(root, join, code, exhausted = false) {
  const connection = await connect(root, join);
  assert.equal((await connection.event('closed')).code, code);
  assert.equal(connection.messages.some(m => m?.type === 'exhausted'), exhausted);
  if (exhausted) {
    assert.deepEqual(await connection.event('exhausted'), { type: 'exhausted', protocol: 'cd-transfer-v2', reason: 'session_limit' });
    assert.equal((await connection.event('closed')).reason, 'transfer session limit reached');
  }
}
async function pair(root, c) {
  const sj = senderJoin(c), rj = receiverJoin(c);
  const sender = await connect(root, sj);
  await sender.event('accepted');
  const receiver = await connect(root, rj);
  await receiver.event('accepted');
  await sender.event('peer-joined');
  return { sender, receiver, sj, rj };
}
async function receiverRecords(paired) {
  const invitation = { id: randomBytes(16), key: randomBytes(32) };
  const nonces = { sessionNonce: Buffer.from(paired.sj.sessionNonce, 'base64url'), receiverNonce: Buffer.from(paired.rj.receiverNonce, 'base64url') };
  return { seal: await createResumeSealer(invitation, 1, nonces), open: await createResumeOpener(invitation, 1, nonces) };
}
try {
  const cap = 'cap', c = credentials(), prior = Array.from({ length: 127 }, random);
  await setClock(cap, clock);
  await seed(cap, c, 127, prior);
  const final = await pair(cap, c);
  assert.equal((await debug(cap)).state.sessions, 128, '128th session was not admitted');
  await rejected(cap, senderJoin(c), 4401);
  assert.equal((await debug(cap)).state.sessionNonce, final.sj.sessionNonce, 'active sender was replaced');
  final.receiver.socket.close(1000, 'interrupt final session');
  await final.sender.event('closed');
  const preserved = (await debug(cap)).state;
  assert.equal(preserved.status, 'interrupted');
  await rejected(cap, { ...senderJoin(c), senderToken: random() }, 4401);
  await rejected(cap, senderJoin(c, final.sj.sessionNonce), 4409);
  await rejected(cap, { ...receiverJoin(c), receiverToken: random() }, 4401);
  await rejected(cap, receiverJoin(c, final.rj.receiverNonce), 4409);
  await rejected(cap, senderJoin(c), 4410, true);
  await rejected(cap, receiverJoin(c), 4410, true);
  assert.deepEqual((await debug(cap)).state, preserved, 'cap rejection altered root/history');
  assert.deepEqual(preserved.nonces.slice(0, 127), prior, 'existing nonce history changed');

  const completeRoot = 'final-complete', completeCredentials = credentials();
  await seed(completeRoot, completeCredentials, 127);
  const completed = await pair(completeRoot, completeCredentials);
  const completeCodec = await receiverRecords(completed);
  completed.receiver.socket.send(await completeCodec.seal.seal(6, new TextEncoder().encode('complete')));
  const completeRecord = await until(() => completed.sender.messages.find(m => m instanceof ArrayBuffer), 'forwarded COMPLETE');
  assert.equal((await completeCodec.open.open(completeRecord)).kind, 6);
  completed.receiver.socket.send(JSON.stringify({ type: 'complete', protocol: 'cd-transfer-v2', sessionNonce: completed.sj.sessionNonce, receiverNonce: completed.rj.receiverNonce }));
  await completed.sender.event('completed');
  await completed.receiver.event('completed');
  assert.equal((await debug(completeRoot)).state.status, 'terminal');
  assert.equal((await worker.dispatchFetch(`http://localhost/ws/${completeRoot}`, { headers: { Upgrade: 'websocket' } })).status, 410);

  const waitingRoot = 'waiting', wc = credentials();
  const waiting = await connect(waitingRoot, senderJoin(wc));
  await waiting.event('accepted');
  const waitingStart = clock;
  assert.equal((await debug(waitingRoot)).alarm, waitingStart + 16 * minute);
  await setClock(waitingRoot, waitingStart + 15 * minute + 1);
  await debug(waitingRoot, 'alarm');
  assert.equal((await debug(waitingRoot)).state.status, 'waiting', '15-minute CLI admission wait cut short');
  assert.equal(waiting.socket.readyState, WebSocket.OPEN);
  await setClock(waitingRoot, waitingStart + 16 * minute);
  await debug(waitingRoot, 'alarm');
  assert.equal((await waiting.event('closed')).code, 4404);
  assert.equal((await debug(waitingRoot)).state.status, 'interrupted');
  const resumedWaiting = await connect(waitingRoot, senderJoin(wc));
  await resumedWaiting.event('accepted');
  assert.equal((await debug(waitingRoot)).state.sessions, 2, 'waiting lease destroyed resumable capability');

  const activeRoot = 'ack-activity', ac = credentials();
  const active = await pair(activeRoot, ac), pairedStart = clock;
  const firstAlarm = (await debug(activeRoot)).alarm;
  assert.equal(firstAlarm, pairedStart + 15 * minute);
  await setClock(activeRoot, pairedStart + 14 * minute);
  const ackCodec = await receiverRecords(active), counts = new Uint8Array(16);
  new DataView(counts.buffer).setBigUint64(0, 4n);
  new DataView(counts.buffer).setBigUint64(8, 1048576n);
  active.receiver.socket.send(await ackCodec.seal.seal(5, counts));
  const relayedAck = await until(() => active.sender.messages.find(m => m instanceof ArrayBuffer), 'ACK-only relay activity');
  const openedAck = await ackCodec.open.open(relayedAck);
  assert.equal(openedAck.kind, 5);
  assert.deepEqual(openedAck.plaintext, counts);
  const touched = await debug(activeRoot);
  assert.ok(touched.attachments.filter(a => a.kind === 'resume-peer').every(a => a.lastActivityAt === clock), 'ACK did not refresh both peers');
  assert.equal(touched.alarm, firstAlarm, 'each binary record reset the storage alarm');
  await setClock(activeRoot, pairedStart + 16 * minute);
  await debug(activeRoot, 'alarm');
  assert.equal((await debug(activeRoot)).state.status, 'paired', 'fresh ACK-only pair expired');
  assert.equal(active.sender.socket.readyState, WebSocket.OPEN);
  assert.equal(active.receiver.socket.readyState, WebSocket.OPEN);
  assert.equal((await debug(activeRoot)).alarm, pairedStart + 29 * minute, 'alarm did not follow persisted activity');
  await setClock(activeRoot, pairedStart + 29 * minute);
  await debug(activeRoot, 'alarm');
  assert.equal((await active.sender.event('closed')).code, 4404);
  assert.equal((await active.receiver.event('closed')).code, 4404);
  const staleState = (await debug(activeRoot)).state;
  assert.equal(staleState.status, 'interrupted');
  assert.equal(staleState.sessions, 1);
  assert.deepEqual(staleState.nonces, [active.sj.sessionNonce, active.rj.receiverNonce]);
  const resumed = await pair(activeRoot, ac);
  assert.equal((await debug(activeRoot)).state.sessions, 2, 'fresh authenticated resume was not admitted');
  assert.notEqual(resumed.sj.sessionNonce, active.sj.sessionNonce);

  const legacyRoot = 'legacy-grace', lc = credentials();
  const legacy = await pair(legacyRoot, lc);
  await debug(legacyRoot, 'legacy');
  await debug(legacyRoot, 'reconstruct');
  const grace = clock;
  assert.ok((await debug(legacyRoot)).attachments.every(a => a.lastActivityAt === grace));
  await setClock(legacyRoot, grace + 10 * minute);
  await debug(legacyRoot, 'reconstruct');
  await debug(legacyRoot, 'alarm');
  const legacySnapshot = await debug(legacyRoot);
  assert.equal(legacySnapshot.state.status, 'paired');
  assert.ok(legacySnapshot.attachments.every(a => a.lastActivityAt === grace), 'reconstruction extended legacy grace');
  assert.equal(legacySnapshot.alarm, grace + 15 * minute);
  await setClock(legacyRoot, grace + 15 * minute);
  await debug(legacyRoot, 'alarm');
  assert.equal((await legacy.sender.event('closed')).code, 4404);
  assert.equal((await debug(legacyRoot)).state.status, 'interrupted');
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const root = `concurrent-admission-${attempt}`, c = credentials();
    const sender = await connect(root, senderJoin(c));
    await sender.event('accepted');
    const candidates = await Promise.all([connect(root, receiverJoin(c)), connect(root, receiverJoin(c))]);
    await until(() => candidates.every(peer => peer.messages.some(m => m.type === 'accepted' || m.type === 'closed')), 'concurrent admission settles');
    const winners = candidates.filter(peer => peer.messages.some(m => m.type === 'accepted'));
    assert.equal(winners.length, 1, 'two receivers admitted to one resume session');
    const snapshot = await debug(root);
    const accepted = winners[0].messages.find(m => m.type === 'accepted');
    assert.equal(snapshot.state.receiverNonce, accepted.receiverNonce);
    assert.equal(snapshot.attachments.filter(a => a.kind === 'resume-peer' && a.role === 'receiver').length, 1);
    assert.equal(sender.messages.filter(m => m.type === 'peer-joined').length, 1);
  }
  console.log('Verified exactly one concurrent resumable receiver and matching persisted session binding.');
  console.log('Verified real Worker 128-session cap, authenticated exhaustion, replay separation, final-session completion and retained root/history.');
  console.log('Verified 16-minute waiting lease, 15-minute paired lease, ACK-only activity, lazy alarms, stale resume and persisted legacy grace.');
} finally {
  for (const socket of sockets) try { socket.close(1000, 'verification complete'); } catch {}
  await worker.dispose();
}
