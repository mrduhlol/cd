// Regression check for publishing a sender code only after PeerJS registration.
// The signaling server's OPEN frame is held until after file selection; the
// share panel must remain hidden until that frame is released to the page.
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';

const baseUrl = process.env.CD_VERIFY_URL;
if (!baseUrl) throw new Error('Set CD_VERIFY_URL to a running cd instance');

const chromiumPath = await findChromium();
const work = await mkdtemp(join(tmpdir(), 'cd-verify-sender-ready-'));
const sourcePath = join(work, 'sender-ready.txt');
await writeFile(sourcePath, 'sender readiness regression');

let browser;
try {
  browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--disable-dev-shm-usage']
  });
  const context = await browser.newContext();
  let openSeen;
  let markOpenSeen;
  let deliverOpen;
  openSeen = new Promise((resolve) => {
    markOpenSeen = resolve;
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.routeWebSocket((url) => url.pathname.includes('/peerjs/'), (webSocket) => {
    const server = webSocket.connectToServer();
    server.onMessage((message) => {
      const parsed = JSON.parse(String(message));
      if (parsed.type === 'OPEN') {
        deliverOpen = () => webSocket.send(message);
        markOpenSeen();
        return;
      }
      webSocket.send(message);
    });
  });

  await page.goto(baseUrl);
  await page.locator('.workbench:not([inert])').waitFor();
  await page.locator('#file-input').setInputFiles(sourcePath);
  // Staging alone shares nothing: the code waits for Send, then for OPEN.
  assert.equal(await page.locator('#sender-code-section').isVisible(), false);
  await page.locator('#start-share-btn:not(.hidden)').click();
  await openSeen;

  assert.equal(await page.locator('#sender-code-section').isVisible(), false);
  assert.equal(await page.locator('#sender-code-section').evaluate((element) => element.classList.contains('hidden')), true);

  deliverOpen?.();
  await page.locator('#sender-code-section:not(.hidden)').waitFor();
  assert.equal(await page.locator('#sender-code-section').isVisible(), true);
  assert.match((await page.locator('#share-code').textContent()).trim(), /^[A-Z2-9]{5}$/);
  console.log('verified sender code waits for PeerJS registration OPEN');
  await context.close();
} finally {
  await browser?.close();
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
  throw new Error('Chromium was not found; set CHROMIUM_PATH to run the sender readiness check');
}
