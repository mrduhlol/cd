import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import { startWorker, findChromium } from './harness.mjs';

const work = await mkdtemp(join(tmpdir(), 'cd-large-selection-'));
let worker, browser;
try {
  const files = [];
  for (const [index, gib] of [5, 5, 3].entries()) {
    const path = join(work, `recording-${index}.mkv`);
    const file = await open(path, 'wx');
    try { await file.truncate(gib * 1024 ** 3); } finally { await file.close(); }
    files.push(path);
  }
  worker = await startWorker(work);
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(worker.publicBase);
  await page.locator('#file-input').setInputFiles(files);
  await page.waitForFunction(() => /^\d{5}$/.test(document.getElementById('share-code').textContent), null, { timeout: 15_000 });
  assert.match(await page.locator('#receive-command').textContent(), /^cdx receive \d{5}$/);
  assert.equal(await page.locator('#sender-error').isVisible(), false);
  console.log('Three 13 GiB sparse files selected in Chromium: live numeric code and receive command displayed before payload reads');
} finally {
  await browser?.close();
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
