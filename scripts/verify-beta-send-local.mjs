import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { createZipBundle } from '../src/zip-bundle.js';
import { buildCLI, startWorker, cliEnv, childExit, collect, stopChild, findChromium } from './harness.mjs';

// Install Beta and its test APK through the device tools before running.
const serial = process.env.CD_VERIFY_ANDROID_SERIAL;
assert.match(serial ?? '', /^emulator-\d+$/, 'Select the test emulator with CD_VERIFY_ANDROID_SERIAL');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const adb = process.env.ADB ?? (sdk ? join(sdk, 'platform-tools', 'adb') : 'adb');
const android = args => execFileSync(adb, ['-s', serial, ...args], { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
const packageId = 'in.yash0.cd.beta';
const work = await mkdtemp(join(tmpdir(), 'cd-beta-send-'));
let worker, sender, receiver, browser;
const remoteSource = '/data/local/tmp/cd-beta-send-verify.zip';
try {
  const payload = new File([randomBytes(12 * 1024 * 1024 + 123)], 'payload.bin');
  const bundle = createZipBundle([payload]);
  const parts = [];
  for await (const part of bundle.stream()) parts.push(part);
  const expected = Buffer.concat(parts);
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const source = join(work, 'fixture.zip');
  await writeFile(source, expected);
  android(['push', source, remoteSource]);
  const executable = await buildCLI(work);
  worker = await startWorker(work);
  const port = new URL(worker.publicBase).port;
  android(['reverse', `tcp:${port}`, `tcp:${port}`]);
  for (const mode of ['cli', 'browser']) {
    android(['shell', 'run-as', packageId, 'rm', '-f', 'files/send-test-status.json']);
    sender = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'base', worker.publicBase,
      '-e', 'source', remoteSource, '-e', 'tree', 'false', '-e', 'direct', mode === 'browser' ? 'true' : 'false',
      `${packageId}.test/in.yash0.cd.SendInstrumentation`]);
    const output = collect(sender.stdout), error = collect(sender.stderr), done = childExit(sender, 180_000);
    let status;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && sender.exitCode === null) {
      try { status = JSON.parse(android(['shell', 'run-as', packageId, 'cat', 'files/send-test-status.json'])); } catch {}
      assert.ok(!['FAILED', 'PAUSED'].includes(status?.phase), status?.message);
      if (status?.phase === 'WAITING' && /^\d{5}$/.test(status.code ?? '')) break;
      await delay(150);
    }
    assert.match(status?.code ?? '', /^\d{5}$/, 'Beta did not publish a numeric code');
    assert.ok(!status.link?.includes('#v2.'), 'Beta exposed a private share link');
    let destination;
    if (mode === 'cli') {
      destination = join(work, 'cli.zip');
      receiver = spawn(executable, ['receive', status.code, '--out', destination, '--json'], {
        env: cliEnv(worker, { CD_STATE_DIR: join(work, 'state'), CD_DIRECT: '0' })
      });
      receiver.stdout.resume();
      const failure = collect(receiver.stderr);
      assert.equal(await childExit(receiver, 180_000), 0, await failure);
    } else {
      browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage({ acceptDownloads: true });
      await page.goto(worker.publicBase);
      await page.locator('#receive-mode-btn').click();
      const received = page.waitForEvent('download', { timeout: 120_000 });
      await page.locator('#code-input').fill(status.code);
      const download = await received;
      destination = join(work, 'browser.zip');
      await download.saveAs(destination);
      await browser.close();
      browser = null;
    }
    assert.equal(sha(await readFile(destination)), sha(expected));
    assert.equal(await done, 0, await error);
    assert.match(await output, /result=complete/);
    console.log(`${mode}: CD Beta v2 numeric code, ZIP ${expected.length} bytes, SHA-256 verified`);
  }
  android(['reverse', '--remove', `tcp:${port}`]);
} finally {
  await stopChild(sender);
  await stopChild(receiver);
  await browser?.close();
  await worker?.stop();
  android(['shell', 'rm', '-f', remoteSource]);
  await rm(work, { recursive: true, force: true });
}
