import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright-core';
import { browserTransportProbe } from './bench-metrics.mjs';
import { buildCLI, captureOutput, childExit, cliEnv, findChromium, firstLine, startWorker, stopChild } from './harness.mjs';

const mib = Number(process.env.CD_TRANSPORT_MIB ?? 64);
assert.ok(Number.isInteger(mib) && mib >= 16 && mib <= 64, 'CD_TRANSPORT_MIB must be 16..64');
const work = await mkdtemp(join(tmpdir(), 'cd-verify-transports-'));
const payload = randomBytes(mib * 1024 * 1024);
const source = join(work, 'payload.bin');
await writeFile(source, payload);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const children = new Set();
const cases = [
  { name: 'browser-browser-direct', sender: 'browser', receiver: 'browser' },
  { name: 'browser-cli-direct', sender: 'browser', receiver: 'cli' },
  { name: 'cli-browser-code', sender: 'cli', receiver: 'browser', shortCode: true, decryptDelayMs: 10 },
  { name: 'cli-browser-code-blocked', sender: 'cli', receiver: 'browser', shortCode: true, blocked: true },
  { name: 'cli-browser-direct', sender: 'cli', receiver: 'browser', decryptDelayMs: 10 },
  { name: 'browser-browser-blocked', sender: 'browser', receiver: 'browser', blocked: true },
  { name: 'browser-cli-blocked', sender: 'browser', receiver: 'cli', blocked: true },
  { name: 'cli-browser-blocked', sender: 'cli', receiver: 'browser', blocked: true },
  { name: 'browser-browser-upgrade', sender: 'browser', receiver: 'browser', directDelayMs: 150, decryptDelayMs: 10 },
  { name: 'browser-browser-slow', sender: 'browser', receiver: 'browser', decryptDelayMs: 20 }
];
const measurements = [];
let worker;
let browser;
let executable;
function launch(args, env) {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  return { child, output: captureOutput(child) };
}
function transportReports(stderr) {
  return stderr.split('\n').flatMap((line) => {
    try { const value = JSON.parse(line); return value.transport ? [value] : []; } catch { return []; }
  });
}
try {
  executable = await buildCLI(work);
  worker = await startWorker(work);
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--disable-dev-shm-usage', '--enable-precise-memory-info'] });
  const selected = process.env.CD_TRANSPORT_ONLY?.split(',');
  if (selected) for (const name of selected) assert.ok(cases.some((entry) => entry.name === name), `unknown transport case ${name}`);
  for (const testCase of cases.filter((entry) => !selected || selected.includes(entry.name))) {
    const contexts = [];
    const started = performance.now();
    let senderPage, receiverPage, cliSender, cliReceiver;
    const env = cliEnv(worker, { CD_TRANSPORT_REPORT: '1', CD_DIRECT: testCase.blocked ? '0' : '1' });
    try {
      const newPage = async (receiver = false) => {
        const context = await browser.newContext({ acceptDownloads: true });
        contexts.push(context);
        await context.addInitScript(browserTransportProbe, {
          blockDirect: Boolean(testCase.blocked), directDelayMs: receiver ? testCase.directDelayMs : 0,
          decryptDelayMs: receiver ? testCase.decryptDelayMs : 0
        });
        const page = await context.newPage();
        page.setDefaultTimeout(45_000);
        return page;
      };
      let invitation;
      const readyStarted = performance.now();
      if (testCase.sender === 'browser') {
        senderPage = await newPage();
        await senderPage.goto(worker.publicBase);
        await senderPage.locator('#file-input').setInputFiles(source);
        await senderPage.locator('#sender-code-section:not(.hidden)').waitFor();
        invitation = (await senderPage.locator('#share-code').textContent()).trim();
      } else {
        cliSender = launch(['send', '--wait', '--json', ...(testCase.shortCode ? [] : ['--link']), source], env);
        const ready = JSON.parse(await firstLine(cliSender.child.stdout, 30_000));
        invitation = testCase.shortCode ? ready.code : ready.url;
        assert.ok(invitation, 'sender must publish the requested invitation');
      }
      const readinessMs = performance.now() - readyStarted;
      const transferStarted = performance.now();
      const destination = join(work, `${testCase.name}.bin`);
      if (testCase.receiver === 'browser') {
        receiverPage = await newPage(true);
        await receiverPage.goto(worker.publicBase);
        await receiverPage.locator('#receive-mode-btn').click();
        const downloadEvent = receiverPage.waitForEvent('download', { timeout: 45_000 });
        await receiverPage.locator('#code-input').fill(invitation);
        const download = await downloadEvent;
        await download.saveAs(destination);
      } else {
        cliReceiver = launch(['receive', '--json', invitation, '--out', destination], env);
        assert.equal(await childExit(cliReceiver.child, 45_000), 0, cliReceiver.output.stderr);
        await cliReceiver.output.finished;
      }
      if (cliSender) {
        assert.equal(await childExit(cliSender.child, 45_000), 0, cliSender.output.stderr);
        await cliSender.output.finished;
      } else await senderPage.locator('#sender-complete:not(.hidden)').waitFor();
      const seconds = (performance.now() - transferStarted) / 1000;
      assert.equal(hash(await readFile(destination)), hash(payload), `${testCase.name}: payload hash differs`);
      const senderStats = senderPage ? await senderPage.evaluate(() => window.__benchTransport) : null;
      const receiverStats = receiverPage ? await receiverPage.evaluate(() => window.__benchTransport) : null;
      const reports = transportReports((cliSender?.output.stderr ?? '') + (cliReceiver?.output.stderr ?? ''));
      const directPayloadBytes = senderStats?.directPayloadBytes ?? receiverStats?.directReceivedPayloadBytes ?? 0;
      const relayPayloadBytes = senderStats?.relayPayloadBytes ?? receiverStats?.relayReceivedPayloadBytes ?? 0;
      if (testCase.blocked) {
        assert.equal(directPayloadBytes, 0, 'blocked direct carried payload');
        assert.ok(relayPayloadBytes >= payload.length, 'blocked direct did not finish through relay');
        for (const report of reports) assert.equal(report.directBytes, 0);
      } else assert.ok(directPayloadBytes >= 1024 * 1024, `${testCase.name}: direct did not carry at least 1MiB: ${JSON.stringify({ senderStats, receiverStats, reports })}`);
      if (testCase.directDelayMs) {
        assert.ok(relayPayloadBytes > 0, 'upgrade never used relay payload');
        assert.equal(senderStats.firstPayloadRoute, 'relay', 'upgrade waited for direct instead of starting relay');
        assert.ok(senderStats.routes.includes('direct'), 'upgrade never switched payload route');
      }
      for (const stats of [senderStats, receiverStats].filter(Boolean)) {
        assert.ok(stats.maxDirectBufferedBytes <= 5 * 1024 * 1024, 'native direct queue exceeded4MiB+one maxrecord');
        assert.ok(stats.maxRelayBufferedBytes <= 5 * 1024 * 1024, 'native relay queue exceeded4MiB+one maxrecord');
        const max = stats.engineMaxima;
        if (max.retainedBytes !== undefined) assert.ok(max.retainedBytes <= 16 * 1024 * 1024, 'retained ciphertext exceeded16MiB');
        if (max.incomingBytes !== undefined) assert.ok(max.incomingBytes <= 4 * 1024 * 1024, 'incoming ciphertext exceeded4MiB');
        if (max.maxIncomingBytes !== undefined) assert.ok(max.maxIncomingBytes <= 4 * 1024 * 1024, 'incoming high water exceeded4MiB');
        if (max.maxIncomingCount !== undefined) assert.ok(max.maxIncomingCount <= 256, 'incoming record count exceeded256');
        if (max.maxRetainedBytes !== undefined) assert.ok(max.maxRetainedBytes <= 16 * 1024 * 1024, 'retained high water exceeded16MiB');
        if (max.mergerBytes !== undefined) assert.ok(max.mergerBytes <= 32 * 1024 * 1024, 'merger exceeded32MiB');
        if (max.window_inFlight !== undefined) assert.ok(max.window_inFlight <= 12 * 1024 * 1024, 'adaptive in-flight exceeded12MiB');
        if (max.window_sampleCount !== undefined) assert.ok(max.window_sampleCount <= 64, 'adaptive RTT sample retention exceeded64');
      }
      if (senderStats) assert.ok(senderStats.engineMaxima.window_inFlight !== undefined, 'missing actual engine window measurements');
      measurements.push({ name: testCase.name, passed: true, readinessMs: Number(readinessMs.toFixed(3)), seconds: Number(seconds.toFixed(3)),
        mibPerSecond: Number((mib / seconds).toFixed(3)), bytesVerified: payload.length, directPayloadBytes, relayPayloadBytes,
        senderStats, receiverStats, cliReports: reports, totalMs: Number((performance.now() - started).toFixed(3)) });
      console.error(`${testCase.name}: ${directPayloadBytes} direct, ${relayPayloadBytes} relay payload bytes, ${seconds.toFixed(3)}s`);
    } catch (error) {
      const status = receiverPage ? await receiverPage.locator('#receiver-status, [data-relay="status"]').allTextContents().catch(() => []) : [];
      throw new Error(`${testCase.name}: ${error.message}\nReceiver status: ${status.join('; ')}\nCLI diagnostics: ${cliSender?.output.stderr ?? cliReceiver?.output.stderr ?? ''}`, { cause: error });
    } finally {
      await stopChild(cliSender?.child);
      await stopChild(cliReceiver?.child);
      for (const context of contexts) await context.close();
    }
  }
  console.log(JSON.stringify({ version: 1, mib, passed: measurements.length, failed: 0, measurements }));
} finally {
  for (const child of children) await stopChild(child);
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
