import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { transform } from 'esbuild';

const { code } = await transform(await readFile(new URL('../worker/resume-room.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { ResumeRoomProtocol } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('concurrent receiver joins select one socket and persist its nonce', async () => {
  const token = randomBytes(32).toString('base64url');
  let state = { status: 'waiting', expiresAt: Date.now() + 60_000, sessions: 1, nonces: [], sessionNonce: randomBytes(32).toString('base64url'), receiverTokenHash: createHash('sha256').update(Buffer.from(token, 'base64url')).digest('base64url') };
  const socket = (attachment) => ({
    readyState: 1, attachment, messages: [],
    deserializeAttachment() { return this.attachment; },
    serializeAttachment(value) { this.attachment = value; },
    send(value) { this.messages.push(JSON.parse(value)); },
    close() { this.readyState = 3; }
  });
  const sender = socket({ kind: 'resume-peer', role: 'sender', sessionNonce: state.sessionNonce, lastActivityAt: Date.now() });
  const receivers = [socket({ kind: 'resume-pending', rootId: 'root' }), socket({ kind: 'resume-pending', rootId: 'root' })];
  let gate = Promise.resolve();
  const ctx = {
    getWebSockets: () => [sender, ...receivers],
    blockConcurrencyWhile(callback) {
      const next = gate.then(callback);
      gate = next.catch(() => {});
      return next;
    },
    storage: {
      async get() { return structuredClone(state); },
      async put(key, value) { state = structuredClone(value); },
      async getAlarm() { return null; },
      async setAlarm() {}
    }
  };
  const protocol = new ResumeRoomProtocol(ctx, {});
  await Promise.all(receivers.map(peer => protocol.message(peer, JSON.stringify({ type: 'join', protocol: 'cd-transfer-v2', role: 'receiver', receiverToken: token, receiverNonce: randomBytes(32).toString('base64url'), nonceProof: randomBytes(32).toString('base64url') }))));
  const winners = receivers.filter(peer => peer.messages.some(message => message.type === 'accepted'));
  assert.equal(winners.length, 1);
  assert.equal(state.receiverNonce, winners[0].attachment.receiverNonce);
  assert.equal(sender.messages.filter(message => message.type === 'peer-joined').length, 1);
});
