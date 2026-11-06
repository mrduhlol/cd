// Shared download sinks for the agent receiver (share.js) and the
// browser P2P receiver (main.js).
//
// Tier order, best first:
//   1. file-picker: File System Access streaming write, no size cap.
//      Desktop Chromium and modern Chrome Android.
//   2. opfs: stage chunks into the Origin Private File System as they
//      arrive (bounded RAM), then hand the staged file to the browser
//      download as a disk-backed object URL. Baseline since 2023 on
//      Chromium, Firefox, and Safari 15.2+/iOS.
//   3. blob: accumulate in memory, one Blob at the end. Chromium spills
//      large blobs to disk, so only WebKit keeps a cap: blob downloads
//      above ~256 MiB crash real iOS devices in the field.
//
// Callers must not overlap write() calls; both receivers already
// serialize chunk handling through a promise queue.

export const BLOB_FALLBACK_LIMIT = 256n * 1024n * 1024n;
// Kept as an alias for callers that used the old constant name.
export const WEBKIT_BLOB_LIMIT = BLOB_FALLBACK_LIMIT;

export const DOWNLOAD_TOO_LARGE =
  'This file exceeds the 256 MiB limit for memory based downloads, or browser storage is unavailable. ' +
  'Use a supported browser with durable storage, such as current Chrome, Firefox, or Safari, or choose a save location when prompted.';

// True for Safari on macOS/iOS and every iOS browser (all WebKit under
// the hood, including Chrome/Firefox on iOS). False for desktop and
// Android Chromium, which carry an AppleWebKit token but a real
// Chrome/Chromium token too. Firefox is intentionally not
// distinguished: out of scope, treated like Chromium.
export function isWebKitBrowser(userAgent = '') {
  return /AppleWebKit\//.test(userAgent) && !/(Chrome|Chromium)\//.test(userAgent);
}

export function detectCapabilities(host = globalThis) {
  const filePicker =
    typeof host.window !== 'undefined' && typeof host.window.showSaveFilePicker === 'function';
  const opfs =
    typeof host.navigator !== 'undefined' &&
    typeof host.navigator.storage?.getDirectory === 'function';
  return { filePicker, opfs };
}

// Pure tier selection so the policy is unit-testable in Node.
export function selectSinkTier(capabilities, size, userAgent = '') {
  if (capabilities.filePicker) return 'file-picker';
  if (capabilities.opfs) return 'opfs';
  if (BigInt(size) > BLOB_FALLBACK_LIMIT) return 'too-large';
  return 'blob';
}

function stagingName() {
  return `cd-rx-${crypto.randomUUID()}`;
}

export function downloadUrlFor(file, offerName, onRevoke) {
  const url = URL.createObjectURL(file);
  let revoked = false;
  return {
    url,
    name: offerName,
    revoke: () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
      try { void Promise.resolve(onRevoke?.()).catch(() => {}); } catch { /* Best effort. */ }
    }
  };
}

export async function createPickerSink({ name }) {
  const handle = await window.showSaveFilePicker({ suggestedName: name });
  const writable = await handle.createWritable();
  return {
    kind: 'saved',
    async write(bytes) { await writable.write(bytes); },
    async close() { await writable.close(); return {}; },
    async abort() { try { await writable.abort(); } catch { /* Best effort. */ } }
  };
}

export async function createOPFSSink({ name }) {
  const root = await navigator.storage.getDirectory();
  const internal = stagingName();
  const fileHandle = await root.getFileHandle(internal, { create: true });
  let writable;
  try {
    writable = await fileHandle.createWritable();
  } catch (error) {
    try { await root.removeEntry(internal); } catch { /* Best effort. */ }
    throw error;
  }
  // Every write() is an IPC round-trip to the storage thread. Coalescing
  // small network chunks into ~4 MiB flushes cuts the syscall
  // count by an order of magnitude; the copy is one fast memmove.
  const FLUSH_BYTES = 4 * 1024 * 1024;
  let pending = [];
  let pendingBytes = 0;
  // At most one writable.write() is outstanding. A flush starts its write
  // without waiting for it, so the next chunk's decrypt overlaps disk I/O;
  // the next flush (or close) waits for the previous one first, which keeps
  // writes in byte order and bounds memory to two flushes.
  let inflight = null;
  let failure = null;
  const flush = async () => {
    if (pendingBytes === 0) return;
    let merged;
    if (pending.length === 1) {
      merged = pending[0];
    } else {
      merged = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const part of pending) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
    }
    pending = [];
    pendingBytes = 0;
    if (inflight) await inflight;
    const next = writable.write(merged);
    // Record a failure now so the next write() or close() reports it even
    // when no flush is due; the .catch keeps it from being unhandled.
    next.catch((error) => { failure ??= error; });
    inflight = next;
  };
  // Waits for every queued write, then surfaces any failure.
  const drain = async () => {
    await flush();
    if (inflight) await inflight;
    if (failure) throw failure;
  };
  const discard = async () => {
    pending = [];
    pendingBytes = 0;
    try { await writable.abort(); } catch { /* Best effort. */ }
    try { await root.removeEntry(internal); } catch { /* Best effort. */ }
  };
  return {
    kind: 'download',
    internalName: internal,
    async write(bytes) {
      if (failure) throw failure;
      const view = bytes instanceof Uint8Array
        ? bytes
        : ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
      pending.push(view);
      pendingBytes += view.byteLength;
      if (pendingBytes >= FLUSH_BYTES) await flush();
    },
    async file() {
      await drain();
      await writable.close();
      return fileHandle.getFile();
    },
    async cleanup() {
      try { await root.removeEntry(internal); } catch { /* Best effort. */ }
    },
    async close() {
      const file = await this.file();
      // The object URL reads lazily from the staged entry: it must stay
      // until the download is done, so removal happens in revoke(), which
      // callers run after the click settles or the page hides.
      return downloadUrlFor(file, name, () => root.removeEntry(internal));
    },
    async abort() { await discard(); }
  };
}

