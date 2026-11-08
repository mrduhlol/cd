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
import { probe } from './fresh-browser-probe.mjs';

const mib = Number(process.env.CD_FRESH_MIB ?? 600);
const runs = Number(process.env.CD_FRESH_RUNS ?? 3);
const timeout = Number(process.env.CD_FRESH_TIMEOUT_MS ?? 300_000);
const routes = (process.env.CD_FRESH_ROUTES ?? 'auto,relay').split(',');
const output = resolve(process.env.CD_FRESH_OUTPUT ?? '/tmp/cd-transfer-fresh.json');
assert.equal(process.env.CD_BENCH_RUNTIME_BUNDLE, undefined, 'fresh runner does not accept historical runtime bundles');
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
function workerOrigin() { return new URL(process.env.CD_VERIFY_URL).origin; }
let worker;
const browsers = [];
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.interrupted = signal;
  void Promise.allSettled(browsers.map(browser => browser.close()));
});
try {
  const input = process.env.CD_FRESH_INPUT ? resolve(process.env.CD_FRESH_INPUT) : join(work, 'payload.bin');
  if (!process.env.CD_FRESH_INPUT) {
    const file = await open(input, 'w');
    try { for (let index = 0; index < mib; index++) await file.writeFile(randomBytes(1048576)); }
    finally { await file.close(); }
  }
  const expected = await digest(input);
  assert.equal(expected.bytes, mib * 1048576, 'input size must match CD_FRESH_MIB');
  report.input = { ...expected, generated: !process.env.CD_FRESH_INPUT };
  report.benchmarkSHA256 = (await digest('scripts/bench-transfer-fresh.mjs')).sha256;
  report.probeSHA256 = (await digest('scripts/fresh-browser-probe.mjs')).sha256;
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
  report.serviceOrigin = worker.publicBase;
  report.runtime = process.env.CD_VERIFY_URL ? 'configured service' : 'Wrangler development proxy';
  for (let index = 0; index < 2; index++) browsers.push(await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] }));
  report.assetOverride = process.env.CD_FRESH_ASSET_DIR ? resolve(process.env.CD_FRESH_ASSET_DIR) : null;
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
        if (report.assetOverride) for (const pattern of [`${worker.publicBase}/`, `${worker.publicBase}/assets/*`]) await context.route(pattern, async request => {
          const path = new URL(request.request().url()).pathname;
          if (path === '/') return request.fulfill({ path: join(report.assetOverride, 'index.html') });
          if (/^\/assets\/[A-Za-z0-9_.-]+$/.test(path)) return request.fulfill({ path: join(report.assetOverride, path.slice(1)) });
          return request.continue();
        });
      }
      sender = await contexts[0].newPage(); receiver = await contexts[1].newPage();
      row.networkErrors = [];
      for (const [role, page] of [['sender', sender], ['receiver', receiver]]) page.on('requestfailed', request => {
        row.networkErrors.push({ role, path: new URL(request.url()).pathname.replace(/\/[A-Za-z0-9_-]{22}$/, '/<id>'), error: request.failure()?.errorText });
      });
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
      row.transport = await sender.evaluate(() => window.__freshSnapshot());
      assert.ok(row.transport.relay + row.transport.direct >= expected.bytes, 'missing payload transport evidence');
      if (route === 'relay') { assert.equal(row.transport.direct, 0); assert.equal(row.transport.relay, expected.bytes); }
      row.mibPerSecond = mib / (row.receiveMs / 1000);
      row.ok = true; await rm(target);
    } catch (error) {
      row.error = error.message;
      row.receiverTransport = await receiver?.evaluate(() => window.__freshSnapshot()).catch(() => null);
      row.senderState = await sender?.locator('#app-state').textContent().catch(() => null);
      row.senderStatus = await sender?.locator('#sender-status').textContent().catch(() => null);
      row.transport = await sender?.evaluate(() => window.__freshSnapshot()).catch(() => null);
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
