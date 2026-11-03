const MiB = 1024 * 1024;
const MAX_WINDOW = 24 * MiB;
const MAX_SAMPLES = 64;
const RATE_INTERVAL_MS = 100;

function count(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new RangeError(`${label} must be a nonnegative bigint or safe integer`);
}

// Cumulative ACKs measure delivered bytes. The controller owns accounting,
// while the transport owns cancellation, idle deadlines, and native buffers.
export function createSendWindow({ minBytes = MiB, maxBytes = 12 * MiB, initialBytes = 4 * MiB, initialOffset = 0n } = {}) {
  for (const value of [minBytes, maxBytes, initialBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError('window bounds must be positive safe integers');
  }
  if (minBytes > initialBytes || initialBytes > maxBytes || maxBytes > MAX_WINDOW) {
    throw new RangeError('window bounds must satisfy min <= initial <= max <= 24 MiB');
  }
  let size = initialBytes;
  let sent = count(initialOffset, 'initial offset');
  let acknowledged = sent;
  let minRTT = 0;
  let lastTime = -Infinity;
  let markTime = null;
  let markBytes = sent;
  const samples = [];

  function time(at) {
    if (!Number.isFinite(at) || at < lastTime) throw new RangeError('sample time must be finite and monotonic');
    return at;
  }
  const controller = {
    get size() { return size; },
    get inFlight() { return Number(sent - acknowledged); },
    get capacity() { return Math.max(0, size - controller.inFlight); },
    canSend(bytes) {
      return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= controller.capacity;
    },
    sent(offset, at = performance.now()) {
      offset = count(offset, 'sent offset');
      at = time(at);
      const delta = offset - sent;
      if (delta <= 0n || delta > BigInt(controller.capacity)) {
        throw new RangeError('sent offset must advance within the available window');
      }
      sent = offset;
      lastTime = at;
      if (samples.length === MAX_SAMPLES) {
        // Coalesce the newest sample; retained samples hold no payload bytes.
        samples[MAX_SAMPLES - 1] = { offset, at };
      } else {
        samples.push({ offset, at });
      }
    },
    acked(offset, at = performance.now()) {
      offset = count(offset, 'acknowledged offset');
      at = time(at);
      if (offset < acknowledged || offset > sent) throw new RangeError('acknowledgement must be monotonic and not exceed sent bytes');
      if (offset === acknowledged) {
        lastTime = at;
        return false;
      }
      let covered = -1;
      for (let i = 0; i < samples.length && samples[i].offset <= offset; i++) covered = i;
      if (samples.length > 0) {
        const rtt = at - samples[Math.max(0, covered)].at;
        if (rtt > 0 && (minRTT === 0 || rtt < minRTT)) minRTT = rtt;
        if (covered >= 0) samples.splice(0, covered + 1);
      }
      acknowledged = offset;
      lastTime = at;
      if (markTime === null) {
        markTime = at;
        markBytes = offset;
      } else if (minRTT > 0 && at - markTime >= Math.max(RATE_INTERVAL_MS, minRTT)) {
        const delivered = Number(offset - markBytes);
        const target = Math.ceil(2 * delivered * minRTT / (at - markTime));
        size = Math.min(maxBytes, Math.max(minBytes, target));
        markTime = at;
        markBytes = offset;
      }
      return true;
    },
    snapshot() {
      return { size, capacity: controller.capacity, inFlight: controller.inFlight, sent, acknowledged, minRTT, sampleCount: samples.length };
    }
  };
  return controller;
}
