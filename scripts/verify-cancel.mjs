// Browser regression for cancellation while receiver sink initialization is pending.
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const baseUrl = process.env.CD_VERIFY_URL;
if (!baseUrl) throw new Error('Set CD_VERIFY_URL to a running cd instance');
const chromiumPath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const work = await mkdtemp(join(tmpdir(), 'cd-verify-cancel-'));
const sourcePath = join(work, 'cancel.bin');
await writeFile(sourcePath, Buffer.alloc(128 * 1024, 23));
const browser = await chromium.launch({ executablePath: chromiumPath, headless: true });
const context = await browser.newContext({ acceptDownloads: true });
await context.addInitScript(() => {
  delete window.showSaveFilePicker;
  const original = navigator.storage.getDirectory.bind(navigator.storage);
  let release;
  const writable = {
    async write() {}, async close() {}, async abort() {}
  };
  const root = {
    async getFileHandle() {
      return { async createWritable() { return writable; }, async getFile() { return new Blob(); } };
    },
    async removeEntry() { window.__opfsRemoved = true; }
  };
  window.__restoreOPFS = () => { navigator.storage.getDirectory = original; };
  navigator.storage.getDirectory = () => {
    window.__opfsPending = true;
    return new Promise((resolve) => { release = () => resolve(root); window.__releaseOPFS = release; });
  };
});
try {
  const sender = await context.newPage();
  const receiver = await context.newPage();
  await sender.goto(baseUrl);
  await sender.locator('.workbench:not([inert])').waitFor();
  await sender.locator('#file-input').setInputFiles(sourcePath);
  await sender.locator('#start-share-btn').click();
  await sender.locator('#sender-code-section:not(.hidden)').waitFor();
  const code = (await sender.locator('#share-code').textContent()).trim();
  await receiver.goto(baseUrl);
  await receiver.locator('.workbench:not([inert])').waitFor();
  await receiver.locator('#receive-mode-btn').click();
  await receiver.locator('#code-input').fill(code);
  await receiver.locator('#connect-btn').click();
  await receiver.locator('#receiver-consent:not(.hidden)').waitFor();
  await receiver.locator('#consent-accept-btn').click();
  await receiver.waitForFunction(() => window.__opfsPending === true);
  await receiver.locator('#receiver-cancel-btn').click();
  await receiver.evaluate(() => window.__releaseOPFS?.());
  await receiver.waitForFunction(() => window.__opfsRemoved === true);
  await receiver.evaluate(() => window.__restoreOPFS?.());
  await receiver.locator('#receiver-input-section:not(.hidden)').waitFor();
  assert.equal(await receiver.locator('#receiver-error').isVisible(), false);
  console.log('verified receiver cancellation during sink initialization');

  // The canceled async continuation must not install its late sink into the
  // next transfer. Restore OPFS and complete an exact-bytes transfer in the
  // same receiver page to catch that stale-state regression.
  await receiver.evaluate(() => window.__restoreOPFS?.());
  const sender2 = await context.newPage();
  await sender2.goto(baseUrl);
  await sender2.locator('.workbench:not([inert])').waitFor();
  await sender2.locator('#file-input').setInputFiles(sourcePath);
  await sender2.locator('#start-share-btn').click();
  await sender2.locator('#sender-code-section:not(.hidden)').waitFor();
  const code2 = (await sender2.locator('#share-code').textContent()).trim();
  await receiver.locator('#code-input').fill(code2);
  const downloadEvent = receiver.waitForEvent('download', { timeout: 120_000 });
  downloadEvent.catch(() => {});
  await receiver.locator('#connect-btn').click();
  await receiver.locator('#receiver-consent:not(.hidden)').waitFor({ timeout: 120_000 });
  await receiver.locator('#consent-accept-btn').click();
  await receiver.locator('#receiver-complete:not(.hidden)').waitFor({ timeout: 120_000 });
  const download = await downloadEvent;
  const receivedPath = join(work, 'received.bin');
  await download.saveAs(receivedPath);
  assert.deepEqual(await readFile(receivedPath), await readFile(sourcePath));
  console.log('verified exact bytes after canceled transfer');
} finally {
  await context.close();
  await browser.close();
  await rm(work, { recursive: true, force: true });
}
