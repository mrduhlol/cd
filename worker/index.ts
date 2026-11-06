import { DurableObject } from 'cloudflare:workers';
import { ResumeRoomProtocol } from './resume-room';
export { DeviceRoom } from './device-room';
import { clientPrefix, sameOrigin } from './code-security';

type Role = 'sender' | 'receiver';
type SocketAttachment = { kind: 'pending'; expiresAt: number; transferId?: string; prefix?: string } | { kind: 'peer'; role: Role };
// `code` is the room's short share code while the directory still holds it.
type CodeHolder = { prefix: string; leaseId: string };
type ShareCode = { code: string; transferId: string; expiresAt?: number; holder?: CodeHolder };
type ClaimedCode = { code: string; expiresAt: number };
type ClaimResult = { kind: 'claimed'; claim: ClaimedCode } | { kind: 'denied' } | { kind: 'busy' };
type RoomState =
  | { kind: 'empty' }
  | { kind: 'waiting'; receiverTokenHash: string; expiresAt: number; prefix?: string; shareCode?: ShareCode }
  | { kind: 'paired'; receiverTokenHash: string; expiresAt: number; prefix?: string; shareCode?: ShareCode }
  | { kind: 'terminal'; expiresAt: number };
// A sender that includes `shareKey` gets its short share code in the
// `accepted` event: one round trip from connect to code.
type SenderJoin = { type: 'join'; protocol: 'cd-transfer-v1'; role: 'sender'; receiverTokenHash: string; shareKey?: string };
type ReceiverJoin = { type: 'join'; protocol: 'cd-transfer-v1'; role: 'receiver'; receiverToken: string };
type Join = SenderJoin | ReceiverJoin;
type PeerAttachment = { id: string; peers: string[]; messages: number };

const MAX_JOIN_BYTES = 512;
const MAX_RECORD_BYTES = 1024 * 1024;
// 32 MiB peer buffer. Durable Object WebSockets cannot pause reading, so
// the relay has no backpressure of its own: senders bound what it holds with
// their end-to-end ack window (the CLI's adaptive window tops out at 24 MiB).
// Only a sender that ignores flow control reaches this cap and is cut off.
const MAX_PEER_BUFFER_BYTES = 32 * 1024 * 1024;
const JOIN_TIMEOUT_MS = 10 * 1000;
const ROOM_LIFETIME_MS = 2 * 60 * 60 * 1000;
const TOMBSTONE_MS = 5 * 60 * 1000;
const MAX_SIGNAL_BYTES = 128 * 1024;
const MAX_SIGNAL_MESSAGES = 512;

