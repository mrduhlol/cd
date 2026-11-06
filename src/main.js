import { cleanCode, codeFromUrl, generateEphemeralId, isValidCode, peerIdFor } from './p2p-code.js';
import { codeLookupPath, isShortCode, shortCodeFromInput, parseCapability, shareUrlFromCapability } from './agent-code.js';
import { startRelaySend } from './relay-sender.js';
import { createZipBundle, fileSource } from './zip-bundle.js';
import { startQrScanner } from './qr-scanner.js';
import { parseManifest } from './p2p-manifest.js';
import { generateTunnelCapability, openRelayTunnel, parseTunnelCapability } from './relay-tunnel.js';
import { openRawChannel, parseTransferOffer, receiveWindowFor } from './raw-channel.js';
import {
  DOWNLOAD_TOO_LARGE,
  createSink,
  createStageSink,
  detectCapabilities,
  selectSinkTier
} from './sink.js';

if ('serviceWorker' in navigator) {
  // Register after first paint/idle so the install never contends with app
  // boot (or an in-progress transfer) for bandwidth and CPU.
  const registerSw = () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline shell support is optional; transfers still work without it.
    });
  };
  const scheduleRegistration = () => warmUpOnIdle(registerSw);
  if (document.readyState === 'complete') scheduleRegistration();
  else window.addEventListener('load', scheduleRegistration, { once: true });
}

let qrCodeModulePromise;
let peerModulePromise;

function loadQrCode() {
  qrCodeModulePromise ??= import('qrcode')
    .then((module) => module.default || module)
    .catch((error) => {
      qrCodeModulePromise = undefined;
      throw error;
    });
  return qrCodeModulePromise;
}

function loadPeer() {
  // PeerJS is the heaviest dependency on this page. Loading it on demand
  // keeps first paint fast; transfers await it only when one starts.
  peerModulePromise ??= import('peerjs')
    .then((module) => module.Peer || module.default?.Peer || module.default)
    .catch((error) => {
      peerModulePromise = undefined;
      throw error;
    });
  return peerModulePromise;
}

function warmUpOnIdle(task) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(task, { timeout: 5000 });
  } else {
    setTimeout(task, 1500);
  }
}

// Fetch the QR renderer during idle so the share panel paints instantly after
// file selection instead of stalling on a dynamic import.
warmUpOnIdle(() => {
  loadQrCode().catch(() => {
    // Retried on demand when files are selected.
  });
});

const PROGRESS_UPDATE_INTERVAL = 120;
const CONNECTION_TIMEOUT_MS = 15000;
const MIN_PENDING_RECEIVE_BYTES = 8 * 1024 * 1024;
const SIGNALING_RETRY_LIMIT = 3;
const SIGNALING_RETRY_DELAY_MS = 300;

function isTemporarySignalingError(error) {
  return ['network', 'socket-error', 'socket-closed', 'server-error'].includes(error?.type);
}

function peerOptions() {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  // TURN-ready: set window.__CD_TURN_SERVERS__ to an array of RTCIceServer
  // before creating a transfer to relay through TURN (symmetric NAT/CGNAT).
  // STUN-only when unset.
  try {
    const injected = window.__CD_TURN_SERVERS__;
    if (Array.isArray(injected) && injected.length > 0) iceServers.push(...injected);
  } catch { /* STUN-only fallback */ }
  return {
    host: window.location.hostname,
    port: window.location.port ? Number(window.location.port) : window.location.protocol === 'https:' ? 443 : 80,
    path: '/peerjs/',
    secure: window.location.protocol === 'https:',
    key: 'peerjs',
    debug: 0,
    config: { iceServers },
  };
}

// Agent-relay links (from `cdx send` or a browser terminal-send) look like
// https://cd.yash0.in/s/<22 chars>#v1.<43 chars>. The room lives on the
// sender's origin, so receivers open the pasted link as-is instead of
// treating it as a P2P word code.
const AGENT_LINK_PATH = /^\/s\/([A-Za-z0-9_-]{22})\/?$/;
const AGENT_LINK_KEY = /^v1\.([A-Za-z0-9_-]{43})$/;
const RESUME_LINK_KEY = /^v2\.([A-Za-z0-9_-]{43})$/;
const AGENT_BARE_CODE = /^([A-Za-z0-9_-]{22})#v1\.([A-Za-z0-9_-]{43})$/;

