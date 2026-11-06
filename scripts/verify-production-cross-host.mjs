import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { captureOutput, childExit, firstLine, findChromium, stopChild } from './harness.mjs';

const origin = 'https://cd.yash0.in';
const phase = process.env.CD_VERIFY_PHASE || 'all';
assert.ok(['all', 'ordinary', 'receiver', 'sender'].includes(phase));
const remote = 'yvm@192.168.1.9';
const remoteDir = '/home/yvm/.cache/cd-production-verify-20261026';
const executable = '/tmp/cd-resume-candidate';
const work = await mkdtemp(join(tmpdir(), 'cd-production-check-'));
const profile = await mkdtemp(join(homedir(), '.cache/cd-production-check-'));
const output = resolve(process.argv[2] || 'docs/measurements/production-cross-host-2026-10-26.json');
const children = [], rows = [];
const sha = value => createHash('sha256').update(value).digest('hex');
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const env = { CD_RELAY_URL: 'wss://cd.yash0.in/ws/v1', CD_PUBLIC_URL: origin, CD_STATE_DIR: remoteDir + '/state', CD_DIRECT: '0', CD_TRANSPORT_REPORT: '1' };
const clean = value => String(value).replace(/#v[12]\.[A-Za-z0-9_-]+/g, '#<redacted>');
const ssh = command => execFileSync('ssh', ['-o', 'BatchMode=yes', remote, command], { encoding: 'utf8', timeout: 30000 });
function launch(host, args, extra = {}) {
  const vars = { ...env, ...extra };
  const child = host === 'linux'
    ? spawn('ssh', ['-o', 'BatchMode=yes', remote, ['timeout', '180', 'env', ...Object.entries(vars).map(([key, value]) => key + '=' + value), remoteDir + '/cdx', ...args].map(quote).join(' ')], { stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(executable, args, { env: { ...process.env, ...vars, CD_STATE_DIR: work + '/state' }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const captured = captureOutput(child), exit = childExit(child, 180000);
  exit.catch(() => {});
  return { child, captured, exit };
}
let browser;
try {
  const bytes = randomBytes(32 * 1024 * 1024 + 77), localSource = join(work, 'random32.bin');
  await writeFile(localSource, bytes);
  const remoteSha = ssh(`sha256sum ${quote(remoteDir + '/random32.bin')}`).split(' ')[0];
  const smallSha = ssh(`sha256sum ${quote(remoteDir + '/small.bin')}`).split(' ')[0];
  browser = await chromium.launchPersistentContext(profile, { executablePath: await findChromium(), headless: true, acceptDownloads: true, serviceWorkers: 'block' });
  const variants = { before: resolve('/tmp/cd-resume-before-dist'), after: resolve('dist') };
  async function pageFor(mode) {
    const page = await browser.newPage();
    page.setDefaultTimeout(90000);
    await page.addInitScript(() => {
      window.workerWrites = 0;
      const Native = Worker;
      window.Worker = class extends Native {
        postMessage(...args) { if (args[0]?.type === 'write') window.workerWrites++; return super.postMessage(...args); }
      };
    });
    // Only browser assets are overridden. All sockets use the live production origin.
    if (mode !== 'production') await browser.route(`**/__cd_verify/${mode}/assets/*`, async route => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1);
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) return route.abort();
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(join(variants[mode], 'assets', name)) });
    });
    if (mode === 'after') await browser.route('**/assets/resume-opfs-worker-*.js', async route => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1);
      if (!/^resume-opfs-worker-[A-Za-z0-9_-]+\.js$/.test(name)) return route.abort();
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(join(variants.after, 'assets', name)) });
    });
    await page.goto(origin);
    const moduleURL = mode === 'production' ? '/assets/resume-browser-BUoQOf8q.js' : `/__cd_verify/${mode}/assets/${(await readdir(join(variants[mode], 'assets'))).find(name => /^resume-browser-.*\.js$/.test(name))}`;
    await page.evaluate(async url => { window.module = await import(url); window.db = await module.openResumeDatabase(); }, moduleURL);
    return page;
  }
  // Two real hosts exercise ordinary relay and automatic LAN routes.
  for (const [direction, direct] of (['all', 'ordinary'].includes(phase) ? [['linux-pc-small', '0'], ['pc-linux-32m', '1']] : [])) {
    const senderHost = direction.startsWith('linux') ? 'linux' : 'pc';
    const destination = senderHost === 'linux' ? join(work, 'small-received.bin') : remoteDir + '/normal-received.bin';
    const started = performance.now();
    const sender = launch(senderHost, ['send', '--wait', '--json', '--link', senderHost === 'linux' ? remoteDir + '/small.bin' : localSource], { CD_DIRECT: direct });
    const ready = JSON.parse(await firstLine(sender.child.stdout, 30000));
    const receiver = launch(senderHost === 'linux' ? 'pc' : 'linux', ['receive', '--json', ready.url, '--out', destination, '--force'], { CD_DIRECT: direct });
    assert.equal(await receiver.exit, 0, clean(receiver.captured.stderr));
    assert.equal(await sender.exit, 0, clean(sender.captured.stderr));
    const milliseconds = performance.now() - started;
    const actual = senderHost === 'linux' ? sha(await readFile(destination)) : ssh(`sha256sum ${quote(destination)}`).split(' ')[0];
    assert.equal(actual, senderHost === 'linux' ? smallSha : sha(bytes));
    const routes = (sender.captured.stderr + receiver.captured.stderr).split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.transport ? [value] : []; } catch { return []; } });
    rows.push({ scenario: direction, milliseconds, bytes: senderHost === 'linux' ? 17003 : bytes.length, sha256: actual, routes, verified: true });
    console.error(`${direction}: hash verified`);
  }
  // Untouched deployed receiver, then paired optimized/control assets on that origin.
  for (const [trial, mode] of (['all', 'receiver'].includes(phase) ? [[0, 'production'], ...Array.from({ length: 3 }, (_, index) => (index % 2 ? ['after', 'before'] : ['before', 'after']).map(mode => [index + 1, mode])).flat()] : [])) {
    const page = await pageFor(mode);
    const sender = launch('linux', ['send', '--resumable', '--json', remoteDir + '/random32.bin']);
    const ready = JSON.parse(await firstLine(sender.child.stdout, 30000));
    const downloading = page.waitForEvent('download'); downloading.catch(() => {});
    const started = performance.now();
    try {
      await page.evaluate(link => {
        const container = document.createElement('div'); document.body.append(container);
        window.transfer = module.mountResumableReceiver(container, link, { checkpoints: module.createResumeKV(db, 'checkpoints'), secrets: module.createResumeKV(db, 'secrets') });
        transfer.done.catch(() => {});
      }, ready.url);
      await page.evaluate(() => transfer.done);
      const milliseconds = performance.now() - started;
      assert.equal(await sender.exit, 0, clean(sender.captured.stderr));
      const path = join(work, `receiver-${trial}-${mode}.bin`);
      await (await downloading).saveAs(path);
      assert.equal(sha(await readFile(path)), remoteSha);
      const workerWrites = await page.evaluate(() => window.workerWrites);
      assert.equal(workerWrites, mode === 'after' ? 129 : 0);
      rows.push({ scenario: 'linux-browser', trial, mode, bytes: bytes.length, milliseconds, sha256: remoteSha, workerWrites, verified: true });
      console.error(`linux-browser ${mode} #${trial}: ${milliseconds.toFixed(1)}ms, hash verified`);
    } catch (error) {
      rows.push({ scenario: 'linux-browser', trial, mode, verified: false, error: clean(error.message) });
      if (mode !== 'production') throw error;
      console.error('untouched production receiver failed; failure recorded');
      await stopChild(sender.child);
    } finally { await page.close(); }
    await writeFile(output, JSON.stringify({ origin, remote, rows }, null, 2));
  }
  for (let trial = 1; trial <= (['all', 'sender'].includes(phase) ? 3 : 0); trial++) for (const mode of trial % 2 ? ['before', 'after'] : ['after', 'before']) {
    const page = await pageFor(mode);
    try {
      await page.evaluate(() => { const input = document.createElement('input'); input.type = 'file'; input.id = 'verification-file'; document.body.append(input); });
      await page.locator('#verification-file').setInputFiles(localSource);
      await page.evaluate(() => {
        window.shareReady = new Promise(resolve => { window.resolveShare = resolve; });
        window.transfer = module.startResumableSend(document.querySelector('#verification-file').files[0], { checkpoints: module.createResumeKV(db, 'checkpoints'), secrets: module.createResumeKV(db, 'secrets'), hooks: { onShare: resolveShare } });
        transfer.done.catch(() => {});
      });
      const { url } = await page.evaluate(() => shareReady);
      const destination = remoteDir + `/browser-${mode}-${trial}.bin`;
      const started = performance.now();
      const receiver = launch('linux', ['receive', '--json', url, '--out', destination]);
      assert.equal(await receiver.exit, 0, clean(receiver.captured.stderr));
      await page.evaluate(() => transfer.done);
      const milliseconds = performance.now() - started;
      const actual = ssh(`sha256sum ${quote(destination)}`).split(' ')[0];
      assert.equal(actual, sha(bytes));
      rows.push({ scenario: 'browser-linux', trial, mode, milliseconds, bytes: bytes.length, sha256: actual, verified: true });
      console.error(`browser-linux ${mode} #${trial}: ${milliseconds.toFixed(1)}ms, hash verified`);
    } finally { await page.close(); }
    await writeFile(output, JSON.stringify({ origin, remote, rows }, null, 2));
  }
  console.log(JSON.stringify({ origin, remote, rows }, null, 2));
  await writeFile(output, JSON.stringify({ origin, remote, phase, rows }, null, 2));
} finally {
  for (const child of children) await stopChild(child);
  await browser?.close();
  await rm(work, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}