function isPeerID(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function isPeerAttachment(value: unknown): value is PeerAttachment {
  return !!value && typeof value === 'object'
    && 'id' in value && isPeerID(value.id)
    && 'peers' in value && Array.isArray(value.peers) && value.peers.every(isPeerID)
    && 'messages' in value && typeof value.messages === 'number' && Number.isSafeInteger(value.messages) && value.messages >= 0;
}

function isBase64Url32(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isSocketAttachment(value: unknown): value is SocketAttachment {
  if (!value || typeof value !== 'object' || !('kind' in value)) return false;
  if (value.kind === 'pending') {
    return 'expiresAt' in value && typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt)
      && (!('transferId' in value) || typeof value.transferId === 'string');
  }
  return value.kind === 'peer' && 'role' in value && (value.role === 'sender' || value.role === 'receiver');
}

function parseJoin(message: string): Join | null {
  if (new TextEncoder().encode(message).byteLength > MAX_JOIN_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(message); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (!('type' in value) || !('protocol' in value) || !('role' in value)) return null;
  if (value.type !== 'join' || value.protocol !== 'cd-transfer-v1') return null;
  if (value.role === 'sender' && 'receiverTokenHash' in value && isBase64Url32(value.receiverTokenHash) && !('receiverToken' in value)) {
    const join: SenderJoin = { type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: value.receiverTokenHash };
    if ('shareKey' in value) {
      if (!isBase64Url32(value.shareKey)) return null;
      join.shareKey = value.shareKey;
    }
    return join;
  }
  if (value.role === 'receiver' && 'receiverToken' in value && isBase64Url32(value.receiverToken) && !('receiverTokenHash' in value)) {
    return { type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: value.receiverToken };
  }
  return null;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
  return decoded;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function hashToken(encodedToken: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', decodeBase64Url(encodedToken));
  return encodeBase64Url(new Uint8Array(digest));
}

function equalTokenHashes(left: string, right: string): boolean {
  let leftBytes: Uint8Array;
  let rightBytes: Uint8Array;
  try {
    leftBytes = decodeBase64Url(left);
    rightBytes = decodeBase64Url(right);
  } catch {
    return false;
  }
  if (leftBytes.byteLength !== 32 || rightBytes.byteLength !== 32) return false;
  const subtle = crypto.subtle;
  return 'timingSafeEqual' in subtle && typeof subtle.timingSafeEqual === 'function'
    && subtle.timingSafeEqual(leftBytes, rightBytes);
}

function relayEvent(type: 'accepted' | 'peer-joined' | 'peer-left', extra: Record<string, string | number> = {}): string {
  return JSON.stringify({ type, protocol: 'cd-transfer-v1', ...extra });
}

function logEvent(event: string, detail: Record<string, string | number> = {}): void {
  console.info(JSON.stringify({ event, ...detail }));
}

function reject(socket: WebSocket, code: number, reason: string): void {
  logEvent('connection_rejected', { code, reason });
  socket.close(code, reason);
}

export class TransferRoom extends DurableObject<Env> {
  private room: RoomState = { kind: 'empty' };
  private resume: ResumeRoomProtocol;
  private claiming: Promise<ClaimResult> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.resume = new ResumeRoomProtocol(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.room = await ctx.storage.get<RoomState>('room') ?? { kind: 'empty' };
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (!sameOrigin(request)) return new Response('origin forbidden', { status: 403 });
    const resumeRoot = /^\/ws\/v2\/([A-Za-z0-9_-]{22})$/.exec(new URL(request.url).pathname)?.[1];
    if (resumeRoot) return this.resume.fetch(request, resumeRoot);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
    if (this.ctx.getWebSockets().length >= 4) return new Response('room connection limit reached', { status: 429 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const expiresAt = Date.now() + JOIN_TIMEOUT_MS;
    const transferId = /^\/ws\/v1\/([A-Za-z0-9_-]{22})$/.exec(new URL(request.url).pathname)?.[1];
    server.serializeAttachment({ kind: 'pending', expiresAt, transferId, prefix: clientPrefix(request) } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server);
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (currentAlarm === null || expiresAt < currentAlarm) await this.ctx.storage.setAlarm(expiresAt);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const rawAttachment = socket.deserializeAttachment() as { kind?: string } | null;
    if (rawAttachment?.kind?.startsWith('resume-')) { await this.resume.message(socket, message); return; }
    const attachment: unknown = socket.deserializeAttachment();
    if (!isSocketAttachment(attachment)) { reject(socket, 4400, 'invalid connection'); return; }
    if (this.isExpired()) {
      await this.expireRoom();
      return;
    }
    if (attachment.kind === 'pending') {
      if (attachment.expiresAt <= Date.now()) { reject(socket, 4408, 'join expired'); return; }
      if (typeof message !== 'string') { reject(socket, 4400, 'join required'); return; }
      const join = parseJoin(message);
      if (!join) { reject(socket, 4406, 'invalid protocol join'); return; }
      await this.admit(socket, join, attachment.transferId, attachment.prefix);
      return;
    }
    if (this.room.kind !== 'paired') { reject(socket, 4400, 'room is not paired'); return; }
    if (typeof message === 'string' || message.byteLength > MAX_RECORD_BYTES) { reject(socket, 4403, 'invalid relay frame'); return; }
    const peer = this.peer(attachment.role === 'sender' ? 'receiver' : 'sender');
    if (!peer) { reject(socket, 4404, 'peer unavailable'); return; }
    if (peer.bufferedAmount + message.byteLength > MAX_PEER_BUFFER_BYTES) {
      logEvent('backpressure_limit', { bufferedBytes: peer.bufferedAmount });
      reject(socket, 4429, 'peer is too slow');
      reject(peer, 4429, 'peer is too slow');
      await this.finishRoom();
      return;
    }
    try {
      peer.send(message);
    } catch {
      reject(socket, 1011, 'relay send failed');
      reject(peer, 1011, 'relay send failed');
      await this.finishRoom();
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    const rawAttachment = socket.deserializeAttachment() as { kind?: string } | null;
    if (rawAttachment?.kind?.startsWith('resume-')) { await this.resume.close(socket); return; }
    // Complete the close handshake. Clients wait for this reply to know every
    // frame they sent before it (such as COMPLETE) reached the room; without
    // it they sit out their close timeout.
    try { socket.close(code === 1005 || code === 1006 ? 1000 : code, 'closed'); } catch { /* Already closed. */ }
    const attachment: unknown = socket.deserializeAttachment();
    if (!isSocketAttachment(attachment) || attachment.kind !== 'peer') return;
    const peer = this.peer(attachment.role === 'sender' ? 'receiver' : 'sender');
    if (peer) {
      try { peer.send(relayEvent('peer-left', { reason: reason || String(code) })); } catch { /* Best effort during teardown. */ }
      try { peer.close(4404, 'peer left'); } catch { /* Best effort during teardown. */ }
    }
    await this.finishRoom();
  }

  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket, 1011, 'socket error'); }

  async alarm(): Promise<void> {
    await this.resume.alarm();
    const now = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (attachment && typeof attachment === 'object' && 'kind' in attachment
        && (attachment.kind === 'resume-pending' || attachment.kind === 'resume-peer')) continue;
      if (!isSocketAttachment(attachment)) reject(socket, 4408, 'join expired');
      else if (attachment.kind === 'pending' && attachment.expiresAt <= now) reject(socket, 4408, 'join expired');
    }
    if (this.room.kind === 'terminal') {
      if (this.room.expiresAt <= now) {
        for (const socket of this.ctx.getWebSockets()) socket.close(4408, 'room reset');
        await this.ctx.storage.delete('room');
        this.room = { kind: 'empty' };
        logEvent('room_reset');
      }
      await this.scheduleAlarm();
      return;
    }
    if (this.isExpired()) {
      await this.expireRoom();
      return;
    }
    await this.scheduleAlarm();
  }

  private async admit(socket: WebSocket, join: Join, transferId: string | undefined, prefix: string | undefined): Promise<void> {
    if (join.role === 'sender') {
      if (this.room.kind !== 'empty') { reject(socket, 4409, 'sender unavailable'); return; }
      const expiresAt = Date.now() + ROOM_LIFETIME_MS;
      const nextRoom: RoomState = { kind: 'waiting', receiverTokenHash: join.receiverTokenHash, expiresAt, prefix };
      socket.serializeAttachment({ kind: 'peer', role: 'sender' } satisfies SocketAttachment);
      await this.ctx.storage.put('room', nextRoom);
      this.room = nextRoom;
      await this.scheduleAlarm();
      logEvent('sender_admitted');
      let claimed: ClaimedCode | null = null;
      if (join.shareKey && transferId) {
        try {
          const result = await this.claimCode({ transferId, key: join.shareKey });
          if (result.kind === 'claimed') claimed = result.claim;
        } catch (error) {
          console.error(JSON.stringify({ event: 'code_directory_failed', error: error instanceof Error ? error.message : 'unknown' }));
        }
      }
      try {
        socket.send(relayEvent('accepted', claimed ? { code: claimed.code, expiresAt: claimed.expiresAt } : {}));
      } catch {
        reject(socket, 1011, 'relay send failed');
        await this.finishRoom();
      }
      return;
    }
    if (this.room.kind !== 'waiting' || this.peer('receiver')) {
      reject(socket, this.room.kind === 'empty' ? 4404 : 4409, this.room.kind === 'empty' ? 'sender unavailable' : 'receiver unavailable');
      return;
    }
    const suppliedHash = await hashToken(join.receiverToken);
    if (this.isExpired()) {
      await this.expireRoom();
      return;
    }
    if (this.room.kind !== 'waiting' || !equalTokenHashes(suppliedHash, this.room.receiverTokenHash)) { reject(socket, 4401, 'receiver unauthorized'); return; }
    const sender = this.peer('sender');
    if (!sender) { reject(socket, 4404, 'sender unavailable'); return; }
    socket.serializeAttachment({ kind: 'peer', role: 'receiver' } satisfies SocketAttachment);
    const shareCode = this.room.shareCode;
    const nextRoom: RoomState = { kind: 'paired', receiverTokenHash: this.room.receiverTokenHash, expiresAt: this.room.expiresAt };
    await this.ctx.storage.put('room', nextRoom);
    this.room = nextRoom;
    logEvent('room_paired');
    await this.scheduleAlarm();
    try {
      socket.send(relayEvent('accepted'));
      socket.send(relayEvent('peer-joined'));
      sender.send(relayEvent('peer-joined'));
    } catch {
      reject(socket, 1011, 'relay send failed');
      reject(sender, 1011, 'relay send failed');
      await this.finishRoom();
    }
    // The room admits one receiver, so the code has done its job: release
    // it now instead of leaving it guessable until expiry.
    await this.releaseCode(shareCode);
  }

  // Only internal binding calls reach this method. Both join-time and old
  // POST clients must prove possession of the admitted sender's master key.
  async claimCode(capability: CodeCapability): Promise<ClaimResult> {
    if (this.room.kind !== 'waiting' || this.isExpired() || !this.peer('sender') || !this.room.prefix) return { kind: 'denied' };
    const material = await crypto.subtle.importKey('raw', decodeBase64Url(capability.key), 'HKDF', false, ['deriveBits']);
    const token = await crypto.subtle.deriveBits({
      name: 'HKDF', hash: 'SHA-256', salt: decodeBase64Url(capability.transferId),
      info: new TextEncoder().encode('cd-transfer-v1 receiver join'),
    }, material, 256);
    const proof = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', token)));
    if (this.room.kind !== 'waiting' || this.isExpired() || !this.peer('sender') || !this.room.prefix
      || !equalTokenHashes(proof, this.room.receiverTokenHash)) return { kind: 'denied' };
    if (this.claiming) return this.claiming;
    this.claiming = this.reserveCode(capability, this.room.prefix);
    try { return await this.claiming; } finally { this.claiming = null; }
  }

  private async reserveCode(capability: CodeCapability, prefix: string): Promise<ClaimResult> {
    if (this.room.kind !== 'waiting') return { kind: 'denied' };
    const existing = this.room.shareCode;
    if (existing?.expiresAt && existing.expiresAt > Date.now()) {
      return { kind: 'claimed', claim: { code: existing.code, expiresAt: existing.expiresAt } };
    }
    await this.releaseCode(existing);
    const holder = { prefix, leaseId: crypto.randomUUID() };
    const expiresAt = Date.now() + CODE_TTL_MS;
    if (!await prefixGuard(this.env, prefix).hold(holder.leaseId, expiresAt)) return { kind: 'busy' };
    let claimed: ClaimedCode | null = null;
    let claimCompleted = false;
    try {
      claimed = await claimShareCode(this.env, capability, expiresAt);
      claimCompleted = true;
      if (!claimed) return { kind: 'busy' };
      const shareCode: ShareCode = { ...claimed, transferId: capability.transferId, holder };
      // Room close/pairing may have happened during cross-object calls.
      if (this.room.kind !== 'waiting' || this.isExpired() || !this.peer('sender')) {
        await this.releaseCode(shareCode);
        return { kind: 'denied' };
      }
      this.room = { ...this.room, shareCode };
      await this.ctx.storage.put('room', this.room);
      return { kind: 'claimed', claim: claimed };
    } finally {
      // An RPC error can follow a committed claim. Keep its lease until
      // expiry rather than allowing ambiguous claims to evade the cap.
      if (claimCompleted && !claimed) await prefixGuard(this.env, prefix).unhold(holder.leaseId);
    }
  }

  private peer(role: Role): WebSocket | null {
    return this.ctx.getWebSockets().find((socket) => {
      const attachment: unknown = socket.deserializeAttachment();
      return socket.readyState === WebSocket.OPEN && isSocketAttachment(attachment) && attachment.kind === 'peer' && attachment.role === role;
    }) ?? null;
  }

  private isExpired(): boolean {
    return (this.room.kind === 'waiting' || this.room.kind === 'paired') && this.room.expiresAt <= Date.now();
  }

  private async expireRoom(): Promise<void> {
    logEvent('room_expired');
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState === WebSocket.OPEN) socket.close(4408, 'room expired');
    }
    await this.finishRoom();
  }

  private async releaseCode(shareCode: ShareCode | undefined): Promise<void> {
    if (!shareCode) return;
    try {
      await codeShard(this.env, shareCode.code).release(shareCode.code, shareCode.transferId);
      if (shareCode.holder) await prefixGuard(this.env, shareCode.holder.prefix).unhold(shareCode.holder.leaseId);
    } catch { /* The code expires on its own. */ }
  }

  private async finishRoom(): Promise<void> {
    if (this.room.kind === 'empty' || this.room.kind === 'terminal') return;
    const shareCode = this.room.shareCode;
    const nextRoom = { kind: 'terminal', expiresAt: Date.now() + TOMBSTONE_MS } satisfies RoomState;
    await this.ctx.storage.put('room', nextRoom);
    this.room = nextRoom;
    logEvent('room_terminal');
    await this.scheduleAlarm();
    await this.releaseCode(shareCode);
  }

  private async scheduleAlarm(): Promise<void> {
    const deadlines: number[] = [];
    if (this.room.kind !== 'empty') deadlines.push(this.room.expiresAt);
    for (const socket of this.ctx.getWebSockets()) {
      const attachment: unknown = socket.deserializeAttachment();
      if (isSocketAttachment(attachment) && attachment.kind === 'pending' && socket.readyState === WebSocket.OPEN) deadlines.push(attachment.expiresAt);
    }
    if (deadlines.length > 0) await this.ctx.storage.setAlarm(Math.min(...deadlines));
  }
}

export class PeerSignal extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/deliver' && request.method === 'POST') {
      const body = await request.text();
      const bodyBytes = new TextEncoder().encode(body).byteLength;
      if (bodyBytes > MAX_SIGNAL_BYTES) return new Response('too large', { status: 413 });
      const socket = this.ctx.getWebSockets().find((peer) => peer.readyState === WebSocket.OPEN && isPeerAttachment(peer.deserializeAttachment()));
      if (!socket) return new Response('peer unavailable', { status: 404 });
      if (socket.bufferedAmount + bodyBytes > MAX_PEER_BUFFER_BYTES) {
        socket.close(4429, 'peer is too slow');
        return new Response('peer is too slow', { status: 429 });
      }
      try { socket.send(body); } catch { return new Response('peer unavailable', { status: 404 }); }
      return new Response(null, { status: 204 });
    }
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
    const id = request.headers.get('X-CD-Peer-ID');
    if (!isPeerID(id)) return new Response('invalid peer id', { status: 400 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    if (this.ctx.getWebSockets().some((socket) => socket !== server && socket.readyState === WebSocket.OPEN)) {
      server.send(JSON.stringify({ type: 'ID-TAKEN' }));
      server.close(4409, 'peer id taken');
      return new Response(null, { status: 101, webSocket: client });
    }
    server.serializeAttachment({ id, peers: [], messages: 0 } satisfies PeerAttachment);
    server.send(JSON.stringify({ type: 'OPEN' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment: unknown = socket.deserializeAttachment();
    if (!isPeerAttachment(attachment) || typeof message !== 'string' || new TextEncoder().encode(message).byteLength > MAX_SIGNAL_BYTES) {
      socket.close(4400, 'invalid signal');
      return;
    }
    let value: unknown;
    try { value = JSON.parse(message); } catch { socket.close(4400, 'invalid signal'); return; }
    if (!value || typeof value !== 'object' || !('type' in value)) { socket.close(4400, 'invalid signal'); return; }
    if (value.type === 'HEARTBEAT') return;
    if (!['OFFER', 'ANSWER', 'CANDIDATE', 'LEAVE'].includes(String(value.type)) || !('dst' in value) || !isPeerID(value.dst)) {
      socket.close(4400, 'invalid signal');
      return;
    }
    attachment.messages += 1;
    if (attachment.messages > MAX_SIGNAL_MESSAGES) { socket.close(4429, 'signal limit reached'); return; }
    if (!attachment.peers.includes(value.dst)) attachment.peers = [...attachment.peers.slice(-7), value.dst];
    socket.serializeAttachment(attachment);
    const target = value.dst;
    try {
      const delivered = await this.env.PEERS.getByName(target).fetch('https://peer.internal/deliver', {
        method: 'POST', body: JSON.stringify({ ...value, src: attachment.id }),
      });
      if (!delivered.ok) socket.send(JSON.stringify({ type: 'EXPIRE', src: target }));
    } catch {
      socket.send(JSON.stringify({ type: 'EXPIRE', src: target }));
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    const attachment: unknown = socket.deserializeAttachment();
    if (!isPeerAttachment(attachment)) return;
    await Promise.all(attachment.peers.map(async (peer) => {
      try {
        await this.env.PEERS.getByName(peer).fetch('https://peer.internal/deliver', {
          method: 'POST', body: JSON.stringify({ type: 'LEAVE', src: attachment.id }),
        });
      } catch { /* Peer cleanup is best effort. */ }
    }));
  }

  async webSocketError(socket: WebSocket): Promise<void> { await this.webSocketClose(socket); }
}

// Short numeric share codes ("48291") map to a transfer capability
// (transfer ID + master key) so a 5-digit code typed anywhere — terminal or
// browser — resolves to the same relay room. Codes are random, expire after
// 15 minutes, and are released as soon as a receiver pairs with the room.
// Unlike full-link mode, the directory holds the master key, so short-code
// transfers are NOT end-to-end encrypted: TLS protects them in transit and
// the relay forwards (but never stores) the bytes. Sensitive files should use
// a full link instead.
//
// The directory is sharded by the code's first digit (ten Durable Objects,
// each with a SQLite table), so claims and lookups for different codes never
// queue behind one global object. Expired rows are purged with an indexed
// delete on claim and by an alarm, never by scanning every code.
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_DIGITS = 5;
const CODE_SPACE = 100_000;
const CODE_CLAIM_ATTEMPTS = 12;
// 1,000 live codes per shard keeps each shard's 10,000-code space at most
// 10% full, so random claims rarely collide. 10,000 live codes overall.
const MAX_CODES_PER_SHARD = 1_000;
const MAX_CODE_BODY_BYTES = 256;
const MAX_HELD_CODES = 16;
const PREFIX_LOOKUP_BURST = 12;
const PREFIX_LOOKUPS_PER_MINUTE = 12;
const SHARD_LOOKUP_BURST = 30;
const SHARD_LOOKUPS_PER_MINUTE = 60;

type CodeCapability = { transferId: string; key: string };
type CodeClaim = 'claimed' | 'taken' | 'full';

function isTransferId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

function isMasterKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isShareCode(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4,5}$/.test(value);
}

function codeShard(env: Env, code: string) {
  return env.CODES.getByName(`codes-v2-${code[0]}`);
}

// claimShareCode reserves a random code for a transfer, retrying across
// shards on collisions. Returns null when every attempt was taken or full.
async function claimShareCode(env: Env, capability: CodeCapability, expiresAt: number): Promise<{ code: string; expiresAt: number } | null> {
  for (let attempt = 0; attempt < CODE_CLAIM_ATTEMPTS; attempt += 1) {
    const digits = new Uint32Array(1);
    crypto.getRandomValues(digits);
    const code = String(digits[0] % CODE_SPACE).padStart(CODE_DIGITS, '0');
    if (await codeShard(env, code).claim(code, capability, expiresAt) === 'claimed') {
      logEvent('code_claimed', { code });
      return { code, expiresAt };
    }
  }
  logEvent('code_space_exhausted');
  return null;
}

function prefixGuard(env: Env, prefix: string) {
  return env.CODES.getByName(`code-prefix-v1-${prefix}`);
}

export class CodeDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS codes (
      code TEXT PRIMARY KEY,
      transfer_id TEXT NOT NULL,
      key TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS codes_by_expiry ON codes (expires_at)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS lookup_budget (id INTEGER PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS holds (lease_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS holds_by_expiry ON holds (expires_at)');
  }

  // Synchronous SQL keeps check/debit atomic even across concurrent RPCs.
  consumeLookup(scope: 'prefix' | 'shard'): boolean {
    const burst = scope === 'prefix' ? PREFIX_LOOKUP_BURST : SHARD_LOOKUP_BURST;
    const rate = scope === 'prefix' ? PREFIX_LOOKUPS_PER_MINUTE : SHARD_LOOKUPS_PER_MINUTE;
    const now = Date.now();
    const sql = this.ctx.storage.sql;
    const row = sql.exec<{ tokens: number; updated_at: number }>('SELECT tokens, updated_at FROM lookup_budget WHERE id = 1').toArray()[0];
    const tokens = row ? Math.min(burst, row.tokens + Math.max(0, now - row.updated_at) * rate / 60_000) : burst;
    if (tokens < 1) return false;
    sql.exec('INSERT OR REPLACE INTO lookup_budget VALUES (1, ?, ?)', tokens - 1, now);
    return true;
  }

  async hold(leaseId: string, expiresAt: number): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM holds WHERE expires_at <= ?', Date.now());
    if (sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM holds').one().count >= MAX_HELD_CODES) return false;
    sql.exec('INSERT INTO holds VALUES (?, ?)', leaseId, expiresAt);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || expiresAt < alarm) await this.ctx.storage.setAlarm(expiresAt);
    return true;
  }

  unhold(leaseId: string): void {
    this.ctx.storage.sql.exec('DELETE FROM holds WHERE lease_id = ?', leaseId);
  }

  // claim runs without awaits between its reads and writes, so the Durable
  // Object's input gate makes it atomic: two senders never own one code.
  async claim(code: string, capability: CodeCapability, expiresAt: number): Promise<CodeClaim> {
    if (!isShareCode(code) || !isTransferId(capability.transferId) || !isMasterKey(capability.key)) return 'taken';
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM codes WHERE expires_at <= ?', Date.now());
    if (sql.exec('SELECT 1 FROM codes WHERE code = ?', code).toArray().length > 0) return 'taken';
    const live = sql.exec<{ live: number }>('SELECT COUNT(*) AS live FROM codes').one().live;
    if (live >= MAX_CODES_PER_SHARD) {
      logEvent('code_directory_full', { codes: live });
      return 'full';
    }
    sql.exec('INSERT INTO codes (code, transfer_id, key, expires_at) VALUES (?, ?, ?, ?)', code, capability.transferId, capability.key, expiresAt);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || expiresAt < alarm) await this.ctx.storage.setAlarm(expiresAt);
    return 'claimed';
  }

  async lookup(code: string): Promise<CodeCapability | null> {
    const row = this.ctx.storage.sql.exec<{ transfer_id: string; key: string }>(
      'SELECT transfer_id, key FROM codes WHERE code = ? AND expires_at > ?', code, Date.now()
    ).toArray()[0];
    return row ? { transferId: row.transfer_id, key: row.key } : null;
  }

  // release frees a code once its room no longer needs it (paired or
  // finished). The transfer ID guard keeps a stale room from releasing a
  // code that was re-claimed after expiry.
  async release(code: string, transferId: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM codes WHERE code = ? AND transfer_id = ?', code, transferId);
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM codes WHERE expires_at <= ?', Date.now());
    sql.exec('DELETE FROM holds WHERE expires_at <= ?', Date.now());
    const next = sql.exec<{ next: number | null }>('SELECT MIN(expires_at) AS next FROM (SELECT expires_at FROM codes UNION ALL SELECT expires_at FROM holds)').one().next;
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if ((url.pathname.startsWith('/api/codes') || request.headers.get('Upgrade')?.toLowerCase() === 'websocket') && !sameOrigin(request)) {
      return new Response('origin forbidden', { status: 403 });
    }
    // Single host: cd.yash0.in serves P2P UI, relay (/ws/v1, /ws/v2, /api/codes),
    // and share pages (/send, /s/*) so every terminal<->browser combination
    // works from one origin.
    // design.yash0.in serves the design-docs list site from /design/.
    // Hash routing keeps every doc on one page, so extensionless paths
    // fall back to the design index.
    if (url.hostname === 'design.yash0.in') {
      if (url.pathname.startsWith('/ws/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/peerjs/')) {
        return new Response('not found', { status: 404 });
      }
      let assetPath = url.pathname.startsWith('/design/') ? url.pathname : `/design${url.pathname}`;
      if (assetPath.endsWith('/')) assetPath += 'index.html';
      else if (!assetPath.split('/').pop()?.includes('.')) assetPath = '/design/index.html';
      return env.ASSETS.fetch(new Request(new URL(assetPath, url.origin), request));
    }
    if (url.pathname === '/peerjs/peerjs') {
      const id = url.searchParams.get('id');
      if (!isPeerID(id) || url.searchParams.get('key') !== 'peerjs' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('invalid signaling request', { status: 400 });
      }
      try {
        const clientAddress = clientPrefix(request);
        const { success } = await env.PEER_RATE_LIMITER.limit({ key: clientAddress });
        if (!success) return new Response('connection rate limit reached', { status: 429 });
        const headers = new Headers(request.headers);
        headers.set('X-CD-Peer-ID', id);
        return await env.PEERS.getByName(id).fetch(new Request(request, { headers }));
      } catch {
        return new Response('signaling temporarily unavailable', { status: 503 });
      }
    }
    const pushMatch = /^\/api\/devices\/v1\/([A-Za-z0-9_-]{22})\/(push|push-target)$/.exec(url.pathname);
    if (pushMatch) {
      if (!['POST', 'DELETE'].includes(request.method) || (request.method === 'DELETE' && pushMatch[2] !== 'push-target')) {
        return new Response('method not allowed', { status: 405, headers: { Allow: pushMatch[2] === 'push' ? 'POST' : 'POST, DELETE' } });
      }
      try {
        const address = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const { success } = await env.PEER_RATE_LIMITER.limit({ key: `device-push:${address}` });
        if (!success) return Response.json({ error: 'rate limited' }, { status: 429 });
        return await env.DEVICES.getByName(pushMatch[1]).fetch(request);
      } catch {
        return Response.json({ error: 'device wake-up unavailable' }, { status: 503 });
      }
    }
    const deviceMatch = /^\/ws\/devices\/v1\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (deviceMatch) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
      const clientAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      const { success } = await env.CONNECTION_RATE_LIMITER.limit({ key: clientAddress });
      if (!success) return new Response('connection rate limit reached', { status: 429 });
      return env.DEVICES.getByName(deviceMatch[1]).fetch(request);
    }
    const match = /^\/ws\/v1\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (match) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
      try {
        const clientAddress = clientPrefix(request);
        const { success } = await env.CONNECTION_RATE_LIMITER.limit({ key: clientAddress });
        if (!success) return new Response('connection rate limit reached', { status: 429 });
        return await env.TRANSFERS.getByName(match[1]).fetch(request);
      } catch (error) {
        console.error(JSON.stringify({ event: 'relay_dispatch_failed', error: error instanceof Error ? error.message : 'unknown' }));
        return new Response('relay temporarily unavailable', { status: 503 });
      }
    }
    const resumeMatch = /^\/ws\/v2\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
    if (resumeMatch) {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('websocket required', { status: 426 });
      try {
        const clientAddress = request.headers.get('CF-Connecting-IP') ?? 'unknown';
        const { success } = await env.CONNECTION_RATE_LIMITER.limit({ key: clientAddress });
        if (!success) return new Response('connection rate limit reached', { status: 429 });
        return await env.TRANSFERS.getByName(`v2:${resumeMatch[1]}`).fetch(request);
      } catch (error) {
        console.error(JSON.stringify({ event: 'resume_relay_dispatch_failed', error: error instanceof Error ? error.message : 'unknown' }));
        return new Response('relay temporarily unavailable', { status: 503 });
      }
    }
    if (url.pathname.startsWith('/ws/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/peerjs/')) {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return Response.json(
          { service: 'cd-agent-sharing', protocol: 'cd-transfer-v1', status: 'ok' },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      }
      if (url.pathname === '/api/codes' && request.method === 'POST') {
        return codeResponse(await serveCodes(request, env, null));
      }
      const codeLookup = /^\/api\/codes\/(\d{4,5})$/.exec(url.pathname);
      if (codeLookup && request.method === 'GET') {
        return codeResponse(await serveCodes(request, env, codeLookup[1], url.hostname === 'cd.yash0.in'));
      }
      return new Response('not found', { status: 404 });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// Every probe, including legacy fallback and successful guesses, consumes
// durable prefix and shard budgets before touching either directory.
function codeResponse(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store');
  if (response.status === 429) response.headers.set('Retry-After', '5');
  return response;
}
async function serveCodes(request: Request, env: Env, code: string | null, legacyFallback = false): Promise<Response> {
  try {
    if (code === null && request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return new Response('application/json required', { status: 415 });
    }
    const clientAddress = clientPrefix(request);
    const { success } = await env.CONNECTION_RATE_LIMITER.limit({ key: clientAddress });
    if (!success) return new Response('connection rate limit reached', { status: 429 });
    if (code !== null) {
      if (!await prefixGuard(env, clientAddress).consumeLookup('prefix') || !await codeShard(env, code).consumeLookup('shard')) {
        return new Response('code lookup rate limit reached', { status: 429 });
      }
      const capability = await codeShard(env, code).lookup(code);
      if (!capability) {
        const legacy = legacyFallback ? await lookupLegacyCode(code) : null;
        if (!legacy) return new Response('code unavailable', { status: 404 });
        logEvent('code_resolved_legacy', { code });
        return Response.json({ ...legacy, origin: LEGACY_ORIGIN });
      }
      logEvent('code_resolved', { code });
      return Response.json(capability);
    }
    const bytes = await readCodeBody(request);
    if (bytes === null) return new Response('too large', { status: 413 });
    const text = new TextDecoder().decode(bytes);
    let body: unknown;
    try { body = JSON.parse(text); } catch { return new Response('invalid claim', { status: 400 }); }
    if (!body || typeof body !== 'object' || !('transferId' in body) || !('key' in body)
      || !isTransferId(body.transferId) || !isMasterKey(body.key)) {
      return new Response('invalid claim', { status: 400 });
    }
    const result = await env.TRANSFERS.getByName(body.transferId).claimCode({ transferId: body.transferId, key: body.key });
    if (result.kind === 'denied') return new Response('admitted sender proof required', { status: 403 });
    if (result.kind === 'busy') return new Response('share codes are busy right now', { status: 429 });
    return Response.json(result.claim);
  } catch (error) {
    console.error(JSON.stringify({ event: 'code_directory_failed', error: error instanceof Error ? error.message : 'unknown' }));
    return new Response('share codes temporarily unavailable', { status: 503 });
  }
}

async function readCodeBody(request: Request): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_CODE_BODY_BYTES);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return bytes.subarray(0, length);
      if (length + chunk.value.byteLength > bytes.byteLength) {
        await reader.cancel();
        return null;
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } finally { reader.releaseLock(); }
}

// cdx v0.1.0 (still the latest published release) registers its codes on
// the old cdx.yash0.in Worker, so a code typed on cd.yash0.in would miss.
// Resolve misses there too; the receiver then opens that host's share page,
// where the sender's relay room lives.
const LEGACY_ORIGIN = 'https://cdx.yash0.in';

async function lookupLegacyCode(code: string): Promise<{ transferId: string; key: string } | null> {
  try {
    const response = await fetch(`${LEGACY_ORIGIN}/api/codes/${code}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!body || typeof body !== 'object' || !('transferId' in body) || !('key' in body)
      || !isTransferId(body.transferId) || !isMasterKey(body.key)) return null;
    return { transferId: body.transferId, key: body.key };
  } catch {
    return null;
  }
}
