import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import QRCode from 'qrcode';
import { frameMetadata, numericProgress, safeRoute, sanitizeDiagnostic, settle } from './v2-browser-diagnostics.mjs';
import { childExit, cliEnv, firstLine, startWorker, stopChild, findChromium } from './harness.mjs';

assert.ok(process.env.CD_V2_VERIFY_CLI, 'Set CD_V2_VERIFY_CLI to a verified v2-capable cdx binary');
if (process.env.CD_VERIFY_URL) assert.equal(new URL(process.env.CD_VERIFY_URL).protocol, 'https:', 'Hosted verification requires HTTPS');
const work = await mkdtemp(join(tmpdir(), 'cd-v2-browser-'));
const children = [];
const browsers = [];
const measurements = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let worker;
try {
  worker = await startWorker(work);
  const health = await (await fetch(`${worker.publicBase}/api/health`)).json();
  assert.ok(health.protocols?.includes('cd-transfer-v2'), 'target must advertise private v2 support');
  const env = cliEnv(worker, { CD_STATE_DIR: join(work, 'state') });
  const executablePath = await findChromium();
  const launch = async (args = []) => {
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', ...args] });
    browsers.push(browser);
    return browser;
  };
  const browser = await launch();
  async function sender(source, root) {
    const child = spawn(process.env.CD_V2_VERIFY_CLI, ['send', ...(root ? ['--resume', root] : ['--resumable']), '--json', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    let ready;
    try { ready = JSON.parse(await firstLine(child.stdout, 15000)); }
    catch (error) {
      throw new Error(`Sender did not become ready: ${sanitizeDiagnostic(error.message)}; exit=${child.exitCode}, signal=${child.signalCode}; stderr=${sanitizeDiagnostic(stderr)}`);
    }
    assert.equal(ready.version, 2);
    assert.match(ready.url, /#v2\./);
    return { child, ready, get stderr() { return stderr; } };
  }
  async function receive(page, url, open, senderState, mode) {
    const requests = [];
    const joins = [];
    const diagnostics = [];
    const receiveStarted = performance.now();
    const record = (type, value) => {
      diagnostics.push({ ms: Math.round(performance.now() - receiveStarted), type, detail: sanitizeDiagnostic(value) });
      if (diagnostics.length > 64) diagnostics.shift();
    };
    page.on('pageerror', error => record('pageerror', error.message));
    page.on('close', () => record('page-close', 'page closed'));
    page.on('requestfailed', request => record('requestfailed', `${safeRoute(request.url())}: ${request.failure()?.errorText ?? 'unknown'}`));
    page.on('response', response => { if (response.status() >= 400) record('http', `${response.status()} ${safeRoute(response.url())}`); });
    // Passive browser-protocol observation only: no application globals or
    // WebSocket implementation changes. Only allowlisted public header/control
    // metadata is recorded, never data-frame payloads or private join fields.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    cdp.on('Network.webSocketHandshakeResponseReceived', event => record('ws-handshake', `HTTP ${event.response.status}`));
    cdp.on('Network.webSocketFrameError', event => record('ws-error', event.errorMessage));
    cdp.on('Network.webSocketFrameSent', event => {
      if ([1, 2].includes(event.response.opcode)) record('ws-sent', JSON.stringify(frameMetadata(event.response.opcode, event.response.payloadData)));
    });
    cdp.on('Network.webSocketFrameReceived', event => {
      if ([1, 2].includes(event.response.opcode)) record('ws-received', JSON.stringify(frameMetadata(event.response.opcode, event.response.payloadData)));
      if (event.response.opcode !== 8) return;
      const bytes = Buffer.from(event.response.payloadData, 'base64');
      record('ws-close-frame', bytes.length >= 2 ? `code=${bytes.readUInt16BE(0)}` : 'empty close frame');
    });
    cdp.on('Network.webSocketClosed', () => record('ws-close', 'socket closed; close code may be unavailable'));
    page.on('request', request => requests.push(request.url()));
    page.on('websocket', socket => socket.on('framesent', frame => { if (typeof frame.payload === 'string') joins.push(frame.payload); }));
    // Diagnostic wait exceeds both clients' 90 s record deadline, allowing an
    // actual protocol timeout to surface. Completion/byte/security checks stay.
    const downloadEvent = settle(page.waitForEvent('download', { timeout: 120000 }));
    let download;
    try {
      await open();
      const outcome = await downloadEvent;
      if (outcome.error) throw outcome.error;
      download = outcome.value;
    } catch (error) {
      const status = page.isClosed() ? 'page closed' : await page.locator('[data-resume-status]').allTextContents().catch(() => []);
      const offerPresent = !page.isClosed() && await page.locator('[data-resume-name]').evaluateAll(nodes => nodes.some(node => Boolean(node.textContent))).catch(() => false);
      const progress = page.isClosed() ? null : numericProgress((await page.locator('[data-resume-progress]').allTextContents().catch(() => [])).at(-1));
      const senderDetail = senderState ? `exit=${senderState.child.exitCode}; signal=${senderState.child.signalCode}; stderr=${sanitizeDiagnostic(senderState.stderr)}` : 'not recorded';
      throw new Error(`Browser receive failed (${mode}): ${sanitizeDiagnostic(error.message)}; receiver=${sanitizeDiagnostic(JSON.stringify(status))}; offerPresent=${offerPresent}; progress=${JSON.stringify(progress)}; sender=${senderDetail}; events=${JSON.stringify(diagnostics)}`);
    } finally { await cdp.detach().catch(() => {}); }
    const file = join(work, `download-${measurements.length}-${download.suggestedFilename()}`);
    await download.saveAs(file);
    await page.locator('[data-resume-status]').filter({ hasText: 'File received and verified.' }).waitFor({ timeout: 20000 });
    assert.equal(requests.filter(request => request.includes('/api/codes')).length, 0, 'private v2 must not use the code directory');
    const secret = new URL(url).hash.slice(4);
    assert.equal(requests.some(request => request.includes(secret)), false, 'master key must not enter request URLs');
    assert.equal(joins.some(join => join.includes(secret)), false, 'master key must not enter relay joins');
    console.log(JSON.stringify({ event: 'receive-frame-metadata', mode, elapsedMs: Math.round(performance.now() - receiveStarted), events: diagnostics }));
    return { bytes: await readFile(file), filename: download.suggestedFilename() };
  }
  const data = randomBytes(1024 * 1024 + 77);
  const source = join(work, 'private payload.bin');
  await writeFile(source, data);
  for (const mode of ['private-link', 'pasted-link', 'qr-scan']) {
    const started = await sender(source);
    let receiverBrowser = browser;
    if (mode === 'qr-scan') {
      const camera = join(work, 'qr.y4m');
      await writeFile(camera, qrVideo(started.ready.url));
      receiverBrowser = await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camera}`]);
    }
    const context = await receiverBrowser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const received = await receive(page, started.ready.url, async () => {
      if (mode === 'private-link') {
        await page.goto(started.ready.url);
        await page.waitForURL(target => target.hash === '', { timeout: 15000 });
        await page.locator('[data-resume-status]').waitFor({ timeout: 15000 });
      } else {
        await page.goto(worker.publicBase);
        await page.locator('.workbench:not([inert])').waitFor();
        await page.locator('#receive-mode-btn').click();
        if (mode === 'pasted-link') await page.locator('#code-input').fill(started.ready.url);
        else await page.locator('#scan-qr-btn').click();
      }
    }, started, mode);
    assert.equal(received.filename, 'private payload.bin');
    assert.deepEqual(received.bytes, data);
    assert.equal(await childExit(started.child, 20000), 0, started.stderr);
    measurements.push({ mode, exactBytes: data.length, sha256: sha(data) });
    console.log(`PASS ${mode}: ${data.length} exact bytes; no directory/master-key disclosure`);
    await context.close();
  }

  // Close during receive, then reuse the same browser's durable stage and private link.
  const largeData = randomBytes(8 * 1024 * 1024 + 77);
  const largeSource = join(work, 'resumed payload.bin');
  await writeFile(largeSource, largeData);
  const first = await sender(largeSource);
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.addInitScript(() => {
    if (sessionStorage.getItem('interrupted-once')) return;
    globalThis.__CD_RESUME_TEST_OBSERVER__ = update => {
      if (update.role === 'receiver' && update.done >= 262144) {
        sessionStorage.setItem('interrupted-once', 'yes');
        location.replace('about:blank');
      }
    };
  });
  await page.goto(first.ready.url);
  await page.waitForURL('about:blank', { timeout: 30000 });
  await childExit(first.child, 15000);
  const root = new URL(first.ready.url).pathname.split('/').at(-1);
  const resumed = await sender(largeSource, root);
  await page.addInitScript(() => {
    globalThis.__CD_RESUME_TEST_OBSERVER__ = update => { globalThis.__RESUMED_BYTES__ = update.resumedBytes; };
  });
  const received = await receive(page, resumed.ready.url, () => page.goto(resumed.ready.url), resumed, 'interrupted-resume');
  assert.deepEqual(received.bytes, largeData);
  assert.ok(await page.evaluate(() => globalThis.__RESUMED_BYTES__ >= 262144), 'receiver must reuse durable verified bytes');
  assert.equal(await childExit(resumed.child, 20000), 0, resumed.stderr);
  measurements.push({ mode: 'interrupted-resume', exactBytes: largeData.length, retainedBytes: await page.evaluate(() => globalThis.__RESUMED_BYTES__), sha256: sha(largeData) });
  if (process.env.CD_V2_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CD_V2_SCREENSHOT_PATH, fullPage: true });
  await context.close();
  console.log(JSON.stringify({ passed: measurements.length, measurements }));
} catch (error) {
  // Playwright navigation errors may contain the private URL.
  throw new Error(sanitizeDiagnostic(error?.message ?? error, 20000));
} finally {
  for (const browser of browsers) await browser.close().catch(() => {});
  for (const child of children) await stopChild(child);
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}

function qrVideo(text) {
  const width = 640, height = 480;
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const cell = Math.floor(360 / (modules.size + 8));
  const side = cell * (modules.size + 8);
  const left = Math.floor((width - side) / 2), top = Math.floor((height - side) / 2);
  const luma = Buffer.alloc(width * height, 200);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
    const row = Math.floor(y / cell) - 4, col = Math.floor(x / cell) - 4;
    const dark = row >= 0 && col >= 0 && row < modules.size && col < modules.size && modules.get(row, col);
    luma[(top + y) * width + left + x] = dark ? 16 : 235;
  }
  const frame = Buffer.concat([Buffer.from('FRAME\n'), luma, Buffer.alloc(width * height / 2, 128)]);
  return Buffer.concat([Buffer.from(`YUV4MPEG2 W${width} H${height} F10:1 Ip A1:1 C420jpeg\n`), frame, frame]);
}
