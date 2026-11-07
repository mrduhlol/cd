import assert from 'node:assert/strict';
import { test } from 'node:test';
import { echoWebSocket } from './websocket-echo.mjs';

for (const disconnect of [false, true]) {
  test(`a ${disconnect ? 'closed' : 'stalled'} echo socket settles and closes while its buffer stays full`, { timeout: 1000 }, async () => {
    let closed = 0;
    class Socket {
      readyState = 1;
      bufferedAmount = 4 * 1048576;
      constructor() {
        queueMicrotask(() => {
          this.onopen();
          if (disconnect) { this.readyState = 3; this.onclose(); }
        });
      }
      send() { assert.fail('full socket must not send'); }
      close() { closed += 1; }
    }
    await assert.rejects(echoWebSocket({ payload: new Uint8Array(1), url: 'ws://localhost/echo', timeoutMs: 25, WebSocketImpl: Socket }), disconnect ? /echo closed/ : /echo timed out/);
    assert.equal(closed, 1);
  });
}