function agentShareUrlFromInput(value) {
  const raw = String(value ?? '').trim();
  if (!raw || (!raw.includes('#v1.') && !raw.includes('#v2.'))) return '';
  const candidates = [raw];
  for (const token of raw.split(/[\s"'<>]+/)) {
    if (token && token !== raw) candidates.push(token);
  }
  for (const candidate of candidates) {
    const bare = AGENT_BARE_CODE.exec(candidate);
    if (bare) return `${window.location.origin}/s/${bare[1]}#v1.${bare[2]}`;
    try {
      const url = new URL(candidate, window.location.href);
      // Only web links: `javascript:/s/...` would otherwise pass the path check.
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      const path = AGENT_LINK_PATH.exec(url.pathname);
      const key = AGENT_LINK_KEY.exec(url.hash.slice(1));
      const resumeKey = RESUME_LINK_KEY.exec(url.hash.slice(1));
      if (path && (key || resumeKey)) return url.toString();
    } catch { /* Not a URL; try the next candidate. */ }
  }
  return '';
}

const els = {
  appState: document.getElementById('app-state'),
  sendModeBtn: document.getElementById('send-mode-btn'),
  receiveModeBtn: document.getElementById('receive-mode-btn'),
  senderView: document.getElementById('sender-view'),
  receiverView: document.getElementById('receiver-view'),
  dropZone: document.getElementById('drop-zone'),
  fileInput: document.getElementById('file-input'),
  selectFileBtn: document.getElementById('select-file-btn'),
  senderFileInfo: document.getElementById('sender-file-info'),
  senderCodeSection: document.getElementById('sender-code-section'),
  shareCode: document.getElementById('share-code'),
  sharePrivateLink: document.getElementById('share-private-link'),
  shareCodeKicker: document.getElementById('share-code-kicker'),
  resumableCheck: document.getElementById('resumable-check'),
  resumeLinkInput: document.getElementById('resume-link-input'),
  shareQr: document.getElementById('share-qr'),
  copyCodeBtn: document.getElementById('copy-code-btn'),
  copyLinkBtn: document.getElementById('copy-link-btn'),
  senderStatus: document.getElementById('sender-status'),
  senderProgress: document.getElementById('sender-progress'),
  senderCancelBtn: document.getElementById('sender-cancel-btn'),
  senderError: document.getElementById('sender-error'),
  senderErrorMessage: document.querySelector('#sender-error .error-message'),
  senderRetryBtn: document.getElementById('sender-retry-btn'),
  receiveCommand: document.getElementById('receive-command'),
  copyCmdBtn: document.getElementById('copy-cmd-btn'),
  senderComplete: document.getElementById('sender-complete'),
  senderCompleteMessage: document.getElementById('sender-complete-message'),
  senderCompleteDetail: document.getElementById('sender-complete-detail'),
  sendAnotherBtn: document.getElementById('send-another-btn'),
  receiverInputSection: document.getElementById('receiver-input-section'),
  codeInput: document.getElementById('code-input'),
  connectBtn: document.getElementById('connect-btn'),
  scanQrBtn: document.getElementById('scan-qr-btn'),
  stopScanBtn: document.getElementById('stop-scan-btn'),
  scannerStatus: document.getElementById('scanner-status'),
  qrReader: document.getElementById('qr-reader'),
  qrVideo: document.getElementById('qr-video'),
  scannerLive: document.getElementById('scanner-live'),
  receiverConnecting: document.getElementById('receiver-connecting'),
  receiverConnectingCancelBtn: document.getElementById('receiver-connecting-cancel-btn'),
  receiverFileInfo: document.getElementById('receiver-file-info'),
  receiverProgress: document.getElementById('receiver-progress'),
  receiverCancelBtn: document.getElementById('receiver-cancel-btn'),
  receiverComplete: document.getElementById('receiver-complete'),
  receiverCompleteMessage: document.getElementById('receiver-complete-message'),
  receiverCompleteDetail: document.getElementById('receiver-complete-detail'),
  receiverError: document.getElementById('receiver-error'),
  retryBtn: document.getElementById('retry-btn'),
  receiveAnotherBtn: document.getElementById('receive-another-btn'),
  receiverRelay: document.getElementById('receiver-relay'),
  receiverRelayPanel: document.getElementById('receiver-relay-panel'),
  relayDoneBtn: document.getElementById('relay-done-btn')
};

const STATE_LABELS = {
  idle: 'ready',
  connecting: 'connecting',
  waiting: 'waiting for receiver',
  transferring: 'transferring',
  saving: 'saving',
  complete: 'done',
  failed: 'failed'
};
// Closing the tab mid-transfer kills it, so the browser asks first.
const BUSY_STATES = new Set(['connecting', 'waiting', 'transferring', 'saving']);
const BASE_TITLE = document.title;

function setState(state) {
  els.appState.textContent = STATE_LABELS[state] || state;
  els.appState.dataset.state = state;
  if (state === 'complete') document.title = `Done · ${BASE_TITLE}`;
  else if (state === 'failed') document.title = `Failed · ${BASE_TITLE}`;
  else if (state !== 'transferring') document.title = BASE_TITLE;
}

window.addEventListener('beforeunload', (event) => {
  if (BUSY_STATES.has(els.appState.dataset.state)) event.preventDefault();
});

// shortenMiddle keeps both ends of a long filename, where the extension and
// the distinguishing suffix usually are.
function shortenMiddle(text, max = 32) {
  if (text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep / 2))}…${text.slice(-Math.floor(keep / 2))}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

async function copyText(text, button, doneLabel) {
  const original = button.textContent;
  await navigator.clipboard.writeText(text);
  button.textContent = doneLabel;
  button.classList.add('copied');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('copied');
  }, 1400);
}

function setFileInfo(container, title, size, subtitle) {
  container.querySelector('.file-name').textContent = title;
  container.querySelector('.file-size').textContent = size;
  container.querySelector('.file-subtext').textContent = subtitle || '';
  container.classList.remove('hidden');
}
// Progress DOM nodes are cached per container: updateProgress runs on every
// throttled tick during a transfer, so re-querying the DOM each time is pure
// overhead on the hot path.
const progressRefs = new WeakMap();