// Staging buffer for receivers that must keep bytes while waiting on
// something else (the P2P flow fires the save dialog without blocking
// the transfer). Prefers OPFS so staging stays off the JS heap;
// falls back to a RAM array. Single-use: call exactly one of toFile()
// (pipe the staged bytes somewhere else) or toDownload() (offer them
// as a download); discard() drops them.
export async function createStageSink({ name, size = 0, maxBytes = BLOB_FALLBACK_LIMIT }) {
  try {
    if (detectCapabilities().opfs) {
      const staged = await createOPFSSink({ name });
      return {
        async write(bytes) { await staged.write(bytes); },
        async toFile() {
          const file = await staged.file();
          return { file, cleanup: () => staged.cleanup() };
        },
        async toDownload() { return staged.close(); },
        async discard() { await staged.abort(); }
      };
    }
  } catch {
    // OPFS can fail after detection (private mode, full disk).
  }
  assertBlobSize(size);
  const chunks = [];
  const memoryLimit = maxBlobBytes(maxBytes);
  let written = 0n;
  const append = (bytes) => {
    const view = asBytes(bytes);
    if (written + BigInt(view.byteLength) > memoryLimit) throw new Error(DOWNLOAD_TOO_LARGE);
    chunks.push(view);
    written += BigInt(view.byteLength);
  };
  return {
    async write(bytes) { append(bytes); },
    async toFile(mediaType) {
      const file = new Blob(chunks, { type: mediaType });
      chunks.length = 0;
      return { file, cleanup: async () => {} };
    },
    async toDownload(mediaType) {
      const { file } = await this.toFile(mediaType);
      return downloadUrlFor(file, name);
    },
    async discard() { chunks.length = 0; }
  };
}

export function createBlobSink({ mediaType, name, maxBytes = BLOB_FALLBACK_LIMIT }) {
  const chunks = [];
  const memoryLimit = maxBlobBytes(maxBytes);
  let written = 0n;
  return {
    kind: 'download',
    async write(bytes) {
      const view = asBytes(bytes);
      if (written + BigInt(view.byteLength) > memoryLimit) throw new Error(DOWNLOAD_TOO_LARGE);
      chunks.push(view);
      written += BigInt(view.byteLength);
    },
    async close() {
      const file = new Blob(chunks, { type: mediaType });
      chunks.length = 0;
      return downloadUrlFor(file, name);
    },
    async abort() { chunks.length = 0; }
  };
}

function maxBlobBytes(requested) {
  const limit = BigInt(requested);
  if (limit < 0n) throw new RangeError('Blob limit must be non-negative.');
  return limit < BLOB_FALLBACK_LIMIT ? limit : BLOB_FALLBACK_LIMIT;
}

function asBytes(bytes) {
  return bytes instanceof Uint8Array
    ? bytes
    : ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes);
}

function assertBlobSize(size) {
  if (selectSinkTier({ filePicker: false, opfs: false }, size, navigator.userAgent) === 'too-large') {
    throw new Error(DOWNLOAD_TOO_LARGE);
  }
}

// Single-file receiver entry point (share.js): routes to the best tier
// and throws a readable error when the browser cannot take the size.
export async function createSink({ name, size, mediaType, preferDownload = false }) {
  const capabilities = detectCapabilities();
  if (preferDownload) capabilities.filePicker = false;
  const tier = selectSinkTier(capabilities, size, navigator.userAgent);
  if (tier === 'file-picker') {
    try {
      return await createPickerSink({ name });
    } catch (error) {
      // The picker is known-flaky on some Android builds; fall through
      // to disk staging instead of failing. A user cancel stays a
      // cancel so the page can wait for another click.
      if (error?.name === 'AbortError') throw error;
    }
  }
  if (tier !== 'too-large') {
    if (capabilities.opfs) {
      try {
        return await createOPFSSink({ name });
      } catch {
        // Private mode and full disks disable OPFS; Blob is the last resort.
      }
    }
    assertBlobSize(size);
    return createBlobSink({ mediaType, name });
  }
  throw new Error(DOWNLOAD_TOO_LARGE);
}
