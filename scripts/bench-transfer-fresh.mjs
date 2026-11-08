// Fresh end-to-end browser measurement. No historical benchmark results are inputs.
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir, hostname, cpus, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { findChromium, startWorker } from './harness.mjs';

const mib = Number(process.env.CD_FRESH_MIB ?? 600);
const runs = Number(process.env.CD_FRESH_RUNS ?? 3);
const timeout = Number(process.env.CD_FRESH_TIMEOUT_MS ?? 300_000);
const routes = (process.env.CD_FRESH_ROUTES ?? 'auto,relay').split(',');
const output = resolve(process.env.CD_FRESH_OUTPUT ?? '/tmp/cd-transfer-fresh.json');
assert.ok(Number.isSafeInteger(mib) && mib > 0);
assert.ok(Number.isSafeInteger(runs) && runs > 0);
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
assert.ok(routes.length > 0 && routes.every(route => ['auto', 'relay'].includes(route)));
const work = await mkdtemp(join(tmpdir(), 'cd-fresh-'));
const report = {
  schema: 1, startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  host: hostname(), cpu: cpus()[0]?.model, load: loadavg(), mib, runs,
  topology: process.env.CD_VERIFY_URL ? 'two Chromium processes on one Linux host, hosted relay' : 'two Chromium processes and local Worker on one Linux host',
  method: 'Independent random bytes per MiB. Timer starts before receive code entry and ends after download.saveAs. Full output SHA-256 and size verified outside timing. OS page cache allowed; no fsync durability claim. Auto route must disclose actual WebRTC and relay payload bytes. This is not a physical-phone or WAN benchmark.',
  rows: []
};
async function digest(path) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}
// This probe only observes actual sends. It never adds delays or changes payloads.
function probe({ relayOnly }) {
  window.__fresh = { relay: 0, direct: 0, firstAt: null, lastAt: null, maxGapMs: 0, records: 0, peers: [], sockets: [] };
  const stat = window.__fresh;
  window.__CD_TRANSFER_TEST_OBSERVER__ = snapshot => {
    if (snapshot.window) stat.window = { size: snapshot.window.size, inFlight: snapshot.window.inFlight, minRTT: snapshot.window.minRTT, acknowledged: String(snapshot.window.acknowledged) };
  };
  function sent(bytes, route) {
    if (!bytes) return;
    const now = performance.now();
    if (stat.lastAt !== null) stat.maxGapMs = Math.max(stat.maxGapMs, now - stat.lastAt);
    stat.firstAt ??= now; stat.lastAt = now;
    stat[route] += bytes; stat.records++;
  }
  const NativeSocket = WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      const socket = { path: new URL(this.url).pathname.replace(/\/[A-Za-z0-9_-]{22}$/, '/<id>'), received: 0, maxGapMs: 0, lastAt: null };
      stat.sockets.push(socket);
      this.addEventListener('message', event => {
        const now = performance.now();
        if (socket.lastAt !== null) socket.maxGapMs = Math.max(socket.maxGapMs, now - socket.lastAt);
        socket.lastAt = now;
        if (typeof event.data !== 'string') socket.received += event.data.byteLength ?? event.data.size ?? 0;
      });
      this.addEventListener('close', event => { socket.closeCode = event.code; });
    }
  };
  const NativePeer = RTCPeerConnection;
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args); const peer = { states: [], candidateTypes: [] }; stat.peers.push(peer);
      this.addEventListener('connectionstatechange', () => peer.states.push(this.connectionState));
      this.addEventListener('icecandidate', event => { if (event.candidate) peer.candidateTypes.push(event.candidate.type); });
    }
  };
  const socketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    const result = socketSend.call(this, data);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (bytes && bytes.length >= 12 && bytes[0] === 0x43 && bytes[1] === 0x44 && bytes[3] === 2) sent(new DataView(bytes.buffer, bytes.byteOffset).getUint32(8), 'relay');
    return result;
  };
  const channelSend = RTCDataChannel.prototype.send;
  const states = new WeakMap();
  RTCDataChannel.prototype.send = function(data) {
    const result = channelSend.call(this, data);
    if (this.label !== 'cd-direct') return result;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) return result;
    let state = states.get(this);
    if (!state) { state = { header: [], remaining: 0, payload: 0 }; states.set(this, state); }
    let cursor = 0;
    while (cursor < bytes.length) {
      if (!state.remaining) {
        while (state.header.length < 12 && cursor < bytes.length) state.header.push(bytes[cursor++]);
        if (state.header.length < 12) break;
        assertHeader(state.header);
        const length = new DataView(Uint8Array.from(state.header).buffer).getUint32(8);
        state.remaining = length + 16; state.payload = state.header[3] === 2 ? length : 0; state.header = [];
      }
      const take = Math.min(state.remaining, bytes.length - cursor);
      cursor += take; state.remaining -= take;
      if (!state.remaining) sent(state.payload, 'direct');
    }
    return result;
  };
  function assertHeader(header) { if (header[0] !== 0x43 || header[1] !== 0x44 || header[2] !== 1) throw new Error('unexpected direct record'); }
  if (relayOnly) window.RTCPeerConnection = class { constructor() { throw new Error('fresh benchmark forced relay'); } };
}
function workerOrigin() { return new URL(process.env.CD_VERIFY_URL).origin; }
let worker;
const browsers = [];
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.interrupted = signal;
  void Promise.allSettled(browsers.map(browser => browser.close()));
});
try {
  const input = join(work, 'payload.bin');
  const file = await open(input, 'w');
  try { for (let index = 0; index < mib; index++) await file.writeFile(randomBytes(1048576)); }
  finally { await file.close(); }
  const expected = await digest(input);
  report.input = expected;
  report.localSource = {};
  for (const path of ['worker/index.ts', 'src/relay-sender.js', 'src/share.js', 'src/sink.js', 'src/send-window.js', 'dist/index.html']) {
    report.localSource[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  if (process.env.CD_VERIFY_URL) {
    report.hostedAssets = {};
    const response = await fetch(workerOrigin(), { signal: AbortSignal.timeout(15000) });
    const html = await response.text();
    for (const path of html.match(/\/assets\/[^" ]+\.js/g) ?? []) {
      const response = await fetch(new URL(path, workerOrigin()), { signal: AbortSignal.timeout(15000) });
      assert.equal(response.status, 200);
      report.hostedAssets[path] = createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex');
    }
  }
  report.dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  report.runtimeOverride = process.env.MINIFLARE_WORKERD_PATH ? execFileSync(process.env.MINIFLARE_WORKERD_PATH, ['--version'], { encoding: 'utf8' }).trim() : null;
  worker = await startWorker(work);
  for (let index = 0; index < 2; index++) browsers.push(await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] }));
  report.chromium = browsers.map(browser => browser.version());
  for (let run = 0; run < runs; run++) for (const route of run % 2 ? [...routes].reverse() : routes) {
    if (report.interrupted) throw new Error(`Benchmark interrupted by ${report.interrupted}`);
    const row = { run, route, ok: false };
    const contexts = [];
    let sender, receiver;
    try {
      for (const browser of browsers) {
        const context = await browser.newContext({ acceptDownloads: true }); contexts.push(context);
        await context.addInitScript(probe, { relayOnly: route === 'relay' });
      }
      sender = await contexts[0].newPage(); receiver = await contexts[1].newPage();
      for (const page of [sender, receiver]) { page.setDefaultTimeout(timeout); await page.goto(worker.publicBase); await page.locator('.workbench:not([inert])').waitFor(); }
      await receiver.locator('#receive-mode-btn').click();
      const ready = performance.now();
      await sender.locator('#file-input').setInputFiles(input);
      await sender.locator('#sender-code-section:not(.hidden)').waitFor();
      const code = (await sender.locator('#share-code').textContent()).trim(); assert.match(code, /^\d{4,5}$/);
      row.readyMs = performance.now() - ready;
      row.assets = await sender.locator('script[src]').evaluateAll(elements => elements.map(element => new URL(element.src).pathname));
      const start = performance.now();
      const [download] = await Promise.all([
        receiver.waitForEvent('download', { timeout }),
        receiver.locator('#code-input').fill(code)
      ]);
      row.downloadEventMs = performance.now() - start;
      const target = join(work, 'received.bin'); await download.saveAs(target);
      row.receiveMs = performance.now() - start;
      await sender.locator('#sender-complete:not(.hidden)').waitFor();
      row.senderCompleteMs = performance.now() - start;
      row.received = await digest(target); assert.deepEqual(row.received, expected);
      row.transport = await sender.evaluate(() => window.__fresh);
      assert.ok(row.transport.relay + row.transport.direct >= expected.bytes, 'missing payload transport evidence');
      if (route === 'relay') { assert.equal(row.transport.direct, 0); assert.equal(row.transport.relay, expected.bytes); }
      row.mibPerSecond = mib / (row.receiveMs / 1000);
      row.ok = true; await rm(target);
    } catch (error) {
      row.error = error.message;
      row.receiverTransport = await receiver?.evaluate(() => window.__fresh).catch(() => null);
      row.senderState = await sender?.locator('#app-state').textContent().catch(() => null);
      row.senderStatus = await sender?.locator('#sender-status').textContent().catch(() => null);
      row.transport = await sender?.evaluate(() => window.__fresh).catch(() => null);
    } finally { for (const context of contexts) await context.close(); }
    report.rows.push(row); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(row));
  }
} catch (error) { report.error = error.message; }
finally {
  for (const browser of browsers) await browser.close();
  await worker?.stop(); await rm(work, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (report.error || report.rows.length !== runs * routes.length || report.rows.some(row => !row.ok)) process.exitCode = 1;
console.log(JSON.stringify({ output, error: report.error, passed: report.rows.filter(row => row.ok).length }));
