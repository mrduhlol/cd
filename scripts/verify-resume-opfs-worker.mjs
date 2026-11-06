// Real dedicated-worker failure and same-page recovery against native OPFS/IDB.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { findChromium } from './harness.mjs';

const names = ['resume-browser', 'agent-protocol', 'resume-protocol', 'incremental-sha256', 'resume-retention', 'sink', 'resume-opfs', 'resume-opfs-worker'];
const sources = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(`src/${name}.js`, 'utf8')])));
const browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
try {
  const page = await browser.newPage();
  let crashWorker = true;
  await page.route('http://127.0.0.1/opfs-check', route => route.fulfill({ contentType: 'text/html', body: '' }));
  await page.route(/\/src\/[a-z0-9-]+\.js$/, route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1).slice(0, -3);
    let body = sources[name];
    if (name === 'resume-opfs-worker' && crashWorker) {
      // Acquires a real lock and flushes real bytes, then crashes before replying.
      body = `self.onmessage = async ({ data }) => {
        const handle = await data.file.createSyncAccessHandle();
        self.postMessage({ ok: true });
        self.onmessage = ({ data }) => {
          handle.write(data.bytes, { at: data.offset });
          handle.flush();
          throw new Error('Simulated OPFS worker crash after flush');
        };
      };`;
    }
    assert.ok(body, `unexpected module ${name}`);
    return route.fulfill({ contentType: 'text/javascript', body });
  });
  await page.goto('http://127.0.0.1/opfs-check');
  const interrupted = await page.evaluate(async () => {
    const module = await import('/src/resume-browser.js');
    const { IncrementalSHA256 } = await import('/src/incremental-sha256.js');
    const db = await module.openResumeDatabase();
    const checkpoints = module.createResumeKV(db, 'checkpoints'), secrets = module.createResumeKV(db, 'secrets');
    const id = crypto.getRandomValues(new Uint8Array(16)), key = crypto.getRandomValues(new Uint8Array(32));
    const rootId = [...id].map(byte => String.fromCharCode(byte)).join('');
    const root = btoa(rootId).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const bytes = Uint8Array.from({ length: module.RESUME_CHUNK_SIZE + 19 }, (_, i) => i % 251);
    const offer = { name: 'worker-crash.bin', size: String(bytes.length), chunkSize: module.RESUME_CHUNK_SIZE, wholeSha256: new IncrementalSHA256().update(bytes).digestHex(), expiresAt: Date.now() + 60_000 };
    const options = { invitation: { id, key }, rootId: root, offer, checkpoints, secrets };
    const stage = await module.createReceiverStage(options);
    await stage.bindSession('A'.repeat(43));
    let message;
    try { await stage.append(bytes.subarray(0, module.RESUME_CHUNK_SIZE), 'A'.repeat(43)); }
    catch (error) { message = error.message; }
    if (!message?.includes('Simulated OPFS worker crash')) throw new Error(`Expected worker crash, received ${message}`);
    const checkpoint = await checkpoints.get(`receiver:${root}`);
    if (checkpoint.offset !== 0 || stage.currentOffset !== 0) throw new Error('Failed worker advanced checkpoint');
    await stage.release();
    window.recovery = { module, options, bytes, stage, db };
    return { error: message, checkpointOffset: checkpoint.offset };
  });
  crashWorker = false;
  const recovered = await page.evaluate(async () => {
    const { module, options, bytes, stage: prior, db } = recovery;
    // Same page, same file and checkpoint. No navigation releases the old lock.
    const stage = await module.createReceiverStage(options);
    if (stage.offset !== 0) throw new Error('Recovered an uncheckpointed prefix');
    const directory = await navigator.storage.getDirectory();
    const handle = await directory.getFileHandle(prior.stagingId);
    if ((await handle.getFile()).size !== 0) throw new Error('Uncheckpointed tail was not truncated');
    await stage.append(bytes.subarray(0, module.RESUME_CHUNK_SIZE), 'B'.repeat(43));
    await stage.append(bytes.subarray(module.RESUME_CHUNK_SIZE), 'B'.repeat(43));
    const file = await stage.finish();
    const actual = new Uint8Array(await file.arrayBuffer());
    if (actual.length !== bytes.length || actual.some((byte, i) => byte !== bytes[i])) throw new Error('Recovered bytes differ');
    await stage.cancel();
    db.close();
    return { bytes: actual.length, offset: stage.offset, verified: true };
  });
  assert.equal(recovered.bytes, 256 * 1024 + 19);
  console.log(JSON.stringify({ interrupted, recovered, chromium: browser.version() }, null, 2));
} finally { await browser.close(); }
