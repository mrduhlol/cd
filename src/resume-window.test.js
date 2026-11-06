import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Socket, RESUME_CHUNK_SIZE } from './resume-browser.js';
const RECORD_BYTES = RESUME_CHUNK_SIZE + 12 + 16;
const MAX_RECORDS = (4 * 1024 * 1024) / RESUME_CHUNK_SIZE;
class FakeSocket extends EventTarget {
  readyState = 0;
  closes = [];
  constructor() {
    super();
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); });
  }
  send() {}
  close(code, reason) {
    this.closes.push({ code, reason });
    this.readyState = 3;
    const event = new Event('close');
    Object.defineProperty(event, 'code', { value: code });
    this.dispatchEvent(event);
  }
  receive(size) { this.dispatchEvent(new MessageEvent('message', { data: new ArrayBuffer(size) })); }
}
async function connection() {
  return createV2Socket({ id: new Uint8Array(16), key: new Uint8Array(32) }, 'receiver', null, {
    WebSocketCtor: FakeSocket, location: { protocol: 'http:', host: '127.0.0.1' }
  });
}
test('the legal Go 4MiB plaintext window fits including authenticated frame overhead', async () => {
  const { socket, inbox } = await connection();
  for (let index = 0; index < MAX_RECORDS; index++) socket.receive(RECORD_BYTES);
  assert.deepEqual(socket.closes, [], 'a legal 4,194,752-byte ciphertext burst must not close the receiver');
  let total = 0;
  for (let index = 0; index < MAX_RECORDS; index++) total += (await inbox.next()).data.byteLength;
  assert.equal(total, 4 * 1024 * 1024 + MAX_RECORDS * 28);
});
test('a seventeenth queued full record still rejects rather than growing without bound', async () => {
  const { socket } = await connection();
  for (let index = 0; index < MAX_RECORDS; index++) socket.receive(RECORD_BYTES);
  assert.deepEqual(socket.closes, []);
  socket.receive(RECORD_BYTES);
  assert.equal(socket.closes[0]?.code, 4429);
});
test('a record beyond the bounded receive-byte budget is rejected', async () => {
  const { socket } = await connection();
  for (let index = 0; index < MAX_RECORDS - 1; index++) socket.receive(RECORD_BYTES);
  assert.deepEqual(socket.closes, []);
  socket.receive(4 * 1024 * 1024 + 64 * 1024 - (MAX_RECORDS - 1) * RECORD_BYTES + 1);
  assert.equal(socket.closes[0]?.code, 4429);
});
