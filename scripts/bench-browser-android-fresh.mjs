// Real browser sender to CD Beta. Drive the emulator's Receive box via agent-device.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { startWorker, findChromium, childExit, stopChild } from './harness.mjs';
const mib = Number(process.env.CD_FRESH_MIB ?? 600);
const serial = process.env.CD_ANDROID_SERIAL;
assert.equal(process.env.CD_VERIFY_URL, undefined, 'this emulator benchmark requires a local Worker');
assert.equal(process.env.CD_BENCH_RUNTIME_BUNDLE, undefined, 'historical runtime bundles are not supported');
assert.match(serial ?? '', /^emulator-\d+$/, 'use a dedicated Android emulator');
assert.ok(Number.isInteger(mib) && mib >= 1 && mib <= 600);
const output = resolve(process.env.CD_FRESH_OUTPUT ?? '/tmp/cd-browser-android-fresh.json');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const adb = process.env.ADB ?? (sdk ? join(sdk, 'platform-tools/adb') : 'adb');
const work = await mkdtemp(join(tmpdir(), 'cd-browser-android-fresh-'));
const filename = `fresh-browser-android-${Date.now()}.bin`, source = join(work, filename);
const report = { schema: 1, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), mib, serial, filename, ok: false,
  method: 'Real main-page browser sender, explicit relay, real CD Beta receive UI and publication. Transport timing spans first payload send through encrypted COMPLETE after Android publication. UI automation latency is excluded. Full published file is pulled and size/SHA256 verified outside timing. Local Worker through Wrangler development proxy and adb reverse. Emulator result, not physical hardware or WAN.' };
async function digest(path) { let bytes = 0; const h = createHash('sha256'); for await (const chunk of createReadStream(path)) { bytes += chunk.length; h.update(chunk); } return { bytes, sha256: h.digest('hex') }; }
async function android(args) {
  const child = spawn(adb, ['-s', serial, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.on('data', data => { stdout = (stdout + data).slice(-8192); });
  let error = ''; child.stderr.on('data', data => { error = (error + data).slice(-2048); });
  try { assert.equal(await childExit(child, args[0] === 'pull' ? 120000 : 30000), 0, error || 'adb file operation failed'); }
  finally { await stopChild(child); }
  return stdout;
}
let worker, browser, forwarded;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.interrupted = signal;
  void browser?.close();
});
try {
  assert.equal((await android(['shell', 'getprop', 'ro.kernel.qemu'])).trim(), '1', 'benchmarking requires an emulator');
  report.benchmarkSHA256 = (await digest(fileURLToPath(import.meta.url))).sha256;
  const installed = (await android(['shell', 'pm', 'path', 'in.yash0.cd.beta'])).trim().match(/^package:(\/data\/app\/[^\n]+\/base\.apk)$/);
  assert.ok(installed, 'install the current universal CD Beta debug APK before benchmarking');
  const installedAPK = join(work, 'installed.apk');
  await android(['pull', installed[1], installedAPK]);
  report.apk = await digest('android/app/build/outputs/apk/debug/app-debug.apk');
  assert.deepEqual(await digest(installedAPK), report.apk, 'installed CD Beta differs from the current build artifact');
  await rm(installedAPK);
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
  await context.addInitScript(() => {
    window.__androidBench = { payloadBytes: 0, records: 0, firstAt: null, completedAt: null, lastAt: null, maxGapMs: 0, extensions: null };
    const stats = window.__androidBench, NativeSocket = WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener('open', () => stats.extensions = this.extensions);
        this.addEventListener('message', event => {
          if (event.data instanceof ArrayBuffer) { const bytes = new Uint8Array(event.data); if (bytes[0] === 67 && bytes[1] === 68 && bytes[3] === 6) stats.completedAt = performance.now(); }
        });
      }
    };
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      const result = send.call(this, data);
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (bytes && bytes.length >= 12 && bytes[0] === 67 && bytes[1] === 68 && bytes[3] === 2) {
        const now = performance.now(); if (stats.lastAt !== null) stats.maxGapMs = Math.max(stats.maxGapMs, now - stats.lastAt);
        stats.firstAt ??= now; stats.lastAt = now; stats.payloadBytes += new DataView(bytes.buffer, bytes.byteOffset).getUint32(8); stats.records++;
      }
      return result;
    };
    window.RTCPeerConnection = class { constructor() { throw new Error('Android benchmark explicitly forces relay'); } };
  });
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  await page.goto(worker.publicBase); await page.locator('.workbench:not([inert])').waitFor();
  await page.locator('#file-input').setInputFiles(source); await page.locator('#sender-code-section:not(.hidden)').waitFor();
  const code = (await page.locator('#share-code').textContent()).trim(); assert.match(code, /^\d{4,5}$/);
  const offerFile = join(work, 'offer.json');
  await writeFile(offerFile, JSON.stringify({ input: `${worker.publicBase}/#${code}` }), { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, offerFile, filename, bytes: report.expected.bytes }));
  if (process.env.CD_ANDROID_AGENT_DEVICE) {
    const drive = args => {
      try { return execFileSync(process.env.CD_ANDROID_AGENT_DEVICE, args, { encoding: 'utf8', timeout: 30000 }); }
      catch (error) { throw new Error(error.message.replaceAll(`${worker.publicBase}/#${code}`, '<test invitation>')); }
    };
    drive(['open', 'in.yash0.cd.beta', '--relaunch']);
    let tree = drive(['snapshot', '-i']);
    const receiveTab = tree.match(/^(@e\d+(?:~s\d+)?) \[group\] "Receive"(?: \[selected\])?$/m);
    assert.ok(receiveTab, 'Receive tab missing from emulator UI');
    drive(['press', receiveTab[1], '--settle']);
    tree = drive(['snapshot', '-i']);
    const field = tree.match(/^(@e\d+(?:~s\d+)?) \[text-field\].*\[editable\]/m);
    assert.ok(field, 'Receive input missing from emulator UI');
    drive(['fill', field[1], `${worker.publicBase}/#${code}`, '--settle']);
    tree = drive(['snapshot', '-i']);
    const receive = tree.match(/^(@e\d+(?:~s\d+)?) \[group\] "Receive"$/m);
    assert.ok(receive, 'Receive action missing from emulator UI');
    drive(['press', receive[1], '--settle']);
  }
  await page.locator('#sender-complete:not(.hidden)').waitFor({ timeout: 300000 });
  report.transport = await page.evaluate(() => window.__androidBench);
  assert.equal(report.transport.payloadBytes, report.expected.bytes);
  assert.ok(report.transport.completedAt > report.transport.firstAt, 'missing final publication confirmation');
  report.receiveMs = report.transport.completedAt - report.transport.firstAt;
  report.mibPerSecond = mib / (report.receiveMs / 1000);
  const target = join(work, 'received.bin');
  await android(['pull', `/sdcard/Download/CD/${filename}`, target]);
  report.received = await digest(target); assert.deepEqual(report.received, report.expected);
  if (mib >= 64) assert.ok(report.mibPerSecond >= 4, 'emulator transfer fell below the 4 MiB/s regression floor');
  report.ok = true;
} catch (error) { report.error = error.message; process.exitCode = 1; }
finally {
  await android(['shell', 'rm', '-f', `/sdcard/Download/CD/${filename}`]).catch(error => { report.cleanupError = error.message; report.ok = false; process.exitCode = 1; });
  await browser?.close(); await worker?.stop();
  if (forwarded) await android(['reverse', '--remove', `tcp:${forwarded}`]).catch(() => {});
  await rm(work, { recursive: true, force: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ output, ...report }));
