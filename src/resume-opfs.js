function streamWriter(file) {
  return {
    async write(bytes, offset) {
      const writable = await file.createWritable({ keepExistingData: true });
      try {
        await writable.seek(offset);
        await writable.write(bytes);
        await writable.close();
      } catch (error) {
        try { await writable.abort(); } catch { /* Best effort. */ }
        throw error;
      }
    },
    async close() {}
  };
}

// Initialization can fall back; a failed write must preserve the last checkpoint.
export async function createResumeWriter(file, WorkerImpl) {
  if (typeof WorkerImpl !== 'function' && typeof globalThis.Worker !== 'function') return streamWriter(file);
  let worker;
  let pending;
  let failure;
  const fail = error => {
    failure = error;
    pending?.(error);
    worker?.terminate();
  };
  const request = message => {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error('Resumable storage worker timed out.')), 30_000);
      pending = error => {
        clearTimeout(timer);
        pending = undefined;
        error ? reject(error) : resolve();
      };
      try { worker.postMessage(message); } catch (error) { fail(error); }
    });
  };
  try {
    worker = WorkerImpl ? new WorkerImpl() : new Worker(new URL('./resume-opfs-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data?.ok === true) pending?.();
      else {
        const error = new Error(typeof data?.error === 'string' ? data.error : 'Resumable storage worker failed.');
        if (typeof data?.name === 'string') error.name = data.name;
        fail(error);
      }
    };
    worker.onerror = event => { event.preventDefault?.(); fail(new Error(event.message || 'Resumable storage worker failed.')); };
    worker.onmessageerror = () => fail(new Error('Resumable storage worker returned invalid data.'));
    await request({ type: 'open', file });
  } catch {
    worker?.terminate();
    return streamWriter(file);
  }
  let closed = false;
  let closing;
  return {
    async write(bytes, offset) {
      if (closed) throw new Error('Resumable storage is closed.');
      // Clone one bounded chunk so the receiver can still hash its own bytes.
      await request({ type: 'write', bytes, offset });
    },
    close() {
      return closing ??= (async () => {
        closed = true;
        try { if (!failure) await request({ type: 'close' }); }
        finally { worker.terminate(); }
      })();
    }
  };
}
