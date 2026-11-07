import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { buildCLI, startWorker, cliEnv, childExit, collect, stopChild } from './harness.mjs';
import { findChromium } from './verify-helpers.mjs';

// Install the debug and androidTest APKs in a device-tool-managed emulator first.
const serial = process.env.CD_VERIFY_ANDROID_SERIAL;
assert.ok(serial?.startsWith('emulator-'), 'Set CD_VERIFY_ANDROID_SERIAL to the test emulator serial');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const adb = process.env.ADB ?? (sdk ? join(sdk, 'platform-tools', 'adb') : 'adb');
const work = await mkdtemp(join(tmpdir(), 'cd-native-interop-'));
let worker, sender, receiver, browser;
try {
  const executable = await buildCLI(work);
  worker = await startWorker(work);
  for (const mode of ['cli', 'browser']) {
    sender = spawn(adb, ['-s', serial, 'shell', 'am', 'instrument', '-w', '-e', 'class',
      'in.yash0.cd.NativeSenderInteropTest', '-e', 'publicBase',
      worker.publicBase.replace('127.0.0.1', '10.0.2.2'),
      'in.yash0.cd.test/androidx.test.runner.AndroidJUnitRunner']);
    let output = '';
    sender.stdout.on('data', bytes => { output += bytes; });
    const done = childExit(sender);
    const errors = collect(sender.stderr);
    const deadline = Date.now() + 30_000;
    while (!output.includes('NATIVE_SEND code=') && Date.now() < deadline && sender.exitCode === null) await delay(100);
    const match = output.match(/NATIVE_SEND code=(\d+) size=(\d+) sha256=([a-f0-9]+)/);
    assert.ok(match, output || 'Native sender did not announce a numeric code');
    const [, code, size, sha] = match;
    let path;
    if (mode === 'cli') {
      const directory = join(work, 'cli');
      await mkdir(directory);
      receiver = spawn(executable, ['receive', code, '--out', directory, '--json'], { env: cliEnv(worker) });
      const result = collect(receiver.stdout), error = collect(receiver.stderr);
      assert.equal(await childExit(receiver), 0, await error);
      path = JSON.parse(await result).path;
    } else {
      browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage({ acceptDownloads: true });
      await page.goto(worker.publicBase);
      await page.locator('#receive-mode-btn').click();
      const received = page.waitForEvent('download', { timeout: 60_000 });
      await page.locator('#code-input').fill(code);
      const download = await received;
      path = join(work, 'browser.zip');
      await download.saveAs(path);
      await browser.close();
      browser = null;
    }
    const bytes = await readFile(path);
    assert.equal(bytes.length, Number(size));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha);
    assert.equal(await done, 0, await errors);
    assert.match(output, /OK \(1 test\)/);
    console.log(`${mode}: native ZIP received, ${size} bytes, SHA-256 verified`);
  }
} finally {
  await stopChild(sender);
  await stopChild(receiver);
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
