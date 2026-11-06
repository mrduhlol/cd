import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { receiverAdmission, encodeBase64Url } from '../src/agent-protocol.js';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Covers the terminal flows: cdx send -> cdx receive, and browser /send ->
// cdx receive. Runs against a local Worker like verify-agent.mjs. Set
// CHROMIUM_PATH if Chromium lives outside the common system paths.
const hosted = process.env.CD_VERIFY_URL;
const port = hosted ? null : await availablePort();
const publicBase = hosted ? new URL(hosted).origin : `http://127.0.0.1:${port}`;
const relayBase = publicBase.replace(/^http/, 'ws') + '/ws/v1';
const childEnv = (extra = {}) => ({
  ...process.env,
  CD_RELAY_URL: hosted ? process.env.CD_RELAY_URL : relayBase,
  CD_PUBLIC_URL: hosted ? process.env.CD_PUBLIC_URL : publicBase,
  ...extra
});
const work = await mkdtemp(join(tmpdir(), 'cd-verify-terminal-'));
const executable = join(work, process.platform === 'win32' ? 'cdx.exe' : 'cdx');
const sourcePath = join(work, 'terminal check.bin');
const source = Uint8Array.from({ length: 384 * 1024 + 51 }, (_, index) => (index * 31 + 17) % 256);
await writeFile(sourcePath, source);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