function refsForProgress(container) {
  let refs = progressRefs.get(container);
  if (!refs) {
    refs = {
      fill: container.querySelector('.progress-fill'),
      bar: container.querySelector('.progress-bar'),
      percent: container.querySelector('.progress-percent'),
      speed: container.querySelector('.progress-speed'),
      transferred: container.querySelector('.progress-transferred'),
      eta: container.querySelector('.progress-eta'),
      emaSpeed: 0
    };
    progressRefs.set(container, refs);
  }
  return refs;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function resetProgress(container) {
  const refs = refsForProgress(container);
  refs.emaSpeed = 0;
  refs.fill.style.transform = 'scaleX(0)';
  refs.bar.setAttribute('aria-valuenow', '0');
  refs.percent.textContent = '0%';
  refs.speed.textContent = '–';
  refs.transferred.textContent = '–';
  if (refs.eta) refs.eta.textContent = '–';
}

function updateProgress(container, bytes, total, startedAt, force, lastUpdateRef) {
  if (!startedAt) return lastUpdateRef.value;

  const now = performance.now();
  if (!force && now - lastUpdateRef.value < PROGRESS_UPDATE_INTERVAL) {
    return lastUpdateRef.value;
  }

  const refs = refsForProgress(container);
  const percent = total === 0 ? 100 : Math.min((bytes / total) * 100, 100);
  const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
  const instantSpeed = bytes / elapsed;
  // Exponential moving average: per-chunk timing is noisy, and a flickering
  // speed readout makes the transfer feel slower than it is.
  refs.emaSpeed = refs.emaSpeed === 0 ? instantSpeed : refs.emaSpeed * 0.7 + instantSpeed * 0.3;

  // transform (not width) keeps the bar animation on the compositor thread.
  refs.fill.style.transform = `scaleX(${percent / 100})`;
  refs.bar.style.setProperty('--progress', `${percent}%`);
  refs.bar.setAttribute('aria-valuenow', percent.toFixed(1));
  refs.percent.textContent = `${percent.toFixed(1)}%`;
  document.title = `${Math.floor(percent)}% · ${BASE_TITLE}`;
  // No speed until bytes move: "0 B/s" while connecting reads as a stall.
  refs.speed.textContent = bytes > 0 ? `${formatSize(refs.emaSpeed)}/s` : '–';
  refs.transferred.textContent = `${formatSize(bytes)} / ${formatSize(total)}`;
  if (refs.eta) {
    refs.eta.textContent = bytes >= total || refs.emaSpeed <= 0 ? '–' : formatEta((total - bytes) / refs.emaSpeed);
  }

  return now;
}

// Browser sends go through the relay with the same protocol as `cdx send`,
// so one numeric code works in any browser Receive box and in
// `cdx receive`. Several files travel as one .zip that receivers unpack.
const Sender = (() => {
  let active = null;
  let files = [];
  let share = null;
  let totalSize = 0;
  let generation = 0;
  let startedAt = 0;
  const lastProgressUpdate = { value: 0 };

  function init(selectedFiles) {
    // reset() clears the form for a fresh send, so preserve a pasted private
    // resume link across that reset before deciding which sender path to use.
    const resumeLink = els.resumeLinkInput.value.trim();
    reset();
    els.resumeLinkInput.value = resumeLink;
    files = selectedFiles.filter(Boolean);
    if (files.length === 0) return;
    totalSize = files.reduce((sum, item) => sum + item.size, 0);

    const resumable = els.resumableCheck.checked || resumeLink.length > 0;
    if (resumable && files.length !== 1) {
      failSend('Resumable sends currently support one named file. Choose one file and try again.');
      return;
    }

    let source;
    try {
      source = files.length === 1 ? fileSource(files[0]) : createZipBundle(files);
    } catch {
      setFileInfo(els.senderFileInfo, `${files.length} files selected`, formatSize(totalSize), 'Together these are over 4 GB. Send them in smaller batches.');
      setState('failed');
      return;
    }
    els.dropZone.classList.add('hidden');
    renderSelectionSummary(source);

    const current = ++generation;
    const hooks = {
      onShare(value) {
        if (current !== generation) return;
        share = value;
        const isResume = value.resumable === true;
        els.shareCode.textContent = isResume ? 'Private link only' : value.code;
        els.sharePrivateLink.hidden = !isResume;
        els.sharePrivateLink.href = isResume ? value.url : '';
        els.sharePrivateLink.textContent = isResume ? value.url : '';
        els.shareCodeKicker.textContent = isResume ? 'share this private link' : 'share this code';
        els.receiveCommand.hidden = isResume;
        els.copyCodeBtn.hidden = isResume;
        els.copyCmdBtn.hidden = isResume;
        if (!isResume) els.receiveCommand.textContent = `cdx receive ${value.code}`;
        els.senderCodeSection.classList.remove('hidden');
        void renderQr(value.url, current);
      },
      onState(state) {
        if (current !== generation) return;
        if (state === 'transferring' && !startedAt) {
          startedAt = Date.now();
          els.senderCodeSection.classList.add('hidden');
          els.senderProgress.classList.remove('hidden');
        }
        if (state !== 'complete') setState(state);
      },
      onStatus(text) {
        if (current === generation) els.senderStatus.textContent = text;
      },
      onProgress(done, total) {
        if (current !== generation) return;
        lastProgressUpdate.value = updateProgress(els.senderProgress, done, total, startedAt || Date.now(), done === total, lastProgressUpdate);
      }
    };
    if (resumable) {
      startedAt = Date.now();
      els.senderProgress.classList.remove('hidden');
      setState('connecting');
      void (async () => {
        try {
          const { openResumeDatabase, createResumeKV, cleanExpiredResumeRecords, startResumableSend } = await import('./resume-browser.js');
          const db = await openResumeDatabase();
          const checkpoints = createResumeKV(db, 'checkpoints');
          const secrets = createResumeKV(db, 'secrets');
          await cleanExpiredResumeRecords({ checkpoints, secrets, storage: navigator.storage });
          if (current !== generation) return;
          active = startResumableSend(files[0], {
            link: resumeLink, checkpoints, secrets,
            hooks: {
              onShare(value) { hooks.onShare({ ...value, resumable: true }); },
              onStatus: hooks.onStatus,
              onProgress(done, total) { hooks.onProgress(Number(done), Number(total)); },
              onError(error) { if (current === generation && error.message !== 'Transfer canceled.') failSend(error.message); }
            }
          });
          active.done.then(() => {
            if (current === generation) {
              active = null;
              showComplete();
            }
          }, (error) => {
            if (current === generation) {
              // A failed connection preserves resume authority. Resetting the
              // form must not cancel the settled transfer and delete it.
              active = null;
              if (error.message !== 'Transfer canceled.') failSend(error.message);
            }
          });
        } catch (error) {
          if (current === generation) failSend(error.message || 'This browser cannot keep resumable transfer data locally.');
        }
      })();
    } else {
      active = startRelaySend(source, hooks);
      active.done.then(() => {
        if (current === generation) showComplete();
      }, (error) => {
        if (current === generation && error.message !== 'Transfer canceled.') failSend(error.message);
      });
    }
  }

  function renderSelectionSummary(source) {
    if (files.length === 1) {
      setFileInfo(els.senderFileInfo, files[0].name, formatSize(files[0].size), '');
      return;
    }
    const previewNames = files.slice(0, 3).map((item) => item.name).join(', ');
    const remaining = files.length - 3;
    const suffix = remaining > 0 ? ` + ${remaining} more` : '';
    setFileInfo(els.senderFileInfo, `${files.length} files`, formatSize(totalSize), `${previewNames}${suffix} · arrives as ${source.name}`);
  }

  async function renderQr(url, current) {
    const QRCode = await loadQrCode().catch(() => null);
    if (!QRCode || current !== generation) return;
    // The QR holds the private link, so a phone camera opens the transfer
    // directly without typing anything.
    await QRCode.toCanvas(els.shareQr, url, {
      margin: 2,
      width: 220,
      color: { dark: '#0d0503', light: '#e4d4b6' }
    });
  }

  function showComplete() {
    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.add('hidden');
    els.senderFileInfo.classList.add('hidden');
    els.senderComplete.classList.remove('hidden');
    els.senderCompleteMessage.textContent = files.length === 1 ? 'Sent' : `Sent ${files.length} files`;
    els.senderCompleteDetail.textContent = files.length === 1
      ? `${shortenMiddle(files[0].name, 48)} · ${formatSize(totalSize)}`
      : formatSize(totalSize);
    setState('complete');
  }

  function failSend(message) {
    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.add('hidden');
    els.senderFileInfo.classList.add('hidden');
    els.senderErrorMessage.textContent = message;
    els.senderError.classList.remove('hidden');
    setState('failed');
  }

  function cancel() {
    reset();
    setState('idle');
  }

  function reset() {
    generation += 1;
    active?.cancel();
    active = null;
    files = [];
    share = null;
    totalSize = 0;
    startedAt = 0;
    lastProgressUpdate.value = 0;
    els.dropZone.classList.remove('hidden');
    els.senderFileInfo.classList.add('hidden');
    els.senderCodeSection.classList.add('hidden');
    els.senderProgress.classList.add('hidden');
    els.senderComplete.classList.add('hidden');
    els.senderError.classList.add('hidden');
    els.senderStatus.textContent = '';
    els.sharePrivateLink.hidden = true;
    els.sharePrivateLink.removeAttribute('href');
    els.shareCodeKicker.textContent = 'share this code';
    els.receiveCommand.hidden = false;
    els.copyCodeBtn.hidden = false;
    els.copyCmdBtn.hidden = false;
    els.resumeLinkInput.value = '';
    resetProgress(els.senderProgress);
  }

  return {
    init,
    reset,
    cancel,
    copyCode: () => share && copyText(share.code, els.copyCodeBtn, 'Copied'),
    copyLink: () => share && copyText(share.url, els.copyLinkBtn, 'Copied'),
    copyCommand: () => share && copyText(`cdx receive ${share.code}`, els.copyCmdBtn, 'Copied')
  };
})();

const Receiver = (() => {
  let peer = null;
  // `connection` is the committed transport: whichever of the data channel
  // or the relay tunnel delivered the sender's first message. Until then
  // both are candidates.
  let connection = null;
  let candidates = [];
  const lostCandidates = new Set();
  let manifest = null;
  let currentFile = null;
  let currentSink = null;
  let stageSink = null;
  let pendingDownloadUrls = [];
  const DOWNLOAD_URL_TTL_MS = 10 * 60 * 1000;
  let currentFileBytes = 0;
  let nextFileIndex = 0;
  let pickerPromise = null;
  let totalBytesReceived = 0;
  let transferStartTime = null;
  let transferComplete = false;
  let transferCancelled = false;
  let lastProgressAckAt = 0;
  let progressAckTimer = 0;
  let dataQueue = Promise.resolve();
  let pendingReceiveBytes = 0;
  // The window this receiver announces; pending input may reach it.
  const receiveWindow = receiveWindowFor(navigator.userAgent, navigator.userAgentData?.mobile);
  const maxPendingReceiveBytes = Math.max(MIN_PENDING_RECEIVE_BYTES, receiveWindow + 2 * 1024 * 1024);
  let transferGeneration = 0;
  let timeoutId = null;
  let lastArrivalAt = 0;
  let stallIntervalId = null;
  const lastProgressUpdate = { value: 0 };

  function connect(rawCode) {
    const agentUrl = agentShareUrlFromInput(rawCode);
    if (agentUrl) {
      openRelay(agentUrl);
      return;
    }
    const short = shortCodeFromInput(rawCode);
    const code = short || codeFromUrl(rawCode, window.location.href);
    if (!short && !isValidCode(code)) {
      els.scannerStatus.textContent = 'That isn’t a code. Codes are 5 digits, or paste the sender’s link.';
      els.codeInput.setAttribute('aria-invalid', 'true');
      els.codeInput.focus();
      return;
    }

    els.codeInput.removeAttribute('aria-invalid');
    void stopScanner();
    resetConnectionOnly();
    transferCancelled = false;
    const connectionGeneration = transferGeneration;
    els.receiverInputSection.classList.add('hidden');
    els.receiverConnecting.classList.remove('hidden');
    els.codeInput.value = code;
    setState('connecting');

    if (short) {
      void connectShortCode(connectionGeneration, code);
      return;
    }

    void establishPeer(connectionGeneration, code);

    timeoutId = setTimeout(() => {
      if (!connection) {
        showError('Connection timed out. Check the code and try again.');
      }
    }, CONNECTION_TIMEOUT_MS);
  }

  // Short numeric codes resolve through the relay directory to a transfer,
  // then open the relay receiver inline. Works for codes from `cdx send`
  // and the browser terminal-send page alike.
  async function connectShortCode(connectionGeneration, code) {
    let response;
    try {
      response = await fetch(codeLookupPath(code));
    } catch {
      if (connectionGeneration !== transferGeneration) return;
      showError('Could not reach CD. Check your connection and try again.');
      return;
    }
    if (connectionGeneration !== transferGeneration || transferCancelled) return;
    if (response.status === 404) {
      showError('No transfer with that code. Check the digits, or ask the sender for a new one.');
      return;
    }
    if (!response.ok) {
      showError('Connection failed. Try again.');
      return;
    }
    let capability;
    try {
      capability = parseCapability(await response.json());
    } catch {
      showError('No transfer with that code. Check the digits, or ask the sender for a new one.');
      return;
    }
    openRelay(shareUrlFromCapability(capability.origin ?? window.location.origin, capability.transferId, capability.key));
  }

  // Relay transfers (links and numeric codes) run inline in this tab. The
  // relay socket is same-origin, so links to another host still navigate.
  let stopRelay = null;
  let relayGeneration = 0;

  async function openRelay(url) {
    const target = new URL(url, window.location.href);
    if (target.origin !== window.location.origin) {
      if (target.protocol === 'https:' || target.protocol === 'http:') window.location.href = target.href;
      else showError('That isn’t a CD link.');
      return;
    }
    void stopScanner();
    clearTimeout(timeoutId);
    const generation = ++relayGeneration;
    els.codeInput.value = '';
    els.codeInput.removeAttribute('aria-invalid');
    els.receiverInputSection.classList.add('hidden');
    els.receiverConnecting.classList.remove('hidden');
    let mountRelayReceiver;
    try {
      ({ mountRelayReceiver } = await import('./share.js'));
    } catch {
      if (generation === relayGeneration) showError('Could not load the receiver. Check your connection and try again.');
      return;
    }
    if (generation !== relayGeneration) return;
    els.receiverConnecting.classList.add('hidden');
    els.receiverRelay.classList.remove('hidden');
    setState('idle');
    stopRelay = mountRelayReceiver(els.receiverRelayPanel, url, { autoReceive: true });
  }

  function closeRelay() {
    relayGeneration++;
    stopRelay?.();
    stopRelay = null;
    els.receiverRelay.classList.add('hidden');
    els.receiverRelayPanel.replaceChildren();
  }

  async function establishPeer(connectionGeneration, code, signalingRetries = 0) {
    const PeerCtor = await loadPeer().catch(() => null);
    if (connectionGeneration !== transferGeneration || transferCancelled) return;
    if (!PeerCtor) {
      showError('Could not start. Check your connection and try again.');
      return;
    }
    const activePeer = new PeerCtor(`cd-r-${generateEphemeralId()}`, peerOptions());
    peer = activePeer;
    let retryScheduled = false;

    peer.on('open', () => {
      if (peer !== activePeer || connectionGeneration !== transferGeneration || transferCancelled) return;
      // Open the relay room up front so the sender can switch to it without
      // another round trip if the data channel never connects.
      const capability = generateTunnelCapability();
      const tunnel = openRelayTunnel({ capability, role: 'creator', connect: (url) => new WebSocket(url) });
      // `raw: 1` offers the raw data channel; senders that don't know it
      // (old cached pages) use the PeerJS channel as before.
      const directConnection = activePeer.connect(peerIdFor(code), {
        reliable: true,
        serialization: 'binary',
        metadata: { relay: capability, raw: 1, window: receiveWindow }
      });
      const raw = openRawChannel(directConnection);
      closeCandidates();
      candidates = [directConnection, raw, tunnel];
      for (const transport of candidates) attachTransport(transport, connectionGeneration);
    });

    peer.on('error', (err) => {
      if (peer !== activePeer || connectionGeneration !== transferGeneration || transferCancelled || retryScheduled) return;
      // Signaling is only needed to connect; losing it mid-transfer is harmless.
      if (connection?.open && isTemporarySignalingError(err)) return;
      if (err.type === 'peer-unavailable') {
        showError('No transfer with that code. Check the digits, or ask the sender for a new one.');
        return;
      }
      if (isTemporarySignalingError(err) && !connection?.open && signalingRetries < SIGNALING_RETRY_LIMIT) {
        retryScheduled = true;
        connection = null;
        activePeer.destroy();
        setTimeout(() => {
          if (peer === activePeer && connectionGeneration === transferGeneration && !transferCancelled) {
            void establishPeer(connectionGeneration, code, signalingRetries + 1);
          }
        }, SIGNALING_RETRY_DELAY_MS * (signalingRetries + 1));
        return;
      }
      showError('Connection failed. Try again.');
    });
  }

  function attachTransport(transport, connectionGeneration) {
    const current = () => connectionGeneration === transferGeneration && candidates.includes(transport);
    // A candidate that fails before the sender commits to it is not an
    // error while the other one may still carry the transfer.
    const lose = (message) => {
      if (!current()) return;
      if (connection === transport) {
        if (!transferCancelled && !transferComplete) showError(message);
        return;
      }
      if (connection) return;
      lostCandidates.add(transport);
      if (!transferCancelled && candidates.every((candidate) => lostCandidates.has(candidate))) showError('Connection failed. Try again.');
    };

    transport.on('open', () => {
      if (!current() || transferCancelled || (connection && connection !== transport)) return;
      els.receiverConnecting.classList.add('hidden');
    });

    transport.on('data', (data) => {
      if (!current()) return;
      if (!connection) commitTransport(transport);
      if (connection !== transport) return;
      lastArrivalAt = Date.now();
      const frameBytes = data instanceof Blob ? data.size : data instanceof ArrayBuffer ? data.byteLength : ArrayBuffer.isView(data) ? data.byteLength : 1024;
      pendingReceiveBytes += frameBytes;
      if (pendingReceiveBytes > maxPendingReceiveBytes) {
        failProtocol();
        return;
      }
      dataQueue = dataQueue
        .then(() => connectionGeneration === transferGeneration && handleData(data))
        .catch((error) => {
          if (connectionGeneration !== transferGeneration) return;
          if (error?.message === DOWNLOAD_TOO_LARGE) refuseTransfer(DOWNLOAD_TOO_LARGE);
          else if (error?.message === 'invalid file size' || error?.message === 'invalid file count') {
            refuseTransfer('That file is too large or too many files — max 5 GB per file, 100 files. Split it and try again.');
          } else failProtocol();
        })
        .finally(() => {
          if (connectionGeneration === transferGeneration) pendingReceiveBytes -= frameBytes;
        });
    });

    transport.on('error', () => {
      if (transferCancelled) return;
      lose('Lost the connection to the sender. Try again.');
    });

    transport.on('close', () => {
      if (connection === transport && totalBytesReceived >= (manifest?.totalSize ?? Infinity)) return;
      lose('Lost the connection to the sender. Try again.');
    });
  }

  // commitTransport keeps the transport the sender chose and closes the
  // other candidate.
  function commitTransport(transport) {
    connection = transport;
    els.receiverConnecting.classList.add('hidden');
    for (const candidate of candidates) {
      // The raw channel lives on its PeerJS owner's peer connection.
      if (candidate === transport || candidate === transport.owner) continue;
      try { candidate.close(); } catch { /* Best effort. */ }
    }
    candidates = [transport];
  }

  function closeCandidates() {
    const closing = candidates;
    candidates = [];
    lostCandidates.clear();
    for (const candidate of closing) {
      try { candidate.close(); } catch { /* Best effort. */ }
    }
  }

  async function handleData(data) {
    if (transferCancelled) return;

    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data) || data instanceof Blob) {
      await handleChunk(data);
      return;
    }

    switch (data.type) {
      case 'manifest':
        handleManifest(data);
        break;
      case 'file-start':
        await handleFileStart(data);
        break;
      case 'file-complete':
        await handleFileComplete(data);
        break;
      case 'transfer-complete':
        handleTransferComplete();
        break;
      case 'cancel':
        transferCancelled = true;
        showError('The sender canceled the transfer.');
        break;
      default:
        throw new Error('unexpected control message');
    }
  }

  // A sender that stops sending without closing (dead network, a killed tab
  // on a network that never delivers FIN) would otherwise leave the receiver
  // on a progress bar forever. Arrival timestamps update for every frame,
  // even while chunks queue, so only true silence trips this.
  const STALL_TIMEOUT_MS = 45_000;
  const STALL_CHECK_MS = 5_000;

  function startStallWatch() {
    stopStallWatch();
    lastArrivalAt = Date.now();
    stallIntervalId = setInterval(() => {
      if (transferCancelled || transferComplete || !manifest) return;
      if (Date.now() - lastArrivalAt > STALL_TIMEOUT_MS) {
        failProtocol('Connection stalled. Check the network and try again.');
      }
    }, STALL_CHECK_MS);
  }

  function stopStallWatch() {
    if (stallIntervalId !== null) {
      clearInterval(stallIntervalId);
      stallIntervalId = null;
    }
  }

  function handleManifest(data) {
    if (manifest) throw new Error('duplicate manifest');
    manifest = parseManifest(data);
    totalBytesReceived = 0;
    transferStartTime = Date.now();
    transferCancelled = false;
    lastProgressAckAt = 0;
    nextFileIndex = 0;
    lastProgressUpdate.value = 0;
    startStallWatch();

    setManifestSummary();
    els.receiverProgress.classList.remove('hidden');
    lastProgressUpdate.value = updateProgress(
      els.receiverProgress,
      totalBytesReceived,
      manifest.totalSize,
      transferStartTime,
      true,
      lastProgressUpdate
    );
    setState('transferring');
  }

  function setManifestSummary() {
    if (!manifest) return;

    if (manifest.totalFiles === 1) {
      const onlyFile = manifest.files[0];
      setFileInfo(els.receiverFileInfo, onlyFile.name, formatSize(onlyFile.size), 'Getting ready');
      return;
    }

    const previewNames = manifest.files.slice(0, 3).map((item) => item.name).join(', ');
    const remaining = manifest.totalFiles - 3;
    const suffix = remaining > 0 ? ` + ${remaining} more` : '';
    setFileInfo(els.receiverFileInfo, `${manifest.totalFiles} files incoming`, formatSize(manifest.totalSize), previewNames + suffix);
  }

  async function handleFileStart(data) {
    if (!manifest || currentFile || !Number.isInteger(data.index) || data.index !== nextFileIndex) {
      throw new Error('unexpected file start');
    }

    const generation = transferGeneration;
    currentFile = manifest.files[data.index];
    currentFileBytes = 0;
    currentSink = null;
    stageSink = null;
    pickerPromise = null;
    setFileInfo(
      els.receiverFileInfo,
      currentFile.name,
      formatSize(currentFile.size),
      `File ${data.index + 1} of ${manifest.totalFiles}`
    );

    const tier = selectSinkTier(detectCapabilities(), currentFile.size, navigator.userAgent);
    if (tier === 'too-large') {
      refuseTransfer(DOWNLOAD_TOO_LARGE);
      return;
    }
    if (tier === 'file-picker') {
      // Fire the save dialog WITHOUT blocking the transfer queue. Awaiting
      // it here stalls the sender (backpressure) until the user picks a
      // location; instead chunks stage (preferably off-heap in OPFS) and
      // flush at file-complete.
      pickerPromise = openWritable(currentFile);
      const staged = await createStageSink({ name: currentFile.name, size: currentFile.size });
      if (generation !== transferGeneration || transferCancelled) {
        await staged.discard();
        return;
      }
      stageSink = staged;
    } else {
      const sink = await createSink({ mediaType: currentFile.mimeType, name: currentFile.name, size: currentFile.size });
      if (generation !== transferGeneration || transferCancelled) {
        await sink.abort();
        return;
      }
      currentSink = sink;
    }
  }

  async function openWritable(file) {
    const generation = transferGeneration;
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: file.name,
        types: [{ description: file.mimeType, accept: { [file.mimeType]: ['.' + extensionFor(file.name)] } }]
      });
      const writable = await handle.createWritable();
      if (generation !== transferGeneration || transferCancelled) {
        await writable.abort();
        return null;
      }
      return { handle, writable };
    } catch {
      return null;
    }
  }

  async function handleChunk(data) {
    if (!currentFile || !manifest) throw new Error('unexpected file bytes');

    const generation = transferGeneration;
    const file = currentFile;
    const sink = currentSink || stageSink;
    const chunk = data instanceof Blob ? await data.arrayBuffer() : data;
    if (generation !== transferGeneration || transferCancelled || currentFile !== file) return;
    const chunkSize = chunk.byteLength;
    if (chunkSize === 0 || currentFileBytes + chunkSize > file.size || totalBytesReceived + chunkSize > manifest.totalSize) {
      throw new Error('file size exceeded');
    }

    if (!sink) {
      throw new Error('unexpected file bytes');
    }
    await sink.write(chunk);
    if (generation !== transferGeneration || transferCancelled || currentFile !== file) return;

    totalBytesReceived += chunkSize;
    currentFileBytes += chunkSize;
    lastProgressUpdate.value = updateProgress(
      els.receiverProgress,
      totalBytesReceived,
      manifest.totalSize,
      transferStartTime,
      false,
      lastProgressUpdate
    );
    sendProgressAck();
  }

  function sendProgressAck(force = false) {
    if (!connection?.open) return;
    const now = performance.now();
    const wait = PROGRESS_UPDATE_INTERVAL - (now - lastProgressAckAt);
    if (!force && wait > 0) {
      // Throttled acks are deferred, never dropped: a sender with a full
      // window sends nothing more until it hears the latest count.
      progressAckTimer ||= setTimeout(() => {
        progressAckTimer = 0;
        sendProgressAck(true);
      }, wait);
      return;
    }
    clearTimeout(progressAckTimer);
    progressAckTimer = 0;
    connection.send({ type: 'progress', bytes: totalBytesReceived });
    lastProgressAckAt = now;
  }

  async function handleFileComplete(data) {
    if (!currentFile || data.index !== nextFileIndex || currentFileBytes !== currentFile.size) {
      throw new Error('incomplete file');
    }

    const generation = transferGeneration;
    const file = currentFile;
    const activeSink = currentSink;
    const activeStageSink = stageSink;
    const cleanupStale = async () => {
      try { await activeSink?.abort(); } catch { /* Best effort. */ }
      try { await activeStageSink?.discard(); } catch { /* Best effort. */ }
    };

    // Adopt the save stream if the dialog resolved while chunks staged.
    const picked = await pickerPromise;
    if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
      try { await picked?.writable?.abort(); } catch { /* Best effort. */ }
      await cleanupStale();
      return;
    }
    pickerPromise = null;
    if (picked && !transferCancelled) {
      setState('saving');
      if (activeStageSink) {
        const staged = await activeStageSink.toFile(file.mimeType);
        if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
          await staged.cleanup();
          try { await picked.writable.abort(); } catch { /* Best effort. */ }
          await cleanupStale();
          return;
        }
        stageSink = null;
        try {
          await staged.file.stream().pipeTo(picked.writable);
        } catch (error) {
          await staged.cleanup();
          throw error;
        }
        if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
          await staged.cleanup();
          await cleanupStale();
          return;
        }
        await staged.cleanup();
      }
    } else if (activeSink) {
      const result = await activeSink.close();
      if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
        try { result?.revoke?.(); } catch { /* Best effort. */ }
        await cleanupStale();
        return;
      }
      currentSink = null;
      downloadUrl(result.url, file.name, result.revoke);
    } else if (activeStageSink) {
      const download = await activeStageSink.toDownload(file.mimeType);
      if (generation !== transferGeneration || transferCancelled || currentFile !== file) {
        try { download?.revoke?.(); } catch { /* Best effort. */ }
        await cleanupStale();
        return;
      }
      stageSink = null;
      downloadUrl(download.url, file.name, download.revoke);
    }

    if (generation !== transferGeneration || transferCancelled || currentFile !== file) return;

    lastProgressUpdate.value = updateProgress(
      els.receiverProgress,
      totalBytesReceived,
      manifest.totalSize,
      transferStartTime,
      true,
      lastProgressUpdate
    );
    sendProgressAck(true);
    currentFile = null;
    currentFileBytes = 0;
    nextFileIndex += 1;
    currentSink = null;
    stageSink = null;
  }

  function extensionFor(fileName) {
    const extension = fileName.split('.').pop();
    return extension && extension !== fileName ? extension : 'download';
  }

  function handleTransferComplete() {
    if (!manifest || currentFile || nextFileIndex !== manifest.totalFiles || totalBytesReceived !== manifest.totalSize) {
      throw new Error('incomplete transfer');
    }
    transferComplete = true;
    clearTimeout(timeoutId);
    stopStallWatch();
    sendProgressAck(true);
    connection?.send({ type: 'transfer-ack' });
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.remove('hidden');
    els.receiverCompleteMessage.textContent = manifest.totalFiles > 1 ? `Saved ${manifest.totalFiles} files` : 'Saved';
    els.receiverCompleteDetail.textContent = manifest.totalFiles > 1
      ? `${formatSize(manifest.totalSize)} · check your downloads folder`
      : `${shortenMiddle(manifest.files[0].name, 48)} · ${formatSize(manifest.totalSize)}`;
    setState('complete');
  }

  function revokeDownload(entry) {
    const index = pendingDownloadUrls.indexOf(entry);
    if (index !== -1) pendingDownloadUrls.splice(index, 1);
    clearTimeout(entry.timeoutId);
    try { entry.revokeExtra?.(); } catch { /* Best effort. */ }
    URL.revokeObjectURL(entry.url);
    entry.link?.remove();
    const list = els.receiverComplete.querySelector('.redownload-list');
    if (list && list.childElementCount === 0) list.remove();
  }

  function downloadUrl(url, fileName, revokeExtra) {
    const entry = { url, revokeExtra, timeoutId: 0, link: null };
    // Browsers can block automatic downloads after the first file, so every
    // file also gets a manual re-download link. Without it a blocked second
    // file is silently lost.
    const manual = document.createElement('a');
    manual.href = url;
    manual.download = fileName;
    manual.textContent = pendingDownloadUrls.length === 0 && (!manifest || manifest.totalFiles === 1)
      ? 'Download again'
      : `Download ${shortenMiddle(fileName, 24)}`;
    manual.title = `Download ${fileName} again`;
    manual.className = 'secondary-btn';
    const actions = els.receiverComplete.querySelector('.result-actions');
    let list = els.receiverComplete.querySelector('.redownload-list');
    if (!list) {
      list = document.createElement('div');
      list.className = 'redownload-list';
      actions.insertBefore(list, els.receiveAnotherBtn);
    }
    list.appendChild(manual);
    entry.link = manual;
    pendingDownloadUrls.push(entry);

    const auto = document.createElement('a');
    auto.href = url;
    auto.download = fileName;
    document.body.appendChild(auto);
    auto.click();
    document.body.removeChild(auto);
    // Revoking too early aborts large downloads still flushing to disk; the
    // entry is also revoked on reset and pagehide.
    entry.timeoutId = setTimeout(() => revokeDownload(entry), DOWNLOAD_URL_TTL_MS);
  }

  function showError(message) {
    transferCancelled = true;
    try { connection?.close(); } catch { /* The channel may already be closed. */ }
    closeCandidates();
    peer?.destroy();
    clearTimeout(timeoutId);
    stopStallWatch();
    els.receiverConnecting.classList.add('hidden');
    els.receiverInputSection.classList.add('hidden');
    els.receiverRelay.classList.add('hidden');
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.add('hidden');
    els.receiverError.querySelector('.error-message').textContent = message;
    els.receiverError.classList.remove('hidden');
    setState('failed');
  }

  function failProtocol(message = 'The sender sent invalid transfer data.') {
    transferCancelled = true;
    stopStallWatch();
    try { connection?.close(); } catch { /* Best effort. */ }
    peer?.destroy();
    showError(message);
  }

  function refuseTransfer(message) {
    transferCancelled = true;
    try { connection?.close(); } catch { /* Best effort. */ }
    try { peer?.destroy(); } catch { /* Best effort. */ }
    showError(message);
  }

  function cancel() {
    if (transferCancelled) return;
    transferCancelled = true;
    try {
      connection?.send({ type: 'cancel' });
    } catch {
      // The connection may already be closing.
    }
    reset();
  }

  function resetConnectionOnly() {
    transferGeneration += 1;
    transferCancelled = true;
    peer?.destroy();
    peer = null;
    closeCandidates();
    connection = null;
    manifest = null;
    currentFile = null;
    if (currentSink) void currentSink.abort();
    if (stageSink) void stageSink.discard();
    currentSink = null;
    stageSink = null;
    for (const entry of pendingDownloadUrls) {
      clearTimeout(entry.timeoutId);
      try { entry.revokeExtra?.(); } catch { /* Best effort. */ }
      try { URL.revokeObjectURL(entry.url); } catch { /* Best effort. */ }
      entry.link?.remove();
    }
    pendingDownloadUrls = [];
    els.receiverComplete.querySelector('.redownload-list')?.remove();
    currentFileBytes = 0;
    nextFileIndex = 0;
    pickerPromise = null;
    totalBytesReceived = 0;
    transferStartTime = null;
    transferComplete = false;
    dataQueue = Promise.resolve();
    pendingReceiveBytes = 0;
    clearTimeout(progressAckTimer);
    progressAckTimer = 0;
    clearTimeout(timeoutId);
    stopStallWatch();
  }

  function reset() {
    closeRelay();
    resetConnectionOnly();
    els.receiverInputSection.classList.remove('hidden');
    els.receiverConnecting.classList.add('hidden');
    els.receiverFileInfo.classList.add('hidden');
    els.receiverProgress.classList.add('hidden');
    els.receiverComplete.classList.add('hidden');
    els.receiverError.classList.add('hidden');
    els.receiverCompleteMessage.textContent = 'Saved';
    els.codeInput.value = '';
    resetProgress(els.receiverProgress);
    setState('idle');
  }

  // Leaving with object URLs alive leaks the OPFS staging entries behind
  // them; downloads already handed to the browser are unaffected.
  window.addEventListener('pagehide', () => {
    for (const entry of pendingDownloadUrls) {
      clearTimeout(entry.timeoutId);
      try { entry.revokeExtra?.(); } catch { /* Best effort. */ }
      try { URL.revokeObjectURL(entry.url); } catch { /* Best effort. */ }
    }
    pendingDownloadUrls = [];
  });

  return {
    connect,
    openRelay,
    reset,
    cancel
  };
})();

