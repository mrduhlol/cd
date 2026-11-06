// Reproducible diagnosis, not a production-speed prediction.
// npm run build
// node scripts/perf-audit.mjs > /tmp/cd-perf-audit.json
// CD_PERF_ONLY=network|browser selects one suite. CD_PERF_RUNS defaults to 3.
// CD_PERF_WORK_ROOT selects the filesystem for CLI payloads and checkpoints.
// CD_PERF_DELAYS selects per-hop delays in ms, default 0,25,75.
// CD_PERF_BROWSER_MODES can select the storage-only experiments.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, loadavg, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildCLI, captureOutput, childExit, cliEnv, findChromium, firstLine, startWorker, stopChild } from './harness.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runs = Number(process.env.CD_PERF_RUNS ?? 3);
assert.ok(Number.isSafeInteger(runs) && runs > 0);
assert.ok(!process.env.CD_VERIFY_URL, 'This audit uses local infrastructure only');
const only = process.env.CD_PERF_ONLY ?? 'all';
assert.ok(['all', 'network', 'browser'].includes(only));
const delays = (process.env.CD_PERF_DELAYS ?? '0,25,75').split(',').map(Number);
for (const delay of delays) assert.ok(Number.isFinite(delay) && delay >= 0 && delay <= 1000);
const browserModes = (process.env.CD_PERF_BROWSER_MODES ?? 'incremental-sha256,native-sha256,crc32,record-seal-open,opfs-stream,resume-stage').split(',');
for (const mode of browserModes) assert.ok(['incremental-sha256', 'native-sha256', 'crc32', 'record-seal-open', 'opfs-stream', 'resume-stage', 'opfs-reopen', 'opfs-sync-worker'].includes(mode));
const work = await mkdtemp(join(process.env.CD_PERF_WORK_ROOT ?? tmpdir(), 'cd-perf-'));
const results = { timestamp: new Date().toISOString(), cpu: cpus()[0]?.model, node: process.version, runs, workFilesystemPath: work, loadAverageBefore: loadavg(), trials: [] };
const sha = data => createHash('sha256').update(data).digest('hex');
try {
  if (only !== 'browser') await network();
  if (only !== 'network') await browser();
} catch (error) {
  results.error = error.stack ?? String(error);
  process.exitCode = 1;
} finally {
  await rm(work, { recursive: true, force: true });
  results.loadAverageAfter = loadavg();
  console.log(JSON.stringify(results, null, 2));
}

async function network() {
  // ws is an existing Wrangler/Miniflare dependency. Resolve from its owner.
  const wranglerRequire = createRequire(import.meta.resolve('wrangler'));
  const miniflareRequire = createRequire(wranglerRequire.resolve('miniflare'));
  const { WebSocket, WebSocketServer } = miniflareRequire('ws');
  const executable = await buildCLI(work);
  let worker;
  const payload = randomBytes(8 * 1024 * 1024);
  const source = join(work, 'payload.bin');
  await writeFile(source, payload);
  try {
    for (const delayMs of delays) {
      // Separate local Worker instances keep this suite below each instance's
      // admission limit. Never disable production rate limiting to benchmark.
      const workerDirectory = join(work, `worker-${delayMs}`);
      await mkdir(workerDirectory);
      worker = await startWorker(workerDirectory);
      // Every complete WS message is delayed independently in both directions
      // of both client connections, without serializing a streaming sender.
      // Four hops make the added payload/ACK round trip 4 * delayMs.
      const server = createServer();
      const wss = new WebSocketServer({ server });
      const sockets = new Set();
      const timers = new Set();
      wss.on('connection', (client, request) => {
        const upstream = new WebSocket(worker.publicBase.replace(/^http/, 'ws') + request.url);
        sockets.add(client); sockets.add(upstream);
        const pending = [];
        function forward(target, data, binary) {
          if (!delayMs) { if (target.readyState === WebSocket.OPEN) target.send(data, { binary }); return; }
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (target.readyState === WebSocket.OPEN) target.send(data, { binary });
          }, delayMs);
          timers.add(timer);
        }
        upstream.on('open', () => { for (const args of pending) forward(upstream, ...args); pending.length = 0; });
        client.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.CONNECTING) pending.push([data, binary]);
          else forward(upstream, data, binary);
        });
        upstream.on('message', (data, binary) => forward(client, data, binary));
        // Keep close behind already scheduled messages, especially COMPLETE.
        function closeAfterMessages(target) {
          const timer = setTimeout(() => { timers.delete(timer); target.close(); }, delayMs + 1);
          timers.add(timer);
        }
        client.on('close', () => closeAfterMessages(upstream));
        upstream.on('close', () => closeAfterMessages(client));
        client.on('error', () => upstream.terminate());
        upstream.on('error', () => client.terminate());
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        for (let run = 0; run < runs; run++) for (const mode of ['v1', 'v2']) {
          const env = cliEnv(worker, { CD_RELAY_URL: `ws://127.0.0.1:${server.address().port}/ws/v1`, CD_PUBLIC_URL: `http://127.0.0.1:${server.address().port}`, CD_DIRECT: '0', CD_TRANSPORT_REPORT: '1', CD_STATE_DIR: join(work, `state-${delayMs}-${run}-${mode}`) });
          const out = join(work, `out-${delayMs}-${run}-${mode}`);
          await mkdir(out);
          let sender, receiver;
          const trial = { suite: 'network', mode, run, payloadMiB: 8, addedAckRTTMs: delayMs * 4, completed: false };
          try {
            const start = performance.now();
            sender = spawn(executable, ['send', '--json', ...(mode === 'v2' ? ['--resumable'] : ['--wait', '--link']), source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
            const senderOutput = captureOutput(sender);
            const senderExit = childExit(sender, 120000); senderExit.catch(() => {});
            const ready = JSON.parse(await firstLine(sender.stdout, 20000));
            assert.ok(typeof ready.url === 'string', `sender not ready: ${JSON.stringify(ready)}`);
            trial.readinessMs = performance.now() - start;
            const transferStart = performance.now();
            receiver = spawn(executable, ['receive', '--json', ready.url, '--out', out], { env, stdio: ['ignore', 'pipe', 'pipe'] });
            const receiverOutput = captureOutput(receiver);
            assert.equal(await childExit(receiver, 120000), 0, receiverOutput.stderr);
            await receiverOutput.finished;
            trial.seconds = (performance.now() - transferStart) / 1000;
            assert.equal(await senderExit, 0, senderOutput.stderr);
            await senderOutput.finished;
            assert.equal(sha(await readFile(join(out, 'payload.bin'))), sha(payload));
            trial.mibPerSecond = 8 / trial.seconds;
            trial.completed = true;
            if (mode === 'v1') {
              trial.transport = (senderOutput.stderr + receiverOutput.stderr).split('\n').flatMap(line => { try { const v = JSON.parse(line); return v.transport ? [v] : []; } catch { return []; } });
              assert.ok(trial.transport.some(v => v.relayBytes >= payload.length));
              assert.ok(trial.transport.every(v => v.directBytes === 0));
            }
          } catch (error) { trial.completed = false; trial.error = error.message; process.exitCode = 1; }
          finally { await stopChild(receiver); await stopChild(sender); }
          results.trials.push(trial);
          console.error(JSON.stringify(trial));
        }
      } finally {
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.terminate();
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
        await worker.stop();
        worker = null;
      }
    }
  } finally { await worker?.stop(); }
}

