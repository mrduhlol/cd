import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  encodeBase64Url,
  parseInvitation,
  receiverAdmission
} from '../src/agent-protocol.js';

const hosted = process.env.CD_VERIFY_URL;
const port = hosted ? null : await availablePort();
const publicBase = hosted ? new URL(hosted).origin : `http://127.0.0.1:${port}`;
const relayBase = publicBase.replace(/^http/, 'ws') + '/ws/v1';
const work = await mkdtemp(join(tmpdir(), 'cd-verify-'));
const executable = join(work, process.platform === 'win32' ? 'cdx.exe' : 'cdx');
const sourcePath = join(work, 'résumé final.bin');
const source = Uint8Array.from({ length: 1536 * 1024 + 73 }, (_, index) => (index * 31 + 17) % 256);
await writeFile(sourcePath, source);

let worker;
let sender;
let browser;
try {
  await run('go', ['build', '-buildvcs=false', '-trimpath', '-o', executable, './cmd/cdx']);
  if (!hosted) {
    const wranglerCli = fileURLToPath(import.meta.resolve('wrangler'));
    worker = spawn(process.execPath, [wranglerCli, 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', join(work, 'wrangler-state')], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    collect(worker.stdout);
    collect(worker.stderr);
    await waitForHealth(`http://127.0.0.1:${port}/api/health`, worker);
    await verifyPeerSignaling(port);
    const missing = await runCapture(executable, ['send', join(work, 'missing.bin')]);
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, '');
    await expectClose(
      `ws://127.0.0.1:${port}/ws/v1/AAAAAAAAAAAAAAAAAAAAAA`,
      { type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      4404
    );
    await expectClose(
      `ws://127.0.0.1:${port}/ws/v1/CCCCCCCCCCCCCCCCCCCCCC`,
      { type: 'join', protocol: 'cd-transfer-v0', role: 'sender', receiverTokenHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      4406
    );
    await expectSilentTimeout(`ws://127.0.0.1:${port}/ws/v1/DDDDDDDDDDDDDDDDDDDDDD`);
    const abandonedRoom = `ws://127.0.0.1:${port}/ws/v1/BBBBBBBBBBBBBBBBBBBBBB`;
    await connectAndClose(abandonedRoom, {
      type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    });
    await expectClose(abandonedRoom, {
      type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    }, 4409);
  }
  sender = spawn(executable, ['send', '--wait', '--link', sourcePath], {
    env: {
      ...process.env,
      CD_RELAY_URL: relayBase,
      CD_PUBLIC_URL: publicBase,
      CD_TRANSPORT_REPORT: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const senderExit = new Promise((resolve) => sender.once('exit', resolve));
  let senderDiagnostics = '';
  sender.stderr.on('data', (chunk) => { senderDiagnostics = (senderDiagnostics + chunk.toString()).slice(-16 * 1024); });
  const stderr = collect(sender.stderr);
  const link = await firstLine(sender.stdout);
  const linkUrl = new URL(link);
  assert.equal(linkUrl.origin, publicBase);
  assert.match(linkUrl.pathname, /^\/s\/[A-Za-z0-9_-]{22}$/);
  assert.match(linkUrl.hash, /^#v1\.[A-Za-z0-9_-]{43}$/);
  const relayUrl = `${relayBase}/${linkUrl.pathname.split('/').at(-1)}`;
  await expectClose(relayUrl, {
    type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  }, 4401);
  await expectClose(relayUrl, {
    type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  }, 4409);
  const invitation = parseInvitation(new URL(link));
  const { token } = await receiverAdmission(invitation);
  browser = await chromium.launch({
    executablePath: await findChromium(),
    headless: true,
    args: ['--disable-dev-shm-usage']
  });
  const context = await browser.newContext({ acceptDownloads: true, reducedMotion: 'reduce' });
  await context.addInitScript(() => { delete window.showSaveFilePicker; });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(link);
  await page.locator('[data-relay="offer"]:not([hidden])').waitFor();
  await assertVisibleBrand(page);
  assert.equal(await page.locator('[data-relay="file-name"]').textContent(), 'résumé final.bin');
  await expectClose(relayUrl, {
    type: 'join', protocol: 'cd-transfer-v1', role: 'receiver', receiverToken: encodeBase64Url(token)
  }, 4409);
  await page.locator('[data-relay="accept"]').click();
  await page.locator('[data-relay="status"]').filter({ hasText: 'File verified and ready to download.' }).waitFor();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('[data-relay="download"]').click();
  const download = await downloadEvent;
  const receivedPath = join(work, await download.suggestedFilename());
  await download.saveAs(receivedPath);
  const received = await readFile(receivedPath);
  const exitCode = await withTimeout(senderExit, 30_000, 'sender did not finish').catch((error) => {
    throw new Error(`${error.message}\nSender output:\n${senderDiagnostics}`, { cause: error });
  });
  const senderLog = await stderr;
  assert.equal(exitCode, 0, senderLog);
  // The direct path is opportunistic: on a slow runner the relay can finish
  // this small file before WebRTC connects. link_test.go covers the switch.
  const reports = senderLog.split('\n').flatMap((line) => {
    try { const value = JSON.parse(line); return value.transport ? [value] : []; } catch { return []; }
  });
  assert.equal(reports.length, 1, 'sender did not report actual transport bytes');
  const direct = reports[0].directBytes > 0;
  console.log(`sender ${direct ? 'carried encrypted records directly' : 'finished on the relay'}: ${reports[0].directBytes} direct, ${reports[0].relayBytes} relay bytes`);
  assert.deepEqual(Uint8Array.from(received), source);
  await verifyFolderBundle(context);
  if (!hosted) await verifyPeerRegistrationBurst(port);
  console.log(`verified ${received.byteLength} exact bytes through CLI, Worker, encryption, flow control, and receiver`);
} finally {
  await browser?.close();
  await stopChild(sender);
  await stopChild(worker);
  await rm(work, { recursive: true, force: true });
}

// A folder plus a file go out detached under one code; pasting the link into
// the home page's Receive box downloads each file on its own, in place.
async function verifyFolderBundle(context) {
  const folder = join(work, 'bundle folder');
  await mkdir(join(folder, 'nested'), { recursive: true });
  await writeFile(join(folder, 'nested', 'a.bin'), source);
  await writeFile(join(work, 'extra.txt'), 'extra');
  await mkdir(join(folder, 'x'), { recursive: true });
  await mkdir(join(folder, 'y'), { recursive: true });
  const collisionFiles = {
    'x/a.txt': 'first collision payload',
    'y/a.txt': 'second collision payload',
    'bundle folder_x_a.txt': 'reserved basename payload'
  };
  for (const [path, bytes] of Object.entries(collisionFiles)) await writeFile(join(folder, path), bytes);
  const bundleSender = spawn(executable, ['send', '--link', folder, join(work, 'extra.txt')], {
    env: { ...process.env, CD_RELAY_URL: relayBase, CD_PUBLIC_URL: publicBase, CD_STATE_DIR: join(work, 'state') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const bundleLink = await firstLine(bundleSender.stdout);
  assert.equal(await new Promise((resolve) => bundleSender.once('exit', resolve)), 0, 'detached bundle send did not exit 0');
  const page = await context.newPage();
  await page.goto(publicBase);
  await page.locator('#receive-mode-btn').click();
  const downloads = [];
  const onDownload = (download) => downloads.push(download);
  page.on('download', onDownload);
  await page.locator('#code-input').fill(bundleLink);
  for (let waited = 0; downloads.length < 5 && waited < 300; waited += 1) await page.waitForTimeout(100);
  page.off('download', onDownload);
  assert.deepEqual(downloads.map((download) => download.suggestedFilename()).sort(), ['a.bin', 'bundle folder_x_a (2).txt', 'bundle folder_x_a.txt', 'bundle folder_y_a.txt', 'extra.txt'], 'folder send did not arrive as separate files');
  const nested = downloads.find((download) => download.suggestedFilename() === 'a.bin');
  const nestedPath = join(work, 'received-a.bin');
  await nested.saveAs(nestedPath);
  assert.deepEqual(await readFile(nestedPath), Buffer.from(source), 'nested file differs from the original');
  const expectedCollisions = {
    'bundle folder_x_a (2).txt': 'first collision payload',
    'bundle folder_y_a.txt': 'second collision payload',
    'bundle folder_x_a.txt': 'reserved basename payload'
  };
  for (const [name, contents] of Object.entries(expectedCollisions)) {
    const download = downloads.find((download) => download.suggestedFilename() === name);
    assert.equal((await readFile(await download.path())).toString(), contents, name);
  }
  assert.equal(new URL(page.url()).pathname, '/', 'receiving left the home page');
  await page.close();
  console.log(`verified a folder send arrived as ${downloads.length} separate files in the browser`);
}

async function assertVisibleBrand(page) {
  assert.equal(await page.locator('.brand-lockup h1').textContent(), 'cd');
  // Watermark shows the actual host under test (prod, cd-test, or local dev).
  const expectedHost = new URL(publicBase).host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(await page.locator('.watermark').textContent(), new RegExp(expectedHost));
  assert.match(await page.locator('.share-description').textContent(), /handed to you through CD/);
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

async function verifyPeerSignaling(port) {
  const senderID = 'cd-EEEEEEEEEEEEEEEEEEEEEE';
  const receiverID = 'cd-r-FFFFFFFFFFFFFFFFFFFFFF';
  const urlFor = (id) => `ws://127.0.0.1:${port}/peerjs/peerjs?key=peerjs&id=${id}&token=test&version=1.5.5`;
  const sender = await connectPeer(urlFor(senderID));
  const receiver = await connectPeer(urlFor(receiverID));
  const offer = { type: 'OFFER', src: 'forged-sender', dst: senderID, payload: { connectionId: 'dc_test', type: 'data' } };
  receiver.send(JSON.stringify(offer));
  assert.deepEqual(await nextJSON(sender), { ...offer, src: receiverID });

  const duplicate = new WebSocket(urlFor(senderID));
  assert.deepEqual(await nextJSON(duplicate), { type: 'ID-TAKEN' });

  const leave = nextJSON(sender);
  receiver.close(1000, 'test complete');
  assert.deepEqual(await leave, { type: 'LEAVE', src: receiverID });
  sender.close(1000, 'test complete');

  for (const [index, invalid] of [null, [], 42, 'signal', {}, { type: 'OFFER', dst: '../bad' }].entries()) {
    await expectClose(urlFor(`invalid-${index}`), invalid, 4400);
  }
}

async function verifyPeerRegistrationBurst(port) {
  // Both endpoints can share one public IP. Repeated quick handoffs must not
  // exhaust the signaling allowance while the stricter relay guard stays put.
  for (let index = 0; index < 40; index += 1) {
    const id = `burst-${index}`;
    const socket = await connectPeer(`ws://127.0.0.1:${port}/peerjs/peerjs?key=peerjs&id=${id}&token=test&version=1.5.5`);
    socket.close(1000, 'test complete');
  }
  console.log('verified 40 signaling registrations from one IP');
}

async function connectPeer(url) {
  const socket = new WebSocket(url);
  assert.deepEqual(await nextJSON(socket), { type: 'OPEN' });
  return socket;
}

function nextJSON(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for signaling message')), 5000);
    socket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      try { resolve(JSON.parse(event.data)); } catch (error) { reject(error); }
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('signaling socket failed'));
    }, { once: true });
  });
}

function availablePort() {
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

async function runCapture(command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = collect(child.stdout);
  const stderr = collect(child.stderr);
  const code = await childExit(child);
  return { code, stdout: await stdout, stderr: await stderr };
}

function childExit(child) {
  return withTimeout(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  }), 120_000, 'child process did not exit');
}

function expectClose(url, joinMessage, expectedCode) {
  let socket;
  const result = new Promise((resolve, reject) => {
    socket = new WebSocket(url);
    socket.addEventListener('open', () => socket.send(JSON.stringify(joinMessage)));
    socket.addEventListener('close', (event) => {
      try { assert.equal(event.code, expectedCode); resolve(); } catch (error) { reject(error); }
    });
    socket.addEventListener('error', () => {});
  });
  return withTimeout(result, 5000, `relay did not close with ${expectedCode}`).finally(() => socket?.close());
}

function connectAndClose(url, joinMessage) {
  let socket;
  const result = new Promise((resolve, reject) => {
    socket = new WebSocket(url);
    let accepted = false;
    socket.addEventListener('open', () => socket.send(JSON.stringify(joinMessage)));
    socket.addEventListener('message', (event) => {
      const value = JSON.parse(event.data);
      if (value.type !== 'accepted') { reject(new Error(`unexpected relay event ${value.type}`)); return; }
      accepted = true;
      socket.close(1000, 'test disconnect');
    });
    socket.addEventListener('close', () => accepted ? resolve() : reject(new Error('test sender was not admitted')));
    socket.addEventListener('error', () => {});
  });
  return withTimeout(result, 15_000, 'relay admission did not finish').finally(() => socket?.close());
}

async function expectSilentTimeout(url) {
  const sockets = Array.from({ length: 3 }, () => {
    const socket = new WebSocket(url);
    socket.addEventListener('error', () => {});
    const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
    return { socket, closed };
  });
  await withTimeout(Promise.all(sockets.map(({ closed }) => closed)), 25_000, 'silent relay sockets stayed open');
  assert.ok(sockets.every(({ socket }) => socket.readyState === WebSocket.CLOSED), 'silent relay sockets did not close cleanly');
  await connectAndClose(url, {
    type: 'join', protocol: 'cd-transfer-v1', role: 'sender', receiverTokenHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  });
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