let stopCamera = null;
let scannerGeneration = 0;

function closeScannerView() {
  stopCamera?.();
  stopCamera = null;
  els.qrReader.classList.add('hidden');
  document.documentElement.classList.remove('scanning');
}

async function startScanner() {
  const generation = ++scannerGeneration;
  els.scannerLive.textContent = 'Starting the camera…';
  els.qrReader.classList.remove('hidden');
  document.documentElement.classList.add('scanning');
  els.stopScanBtn.focus();
  try {
    const stop = await startQrScanner(els.qrVideo, (text) => {
      if (generation !== scannerGeneration) return true;
      const value = text.trim();
      // Anything the Receive box accepts: a numeric code, a private /s/ link,
      // or an older word-code link.
      if (!shortCodeFromInput(value) && !agentShareUrlFromInput(value) && !isValidCode(codeFromUrl(value))) {
        els.scannerLive.textContent = 'That QR code isn’t from CD. Point at the code on the sender’s screen.';
        return false;
      }
      scannerGeneration += 1;
      closeScannerView();
      if (navigator.vibrate) navigator.vibrate(40);
      Receiver.connect(value);
      return true;
    });
    if (generation !== scannerGeneration) {
      stop();
      return;
    }
    stopCamera = stop;
    els.scannerLive.textContent = 'Point it at the QR code on the sender’s screen.';
  } catch (error) {
    if (generation !== scannerGeneration) return;
    closeScannerView();
    els.scannerStatus.textContent = error?.name === 'NotAllowedError'
      ? 'Camera access was blocked. Allow it in your browser settings, or type the code.'
      : 'No camera available. Type the code instead.';
  }
}

