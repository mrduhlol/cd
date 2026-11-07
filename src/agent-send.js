import { mountRelaySender } from './relay-sender.js';
import './style.css';

// Standalone browser sender for the agent relay: picks one file, mints a
// share link, and streams it with the same encrypted records `cdx send`
// uses, so `cdx receive <link>` (or another browser on the share page) can
// take it. The send engine lives in relay-sender.js, shared with the unified
// CD hub.

document.body.innerHTML = `
  <canvas id="ambient-dots" class="ambient-dots" aria-hidden="true"></canvas>
  <main class="shell share-transfer-page">
    <header class="brand-rail">
      <div class="brand-lockup"><h1>cd</h1><span class="tagline">/di·rect/</span></div>
      <p class="brand-note">send to a terminal</p>
      <p class="share-description">Pick a file to hand it to <code>cdx receive</code> or another browser.</p>
    </header>
    <section class="workbench">
      <div class="share-panel">
        <span class="panel-kicker">terminal send</span>
        <div id="pick-row">
          <input id="file-input" type="file" hidden />
          <button id="pick-btn" class="primary-btn" type="button">Choose a file</button>
        </div>
        <p id="file-line" class="status" role="status">No file chosen yet.</p>
        <div id="share-box" class="terminal-share" hidden>
          <span class="panel-kicker">share this code</span>
          <strong id="share-code"></strong>
          <p class="code-help">On the other device, choose Receive and enter this code — or run the command below in a terminal.</p>
          <code id="receive-command"></code>
          <div class="result-actions">
            <button id="copy-code-btn" class="secondary-btn" type="button">Copy code</button>
            <button id="copy-cmd-btn" class="secondary-btn" type="button">Copy receive command</button>
          </div>
          <span class="panel-kicker">or share the link</span>
          <strong id="share-link"></strong>
          <div class="result-actions">
            <button id="copy-link-btn" class="secondary-btn" type="button">Copy link</button>
          </div>
        </div>
        <div id="send-progress" class="agent-progress" hidden>
          <div class="progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="progress-fill"></div>
          </div>
          <span id="progress-copy">0%</span>
        </div>
        <p id="status" class="status" role="status"></p>
        <div class="result-actions">
          <button id="cancel-btn" class="secondary-btn" type="button" hidden>Cancel</button>
          <button id="again-btn" class="primary-btn" type="button" hidden>Send another file</button>
        </div>
      </div>
    </section>
    <p class="watermark">encrypted in your browser · <a href="/">cd.yash0.in</a></p>
  </main>`;

const elements = {
  fileInput: document.getElementById('file-input'),
  pickBtn: document.getElementById('pick-btn'),
  fileLine: document.getElementById('file-line'),
  shareBox: document.getElementById('share-box'),
  shareCode: document.getElementById('share-code'),
  shareLink: document.getElementById('share-link'),
  receiveCommand: document.getElementById('receive-command'),
  copyCodeBtn: document.getElementById('copy-code-btn'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  copyCmdBtn: document.getElementById('copy-cmd-btn'),
  progress: document.getElementById('send-progress'),
  progressBar: document.querySelector('#send-progress .progress-bar'),
  progressFill: document.querySelector('#send-progress .progress-fill'),
  progressCopy: document.getElementById('progress-copy'),
  status: document.getElementById('status'),
  cancelBtn: document.getElementById('cancel-btn'),
  againBtn: document.getElementById('again-btn')
};

try {
  const mark = document.querySelector('.share-transfer-page .watermark a');
  if (mark) mark.textContent = window.location.host;
} catch { /* cosmetic only */ }

mountRelaySender(elements);
