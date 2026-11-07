import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { buildCLI, captureOutput, childExit, cliEnv, findChromium, firstLine, startWorker, stopChild } from './harness.mjs';

// Exercises the built UI, native browser storage, and the actual v2 Worker.
const work = await mkdtemp(join(tmpdir(), 'cd-browser-resume-'));
const children = [], contexts = [], measurements = [];
const payload = randomBytes(8 * 1024 * 1024 + 77);
const source = join(work, 'payload.bin');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const only = process.env.CD_BROWSER_RESUME_ONLY;
assert.ok(!only || ['browser-cli', 'browser-browser', 'browser-browser-fallback', 'browser-cli-restart', 'cli-browser-same-page-restart'].includes(only));
let worker, browser;
try {
  await writeFile(source, payload);
  const executable = await buildCLI(work);
  worker = await startWorker(work);
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
  const launch = args => {
    const child = spawn(executable, args, { env: cliEnv(worker, { CD_STATE_DIR: join(work, 'state') }), stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return { child, output: captureOutput(child) };
  };
  const page = async (interrupt = false, fallback = false) => {
    const context = await browser.newContext({ acceptDownloads: true });
    contexts.push(context);
    await context.addInitScript(fallback => {
      globalThis.__resumeWorkerWrites = 0;
      if (fallback) { globalThis.Worker = undefined; return; }
      const NativeWorker = Worker;
      globalThis.Worker = class extends NativeWorker {
        postMessage(...args) {
          if (args[0]?.type === 'write') globalThis.__resumeWorkerWrites++;
          return super.postMessage(...args);
        }
      };
    }, fallback);
    if (interrupt) await context.addInitScript(() => {
      const sockets = [];
      const NativeSocket = WebSocket;
      globalThis.WebSocket = class extends NativeSocket {
        constructor(...args) { super(...args); sockets.push(this); }
      };
      globalThis.__resumeProgress = [];
      globalThis.__CD_RESUME_TEST_OBSERVER__ = value => {
        globalThis.__resumeProgress.push(value);
        if (value.role === 'receiver' && value.done >= 262144 && !globalThis.__resumeInterrupted) {
          globalThis.__resumeInterrupted = true;
          for (const socket of sockets) socket.close(1000, 'test interruption');
        }
      };
    });
    const result = await context.newPage();
    result.setDefaultTimeout(30_000);
    await result.goto(worker.publicBase);
    return result;
  };
  const send = async (sender, link = '') => {
    await sender.goto(worker.publicBase);
    await sender.locator('#resumable-check').check();
    if (link) await sender.locator('#resume-link-input').fill(link);
    await sender.locator('#file-input').setInputFiles(source);
    await sender.locator('#sender-code-section:not(.hidden)').waitFor();
    const invitation = await sender.locator('#share-private-link').getAttribute('href');
    assert.match(invitation, /#v2\./);
    return invitation;
  };
  const complete = sender => sender.locator('#sender-complete:not(.hidden)').waitFor();
  for (const direction of ['browser-cli', 'browser-browser', 'browser-browser-fallback'].filter(value => !only || value === only)) {
    const sender = await page(), started = performance.now();
    const invitation = await send(sender);
    const destination = join(work, `${direction}.bin`);
    if (direction === 'browser-cli') {
      const receiver = launch(['receive', '--json', invitation, '--out', destination]);
      assert.equal(await childExit(receiver.child), 0, receiver.output.stderr);
    } else {
      const receiver = await page(false, direction === 'browser-browser-fallback');
      const downloading = receiver.waitForEvent('download', { timeout: 60_000 });
      await receiver.goto(invitation);
      await (await downloading).saveAs(destination);
      await receiver.locator('[data-resume-status]').filter({ hasText: 'File received and verified.' }).waitFor();
      const workerWrites = await receiver.evaluate(() => globalThis.__resumeWorkerWrites);
      if (direction === 'browser-browser-fallback') assert.equal(workerWrites, 0);
      else assert.equal(workerWrites, Math.ceil(payload.length / 262144));
    }
    await complete(sender);
    assert.equal(sha(await readFile(destination)), sha(payload));
    measurements.push({ scenario: direction, bytes: payload.length, sha256: sha(payload), milliseconds: performance.now() - started });
    console.error(`${direction}: verified ${payload.length} bytes`);
  }
  // A killed receiver retains its durable prefix. The same browser must resume
  // with its persisted sender capability and the original selected file.
  if (!only || only === 'browser-cli-restart') {
    const sender = await page(), invitation = await send(sender);
    const root = new URL(invitation).pathname.split('/').at(-1);
    const destination = join(work, 'restarted.bin');
    const receiver = launch(['receive', '--json', invitation, '--out', destination]);
    const exit = childExit(receiver.child);
    const checkpointPath = join(work, `.cd-${root}.checkpoint.json`);
    let checkpoint;
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      try { checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')); } catch {}
      if (checkpoint?.offset > 0 && checkpoint.offset < payload.length) break;
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.ok(checkpoint?.offset > 0 && checkpoint.offset < payload.length, 'missing incomplete durable prefix');
    receiver.child.kill('SIGKILL');
    await exit;
    checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8'));
    assert.equal(checkpoint.prefixSha256, sha(payload.subarray(0, checkpoint.offset)));
    await sender.locator('#sender-error:not(.hidden)').waitFor();
    assert.equal(await send(sender, invitation), invitation);
    const resumed = launch(['receive', '--resume', '--json', invitation, '--out', destination]);
    assert.equal(await childExit(resumed.child), 0, resumed.output.stderr);
    await resumed.output.finished;
    assert.equal(JSON.parse(resumed.output.stdout.trim().split('\n').at(-1)).resumedBytes, checkpoint.offset);
    await complete(sender);
    assert.equal(sha(await readFile(destination)), sha(payload));
    measurements.push({ scenario: 'browser-cli-restart', bytes: payload.length, resumedBytes: checkpoint.offset, sha256: sha(payload) });
  }
  if (!only || only === 'cli-browser-same-page-restart') {
    const receiver = await page(true);
    const sender = launch(['send', '--resumable', '--json', source]);
    const senderExit = childExit(sender.child);
    const ready = JSON.parse(await firstLine(sender.child.stdout));
    const root = new URL(ready.url).pathname.split('/').at(-1);
    await receiver.locator('#receive-mode-btn').click();
    await receiver.locator('#code-input').fill(ready.url);
    await receiver.waitForFunction(() => globalThis.__resumeInterrupted);
    await senderExit;
    await receiver.locator('[data-resume-status]').filter({ hasText: /interrupt|disconnect/i }).waitFor();
    const savedOffset = await receiver.evaluate(root => new Promise((resolve, reject) => {
      const request = indexedDB.open('cd-resume-v2', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('checkpoints').objectStore('checkpoints').get(`receiver:${root}`);
        read.onerror = () => { db.close(); reject(read.error); };
        read.onsuccess = () => { db.close(); resolve(read.result.offset); };
      };
    }), root);
    assert.ok(savedOffset > 0 && savedOffset < payload.length);
    const priorWorkerWrites = await receiver.evaluate(() => globalThis.__resumeWorkerWrites);
    const resumed = launch(['send', '--resume', root, '--json', source]);
    const resumedExit = childExit(resumed.child);
    const nextReady = JSON.parse(await firstLine(resumed.child.stdout));
    assert.equal(nextReady.url, ready.url);
    await receiver.locator('#relay-done-btn').click();
    const downloading = receiver.waitForEvent('download', { timeout: 60_000 });
    await receiver.locator('#code-input').fill(ready.url);
    const destination = join(work, 'browser-same-page-restart.bin');
    try { await (await downloading).saveAs(destination); }
    catch (error) {
      throw new Error(`Same-page receive stalled: ${await receiver.locator('[data-resume-status]').textContent()}; sender: ${resumed.output.stderr}`, { cause: error });
    }
    assert.equal(await resumedExit, 0, resumed.output.stderr);
    await receiver.locator('[data-resume-status]').filter({ hasText: 'File received and verified.' }).waitFor();
    assert.equal(sha(await readFile(destination)), sha(payload));
    const observedOffset = await receiver.evaluate(() => globalThis.__resumeProgress.filter(value => value.role === 'receiver').at(-1).resumedBytes);
    assert.equal(observedOffset, savedOffset);
    const resumedWorkerWrites = await receiver.evaluate(() => globalThis.__resumeWorkerWrites);
    assert.equal(resumedWorkerWrites - priorWorkerWrites, Math.ceil((payload.length - savedOffset) / 262144));
    measurements.push({ scenario: 'cli-browser-same-page-restart', bytes: payload.length, resumedBytes: savedOffset, sha256: sha(payload) });
  }
  console.log(JSON.stringify({ version: 1, completed: measurements.length, measurements }, null, 2));
} finally {
  for (const child of children) await stopChild(child);
  for (const context of contexts) await context.close();
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