function stopScanner() {
  scannerGeneration += 1;
  closeScannerView();
}

function switchToSendMode() {
  if (els.sendModeBtn.getAttribute('aria-selected') === 'true') return;
  els.sendModeBtn.tabIndex = 0;
  els.receiveModeBtn.tabIndex = -1;
  els.sendModeBtn.classList.add('active');
  els.receiveModeBtn.classList.remove('active');
  els.sendModeBtn.setAttribute('aria-selected', 'true');
  els.receiveModeBtn.setAttribute('aria-selected', 'false');
  els.senderView.classList.add('active');
  els.senderView.classList.remove('hidden');
  els.receiverView.classList.remove('active');
  els.receiverView.classList.add('hidden');
  void stopScanner();
  Receiver.reset();
  setState('idle');
}

function switchToReceiveMode() {
  if (els.receiveModeBtn.getAttribute('aria-selected') === 'true') return;
  els.receiveModeBtn.tabIndex = 0;
  els.sendModeBtn.tabIndex = -1;
  els.receiveModeBtn.classList.add('active');
  els.sendModeBtn.classList.remove('active');
  els.receiveModeBtn.setAttribute('aria-selected', 'true');
  els.sendModeBtn.setAttribute('aria-selected', 'false');
  els.receiverView.classList.add('active');
  els.receiverView.classList.remove('hidden');
  els.senderView.classList.remove('active');
  els.senderView.classList.add('hidden');
  Sender.reset();
  setState('idle');
}

