// Self-contained so Playwright can run the same diagnostic function in a page.
export async function echoWebSocket({ payload = globalThis.payload, url = globalThis.location.origin.replace('http', 'ws') + '/echo', timeoutMs = 60_000, WebSocketImpl = globalThis.WebSocket }) {
  const socket = new WebSocketImpl(url);
  socket.binaryType = 'arraybuffer';
  const received = new Uint8Array(payload.byteLength);
  let offset = 0;
  let failure;
  let open;
  let rejectOpen;
  const opened = new Promise((resolve, reject) => { open = resolve; rejectOpen = reject; });
  let complete;
  let rejectComplete;
  const completed = new Promise((resolve, reject) => { complete = resolve; rejectComplete = reject; });
  // Completion can fail while the send loop is still waiting for buffer room.
  void completed.catch(() => {});
  const fail = (error) => { failure ??= error; rejectOpen(failure); rejectComplete(failure); };
  const timer = setTimeout(() => fail(new Error('echo timed out')), timeoutMs);
  socket.onopen = open;
  socket.onerror = () => fail(new Error('echo failed'));
  socket.onclose = () => { if (offset !== received.length) fail(new Error('echo closed')); };
  socket.onmessage = ({ data }) => {
    const bytes = new Uint8Array(data);
    if (offset + bytes.length > received.length) { fail(new Error('echo overflow')); return; }
    received.set(bytes, offset);
    offset += bytes.length;
    if (offset === received.length) complete();
  };
  try {
    await opened;
    const start = performance.now();
    for (let at = 0; at < payload.length; at += 262144) {
      const bytes = payload.subarray(at, at + 262144);
      while (socket.bufferedAmount + bytes.byteLength > 4 * 1048576) {
        if (failure) throw failure;
        if (socket.readyState !== 1) throw new Error('echo closed');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (failure) throw failure;
      if (socket.readyState !== 1) throw new Error('echo closed');
      socket.send(bytes);
    }
    await completed;
    const ms = performance.now() - start;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', received))].map(n => n.toString(16).padStart(2, '0')).join('');
    return { ms, hash, bytes: received.byteLength };
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}
