// Real desktop browser sender to Android Chrome, including public download verification.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, writeFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startWorker, findChromium, childExit, stopChild } from './harness.mjs';
import { probe } from './fresh-browser-probe.mjs';
const mib = Number(process.env.CD_FRESH_MIB ?? 600);
const serial = process.env.CD_ANDROID_SERIAL;
assert.equal(process.env.CD_VERIFY_URL, undefined, 'this emulator benchmark requires a local Worker');
assert.equal(process.env.CD_BENCH_RUNTIME_BUNDLE, undefined, 'historical runtime bundles are not supported');
assert.match(serial ?? '', /^emulator-\d+$/, 'use a dedicated Android emulator');
assert.ok(Number.isInteger(mib) && mib >= 1 && mib <= 600);
const output = resolve(process.env.CD_FRESH_OUTPUT ?? '/tmp/cd-browser-chrome-fresh.json');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const adb = process.env.ADB ?? (sdk ? join(sdk, 'platform-tools/adb') : 'adb');
const work = await mkdtemp(join(tmpdir(), 'cd-chrome-fresh-'));
const filename = `fresh-browser-android-${Date.now()}.bin`, source = join(work, filename);
const report = { schema: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mib, serial, filename, ok: false,
  method: 'Actual Chrome Android UI receiver; automatic route observed at host sender. Local Worker through Wrangler and adb reverse. Staging completion is sender UI observation, not OS download completion. Full-size public Downloads observation is separate; pulled full SHA256 verifies output outside timing. Polling adds up to one second and does not claim fsync durability. Emulator, not physical phone or WAN.' };
async function digest(path) { let bytes = 0; const h = createHash('sha256'); for await (const chunk of createReadStream(path)) { bytes += chunk.length; h.update(chunk); } return { bytes, sha256: h.digest('hex') }; }
async function android(args) {
  const child = spawn(adb, ['-s', serial, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', data => { stdout = (stdout + data).slice(0, 65536); });
  let error = ''; child.stderr.on('data', data => { error = (error + data).slice(-2048); });
  try { assert.equal(await childExit(child, args[0] === 'pull' ? 120000 : 30000), 0, error || 'adb file operation failed'); }
  finally { await stopChild(child); }
  return stdout;
}
let worker, browser, forwarded, page;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.interrupted = signal;
  void browser?.close();
});
try {
  assert.equal((await android(['shell', 'getprop', 'ro.kernel.qemu'])).trim(), '1', 'benchmarking requires an emulator');
  const space = await statfs(work);
  assert.ok(space.bavail * space.bsize >= (3 * mib + 256) * 1048576, 'not enough host space for source, verified output, and temporary files');
  report.benchmarkSHA256 = (await digest(fileURLToPath(import.meta.url))).sha256;
  report.probeSHA256 = (await digest('scripts/fresh-browser-probe.mjs')).sha256;
  report.runtime = 'Wrangler development proxy';
  report.distIndexSHA256 = (await digest('dist/index.html')).sha256;
  report.dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  report.androidChrome = (await android(['shell', 'dumpsys', 'package', 'com.android.chrome'])).match(/versionName=([^\s]+)/)?.[1];
  assert.ok(report.androidChrome, 'could not identify installed Chrome version');
  const file = await open(source, 'wx');
  try { for (let i = 0; i < mib; i++) { if (report.interrupted) throw new Error('Benchmark interrupted'); await file.writeFile(randomBytes(1048576)); } } finally { await file.close(); }
  report.expected = await digest(source);
  worker = await startWorker(work);
  if (report.interrupted) throw new Error('Benchmark interrupted');
  const port = new URL(worker.publicBase).port;
  await android(['reverse', `tcp:${port}`, `tcp:${port}`]); forwarded = port;
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage'] });
  report.chromium = browser.version();
  const context = await browser.newContext();
  await context.addInitScript(probe, { relayOnly: false });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.goto(worker.publicBase); await page.locator('.workbench:not([inert])').waitFor();
  await page.locator('#file-input').setInputFiles(source); await page.locator('#sender-code-section:not(.hidden)').waitFor();
  const code = (await page.locator('#share-code').textContent()).trim(); assert.match(code, /^\d{4,5}$/);
  const invitation = `${worker.publicBase}/#${code}`;
  assert.ok(process.env.CD_ANDROID_AGENT_DEVICE, 'use the bound command returned by device_open');
  try { execFileSync(process.env.CD_ANDROID_AGENT_DEVICE, ['open', 'com.android.chrome', invitation], { encoding: 'utf8', timeout: 30000, stdio: 'pipe' }); }
  catch (error) { throw new Error(error.message.replaceAll(invitation, '<test invitation>')); }
  await page.locator('#sender-complete:not(.hidden)').waitFor({ timeout: Number(process.env.CD_FRESH_TIMEOUT_MS ?? 300000) });
  report.stagingCompleteObservedEpochMs = Date.now();
  report.transport = await page.evaluate(async () => ({ ...await window.__freshSnapshot(), timeOrigin: performance.timeOrigin, observedCompleteAt: performance.now() }));
  assert.ok(report.transport.relay + report.transport.direct >= report.expected.bytes, 'missing encrypted payload evidence');
  report.stagingMs = report.transport.observedCompleteAt - report.transport.firstAt;
  report.stagingMiBPerSecond = mib / (report.stagingMs / 1000);
  const publicFile = `/sdcard/Download/${filename}`;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const size = await android(['shell', 'stat', '-c', '%s', publicFile]).catch(() => '');
    if (Number(size.trim()) === report.expected.bytes) { report.publicationSizeObservedEpochMs = Date.now(); break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  assert.ok(report.publicationSizeObservedEpochMs, 'Chrome did not publish the full generated file in public Downloads');
  report.publicationAfterStagingObservedMs = report.publicationSizeObservedEpochMs - report.stagingCompleteObservedEpochMs;
  report.receiveThroughPublicationMs = report.publicationSizeObservedEpochMs - (report.transport.timeOrigin + report.transport.firstAt);
  const target = join(work, 'received.bin');
  const verifyStart = Date.now();
  await android(['pull', publicFile, target]);
  report.received = await digest(target); assert.deepEqual(report.received, report.expected);
  report.verificationMs = Date.now() - verifyStart;
  report.mibPerSecond = mib / (report.receiveThroughPublicationMs / 1000);
  if (mib >= 64) assert.ok(report.mibPerSecond >= 4, 'emulator publication fell below the 4 MiB/s regression floor');
  report.ok = true;
} catch (error) { report.error = error.message.replace(/http:\/\/[^\s]+/g, '<local URL>'); process.exitCode = 1; }
finally {
  if (page) report.finalTransport = await page.evaluate(() => window.__freshSnapshot()).catch(() => null);
  if (page) report.senderStatus = await page.locator('#sender-status').textContent().catch(() => null);
  await android(['shell', 'rm', '-f', `/sdcard/Download/${filename}`]).catch(error => { report.cleanupError = error.message; report.ok = false; process.exitCode = 1; });
  await browser?.close(); await worker?.stop();
  if (forwarded) await android(['reverse', '--remove', `tcp:${forwarded}`]).catch(() => {});
  await rm(work, { recursive: true, force: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ output, ok: report.ok, error: report.error }));