els.sendModeBtn.addEventListener('click', switchToSendMode);
els.receiveModeBtn.addEventListener('click', switchToReceiveMode);

for (const tab of [els.sendModeBtn, els.receiveModeBtn]) {
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? els.sendModeBtn
      : event.key === 'End' ? els.receiveModeBtn
      : tab === els.sendModeBtn ? els.receiveModeBtn : els.sendModeBtn;
    next.click();
    next.focus();
  });
}

els.selectFileBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  els.fileInput.click();
});
els.dropZone.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', (event) => Sender.init(Array.from(event.target.files)));

els.copyCodeBtn.addEventListener('click', () => void Sender.copyCode());
els.copyLinkBtn.addEventListener('click', () => void Sender.copyLink());
els.sendAnotherBtn.addEventListener('click', () => {
  Sender.reset();
  els.fileInput.value = '';
  setState('idle');
});
els.senderCancelBtn.addEventListener('click', () => Sender.cancel());
els.senderRetryBtn.addEventListener('click', () => {
  Sender.reset();
  els.fileInput.value = '';
  setState('idle');
});
els.copyCmdBtn.addEventListener('click', () => void Sender.copyCommand());

let autoConnectTimer = null;

function connectEnteredCode() {
  clearTimeout(autoConnectTimer);
  els.codeInput.blur();
  Receiver.connect(els.codeInput.value);
}