async function browser() {
  // Serve the actual source modules; no generated copies of the algorithms.
  const server = createServer(async (request, response) => {
    if (request.url === '/') { response.end('<!doctype html><title>Local performance audit</title>'); return; }
    if (!/^\/src\/[a-z0-9-]+\.js$/.test(request.url)) { response.writeHead(404).end(); return; }
    try { response.setHeader('Content-Type', 'text/javascript'); response.end(await readFile(join(repo, 'src', basename(request.url)))); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let instance;
  try {
    instance = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
    results.chromium = instance.version();
    const page = await instance.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (const throttle of [1, 4]) {
      const session = await page.context().newCDPSession(page);
      await session.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      const trials = await page.evaluate(async ({ runs, throttle, browserModes }) => {
        const { IncrementalSHA256 } = await import('/src/incremental-sha256.js');
        const { createOPFSSink } = await import('/src/sink.js');
        const { createReceiverStage, openResumeDatabase, createResumeKV } = await import('/src/resume-browser.js');
        const { createSealer, createOpener, SENDER_DIRECTION, KIND_CHUNK, encodeBase64Url } = await import('/src/agent-protocol.js');
        const { crc32 } = await import('/src/zip-bundle.js');
        const db = await openResumeDatabase();
        const stores = { checkpoints: createResumeKV(db, 'checkpoints'), secrets: createResumeKV(db, 'secrets') };
        const chunk = new Uint8Array(256 * 1024);
        for (let at = 0; at < chunk.length; at += 65536) crypto.getRandomValues(chunk.subarray(at, at + 65536));
        const data = new Uint8Array(16 * 1024 * 1024);
        for (let at = 0; at < data.length; at += chunk.length) data.set(chunk, at);
        const hex = bytes => [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
        const expected = hex(await crypto.subtle.digest('SHA-256', data));
        const expectedCRC = crc32(data);
        const invitation = { id: crypto.getRandomValues(new Uint8Array(16)), key: crypto.getRandomValues(new Uint8Array(32)) };
        const trials = [];
        // Warm JIT before the recorded runs.
        new IncrementalSHA256().update(chunk).digestHex(); crc32(chunk);
        for (let run = 0; run < runs; run++) {
          for (const mode of browserModes) {
            const sealer = await createSealer(invitation, SENDER_DIRECTION);
            const opener = await createOpener(invitation, SENDER_DIRECTION);
            const start = performance.now();
            if (mode === 'incremental-sha256') {
              const hash = new IncrementalSHA256();
              for (let at = 0; at < data.length; at += chunk.length) hash.update(data.subarray(at, at + chunk.length));
              if (hash.digestHex() !== expected) throw new Error('incremental SHA mismatch');
            } else if (mode === 'native-sha256') {
              if (hex(await crypto.subtle.digest('SHA-256', data)) !== expected) throw new Error('native SHA mismatch');
            } else if (mode === 'crc32') {
              let crc = 0;
              for (let at = 0; at < data.length; at += chunk.length) crc = crc32(data.subarray(at, at + chunk.length), crc);
              if (crc !== expectedCRC) throw new Error('CRC mismatch');
            } else if (mode === 'record-seal-open') {
              for (let at = 0; at < data.length; at += chunk.length) {
                const plain = data.subarray(at, at + chunk.length);
                const opened = await opener.open(await sealer.seal(KIND_CHUNK, plain));
                if (opened.plaintext.length !== plain.length || opened.plaintext.some((v, i) => v !== plain[i])) throw new Error('record mismatch');
              }
            } else if (mode === 'opfs-stream') {
              const sink = await createOPFSSink({ name: 'perf.bin' });
              for (let at = 0; at < data.length; at += chunk.length) await sink.write(data.subarray(at, at + chunk.length));
              const file = await sink.file();
              if (hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) !== expected) throw new Error('OPFS mismatch');
              await sink.cleanup();
            } else if (mode === 'opfs-reopen') {
              const directory = await navigator.storage.getDirectory();
              const name = `perf-${crypto.randomUUID()}`;
              const handle = await directory.getFileHandle(name, { create: true });
              const quarters = [];
              let mark = performance.now();
              try {
                for (let at = 0; at < data.length; at += chunk.length) {
                  const writer = await handle.createWritable({ keepExistingData: true });
                  await writer.seek(at);
                  await writer.write(data.subarray(at, at + chunk.length));
                  await writer.close();
                  if ((at + chunk.length) % (4 * 1024 * 1024) === 0) { quarters.push(performance.now() - mark); mark = performance.now(); }
                }
                const file = await handle.getFile();
                if (hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) !== expected) throw new Error('reopened OPFS mismatch');
              } finally { await directory.removeEntry(name); }
              trials.push({ suite: 'browser-detail', mode, run, throttle, quarterMiB: 4, quarterMs: quarters });
            } else if (mode === 'opfs-sync-worker') {
              // Storage-only experiment, not a replacement resume protocol.
              // Flush every chunk, verify the complete file, then remove it.
              const code = `onmessage = async ({ data }) => {
                let handle, directory, name;
                try {
                  directory = await navigator.storage.getDirectory();
                  name = 'perf-' + crypto.randomUUID();
                  const file = await directory.getFileHandle(name, { create: true });
                  handle = await file.createSyncAccessHandle();
                  for (let at = 0; at < data.bytes.length; at += data.chunkSize) {
                    const part = data.bytes.subarray(at, at + data.chunkSize);
                    if (handle.write(part, { at }) !== part.length) throw new Error('short write');
                    handle.flush();
                  }
                  handle.close(); handle = null;
                  const bytes = await (await file.getFile()).arrayBuffer();
                  const digest = await crypto.subtle.digest('SHA-256', bytes);
                  await directory.removeEntry(name); name = null;
                  postMessage({ digest: [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('') });
                } catch (error) { postMessage({ error: error.message }); }
                finally { handle?.close(); if (name) await directory.removeEntry(name); }
              };`;
              const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
              const worker = new Worker(url);
              try {
                const result = await new Promise((resolve, reject) => {
                  worker.onmessage = event => resolve(event.data);
                  worker.onerror = event => reject(new Error(event.message));
                  worker.postMessage({ bytes: data, chunkSize: chunk.length });
                });
                if (result.error) throw new Error(result.error);
                if (result.digest !== expected) throw new Error('sync OPFS mismatch');
              } finally { worker.terminate(); URL.revokeObjectURL(url); }
            } else {
              const rootId = encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
              const stage = await createReceiverStage({ invitation, rootId, offer: { name: 'perf.bin', size: String(data.length), chunkSize: chunk.length, wholeSha256: expected, expiresAt: Date.now() + 3600000 }, ...stores });
              const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
              const quarters = [];
              let mark = performance.now();
              try {
                for (let at = 0; at < data.length; at += chunk.length) {
                  await stage.append(data.subarray(at, at + chunk.length), nonce);
                  if ((at + chunk.length) % (4 * 1024 * 1024) === 0) { quarters.push(performance.now() - mark); mark = performance.now(); }
                }
                const file = await stage.finish();
                if (hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())) !== expected) throw new Error('resume stage mismatch');
              } finally { await stage.cancel(); }
              trials.push({ suite: 'browser-detail', mode, run, throttle, quarterMiB: 4, quarterMs: quarters });
            }
            const seconds = (performance.now() - start) / 1000;
            trials.push({ suite: 'browser', mode, run, throttle, payloadMiB: 16, seconds, mibPerSecond: 16 / seconds, completed: true });
          }
        }
        db.close();
        return trials;
      }, { runs, throttle, browserModes });
      results.trials.push(...trials);
      for (const trial of trials) console.error(JSON.stringify(trial));
      await session.detach();
    }
  } finally {
    await instance?.close();
    await new Promise(resolve => server.close(resolve));
  }
}