let worker;
let browser;
try {
  await run('go', ['build', '-buildvcs=false', '-trimpath', '-o', executable, './cmd/cdx']);
  if (!hosted) {
    const wranglerCli = fileURLToPath(import.meta.resolve('wrangler'));
    worker = spawn(process.execPath, [wranglerCli, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(work, 'wrangler-state')], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await waitForHealth(`http://127.0.0.1:${port}/api/health`, worker);
  }

  // Flow 1: terminal -> terminal (short share code).
  {
    const outDir = join(work, 't2t');
    await mkdir(outDir, { recursive: true });
    // The agent path: a detached send exits 0 with the code, and
    // `cdx wait` reports the verified result.
    const stateEnv = { CD_STATE_DIR: join(work, 'state') };
    const protectedPath = join(work, 'protected-user-file');
    await writeFile(protectedPath, 'USER DATA');
    const legacyStaging = join(outDir, 'terminal check.bin.cd-part');
    if (process.platform !== 'win32') await symlink(protectedPath, legacyStaging);
    else await writeFile(legacyStaging, 'USER DATA');
    const sender = spawn(executable, ['send', sourcePath], { env: childEnv(stateEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    const code = await firstLine(sender.stdout);
    assert.match(code, /^\d{4,5}$/);
    assert.equal(await childExit(sender), 0, 'detached send did not exit 0');
    const waiter = spawn(executable, ['wait', code], { env: childEnv(stateEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    const senderExit = new Promise((resolve) => waiter.once('exit', resolve));
    const senderStderr = collect(waiter.stderr);
    const receiver = spawn(executable, ['receive', code, '--out', outDir, '--force'], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const receiverStderr = collect(receiver.stderr);
    const receiverExit = await childExit(receiver);
    assert.equal(receiverExit, 0, await receiverStderr);
    const received = await readFile(join(outDir, 'terminal check.bin'));
    assert.equal(sha(Buffer.from(received)), sha(Buffer.from(source)));
    const senderCode = await withTimeout(senderExit, 30_000, 'terminal sender did not finish');
    assert.equal(senderCode, 0, await senderStderr);
    assert.equal((await readFile(protectedPath)).toString(), 'USER DATA');
    assert.equal((await readFile(legacyStaging)).toString(), 'USER DATA');
    console.log(`verified terminal->terminal: ${received.byteLength} exact bytes; --force preserves existing staging files and symlink targets`);
    // The room releases its code once a receiver pairs: one receiver per code.
    assert.equal((await fetch(`${publicBase}/api/codes/${code}`)).status, 404, 'code still resolves after pairing');
    console.log('verified the share code is released once the receiver pairs');
  }

  // Older clients still claim codes over POST /api/codes (sharded directory).
  {
    const capability = { transferId: randomBytes(16).toString('base64url'), key: randomBytes(32).toString('base64url') };
    const { digest } = await receiverAdmission({ id: Buffer.from(capability.transferId, 'base64url'), key: Buffer.from(capability.key, 'base64url') });
    const legacySender = new WebSocket(`${relayBase}/${capability.transferId}`);
    try {
      await withTimeout(new Promise((resolve, reject) => {
        legacySender.addEventListener('error', reject, { once: true });
        legacySender.addEventListener('message', (event) => {
          assert.equal(JSON.parse(event.data).type, 'accepted');
          resolve();
        }, { once: true });
        legacySender.addEventListener('open', () => legacySender.send(JSON.stringify({
          type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: encodeBase64Url(digest)
        })), { once: true });
      }), 10_000, 'old-client sender admission timed out');
      const claim = await fetch(`${publicBase}/api/codes`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(capability)
      });
      assert.equal(claim.status, 200);
      const { code } = await claim.json();
      assert.match(code, /^\d{5}$/);
      assert.deepEqual(await (await fetch(`${publicBase}/api/codes/${code}`)).json(), capability);
      assert.equal((await fetch(`${publicBase}/api/codes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"transferId":"x"}' })).status, 400);
      assert.equal((await fetch(`${publicBase}/api/codes`, { method: 'POST', body: JSON.stringify(capability) })).status, 415);
      console.log('verified admitted old-client POST /api/codes claims and resolves through the sharded directory');
    } finally { legacySender.close(); }
  }

  // Flow 2: browser /send -> terminal.
  browser = await chromium.launch({
    executablePath: await findChromium(),
    headless: true,
    args: ['--disable-dev-shm-usage']
  });
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await page.goto(`${publicBase}/send`);
    await page.locator('.workbench:not([inert])').waitFor();
    await page.locator('#file-input').setInputFiles(sourcePath);
    await page.locator('#share-box:not([hidden])').waitFor();
    const code = (await page.locator('#share-code').textContent()).trim();
    assert.match(code, /^\d{4,5}$/);
    const outDir = join(work, 'b2t');
    await mkdir(outDir, { recursive: true });
    const receiver = spawn(executable, ['receive', code, '--out', outDir], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const receiverStderr = collect(receiver.stderr);
    const receiverExit = await withTimeout(childExit(receiver), 60_000, 'browser->terminal receiver did not finish');
    assert.equal(receiverExit, 0, await receiverStderr);
    const received = await readFile(join(outDir, 'terminal check.bin'));
    assert.equal(sha(Buffer.from(received)), sha(Buffer.from(source)));
    await page.locator('#status').filter({ hasText: 'The receiver has every byte.' }).waitFor();
    console.log(`verified browser->terminal: ${received.byteLength} exact bytes`);
    await context.close();
  }
  console.log('verified terminal receive flows through CLI, Worker, encryption, and flow control');
} finally {
  await browser?.close();
  await stopChild(worker);
  await rm(work, { recursive: true, force: true });
}

async function findChromium() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error('Chromium was not found; set CHROMIUM_PATH to run the browser transfer check');
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null && child.signalCode === null) {
    const killed = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await killed;
  }
}

async function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr = collect(child.stderr);
  const code = await childExit(child);
  assert.equal(code, 0, await stderr);
}

function childExit(child) {
  return withTimeout(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }), 120_000, 'child process did not exit');
}

async function waitForHealth(url, child) {
  let spawnError;
  child.once('error', (error) => { spawnError = error; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('wrangler stopped before becoming ready');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('wrangler did not become ready');
}

function collect(stream) {
  let output = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => stream.on('end', () => resolve(output)));
}

function firstLine(stream) {
  return withTimeout(new Promise((resolve, reject) => {
    let output = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline !== -1) resolve(output.slice(0, newline).trim());
    });
    stream.on('end', () => reject(new Error(`sender ended before printing a URL: ${output}`)));
  }), 10_000, 'sender did not print a URL');
}

function withTimeout(promise, timeoutMilliseconds, message) {
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMilliseconds);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timeout));
}