els.connectBtn.addEventListener('click', connectEnteredCode);
els.codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') connectEnteredCode();
});
els.codeInput.addEventListener('input', (event) => {
  clearTimeout(autoConnectTimer);
  const raw = event.target.value;
  // Agent links (from `cdx send`) open the relay receiver instead of
  // being cleaned into a P2P code. Check before mangling the pasted text.
  const agentUrl = agentShareUrlFromInput(raw);
  if (agentUrl) {
    Receiver.openRelay(agentUrl);
    return;
  }
  // Pasting a full link via autofill/drag doesn't fire a paste event, so
  // detect link characters and extract the code instead of mangling it.
  event.target.value = shortCodeFromInput(raw) || (/[:\/#.]/.test(raw) ? codeFromUrl(raw, window.location.href) : cleanCode(raw));
  els.codeInput.removeAttribute('aria-invalid');
  // Five digits is the longest numeric code, so nothing else is coming.
  const enteredCode = event.target.value.trim();
  // A whole code inserted by autofill is complete, like an explicit paste.
  // Keep the delay for typing four digits, which may become a five-digit code.
  const insertedWholeCode = typeof event.data === 'string' && event.data.length >= 4 || event.inputType === 'insertReplacementText';
  if (/^\d{5}$/.test(enteredCode) || /^\d{4}$/.test(enteredCode) && insertedWholeCode) connectEnteredCode();
  else if (/^\d{4}$/.test(event.target.value.trim())) {
    autoConnectTimer = setTimeout(() => {
      if (!els.receiverInputSection.classList.contains('hidden') &&
          els.receiveModeBtn.getAttribute('aria-selected') === 'true') connectEnteredCode();
    }, 800);
  }
});
els.codeInput.addEventListener('paste', (event) => {
  clearTimeout(autoConnectTimer);
  event.preventDefault();
  const text = (event.clipboardData || window.clipboardData).getData('text');
  const agentUrl = agentShareUrlFromInput(text);
  if (agentUrl) {
    Receiver.openRelay(agentUrl);
    return;
  }
  els.codeInput.value = shortCodeFromInput(text) || codeFromUrl(text);
  els.codeInput.removeAttribute('aria-invalid');
  // A pasted code is complete; don't make people find the Connect button.
  if (isShortCode(els.codeInput.value)) Receiver.connect(els.codeInput.value);
  else if (isValidCode(els.codeInput.value)) Receiver.connect(els.codeInput.value);
});

els.scanQrBtn.addEventListener('click', () => void startScanner());
els.stopScanBtn.addEventListener('click', () => stopScanner());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !els.qrReader.classList.contains('hidden')) stopScanner();
});
els.receiveAnotherBtn.addEventListener('click', () => Receiver.reset());
els.relayDoneBtn.addEventListener('click', () => Receiver.reset());
els.retryBtn.addEventListener('click', () => Receiver.reset());
els.receiverCancelBtn.addEventListener('click', () => Receiver.cancel());
els.receiverConnectingCancelBtn.addEventListener('click', () => Receiver.reset());

