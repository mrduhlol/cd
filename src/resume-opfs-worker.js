let handle;

self.onmessage = async ({ data }) => {
  try {
    if (data?.type === 'open' && !handle) {
      handle = await data.file.createSyncAccessHandle();
    } else if (data?.type === 'write' && handle) {
      if (!(data.bytes instanceof Uint8Array) || !data.bytes.length || data.bytes.length > 256 * 1024 || !Number.isSafeInteger(data.offset) || data.offset < 0) {
        throw new Error('Invalid resumable storage write.');
      }
      let written = 0;
      while (written < data.bytes.length) {
        const count = handle.write(data.bytes.subarray(written), { at: data.offset + written });
        if (!Number.isSafeInteger(count) || count <= 0 || count > data.bytes.length - written) throw new Error('Resumable storage made an incomplete write.');
        written += count;
      }
      handle.flush();
    } else if (data?.type === 'close' && handle) {
      handle.close();
      handle = undefined;
    } else throw new Error('Invalid resumable storage operation.');
    self.postMessage({ ok: true });
  } catch (error) {
    try { handle?.close(); } catch { /* Best effort. */ }
    handle = undefined;
    self.postMessage({ error: error.message || 'Resumable storage failed.', name: error.name });
  }
};