// Pasting files anywhere on the Send tab starts a transfer immediately.
window.addEventListener('paste', (event) => {
  if (!els.senderView.classList.contains('active')) return;
  const files = Array.from(event.clipboardData?.files || []).filter(Boolean);
  if (files.length > 0) Sender.init(files);
});

// Files dropped anywhere on the page start a send, not just on the drop
// zone. Only while nothing else is in flight; elsewhere drops are swallowed
// so the browser doesn't navigate away to the file.
function acceptsFileDrop(event) {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return false;
  if (els.appState.dataset.state !== 'idle') return false;
  return els.senderView.classList.contains('active')
    ? !els.dropZone.classList.contains('hidden')
    : !els.receiverInputSection.classList.contains('hidden');
}

let dragDepth = 0;
function setDragging(on) {
  document.body.classList.toggle('dragging-files', on);
  els.dropZone.classList.toggle('drag-over', on);
}
window.addEventListener('dragenter', (event) => {
  if (!acceptsFileDrop(event)) return;
  dragDepth++;
  setDragging(true);
});
window.addEventListener('dragleave', () => {
  if (dragDepth === 0) return;
  dragDepth--;
  if (dragDepth === 0) setDragging(false);
});
window.addEventListener('dragover', (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = acceptsFileDrop(event) ? 'copy' : 'none';
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  setDragging(false);
  if (!acceptsFileDrop(event)) return;
  const files = Array.from(event.dataTransfer.files);
  if (files.length === 0) return;
  switchToSendMode();
  Sender.init(files);
});

// A share link from `cdx send` carries its numeric code in the fragment
// (https://cd.yash0.in/#48291), so opening it starts the receive.
const initialShortCode = shortCodeFromInput(window.location.hash.slice(1));
const initialCode = codeFromUrl(window.location.href, window.location.href);
if (isShortCode(initialShortCode)) {
  history.replaceState(null, '', window.location.pathname);
  switchToReceiveMode();
  els.codeInput.value = initialShortCode;
  Receiver.connect(initialShortCode);
} else if (isValidCode(initialCode)) {
  history.replaceState(null, '', window.location.pathname);
  switchToReceiveMode();
  els.codeInput.value = initialCode;
  Receiver.connect(initialCode);
} else {
  setState('idle');
}
