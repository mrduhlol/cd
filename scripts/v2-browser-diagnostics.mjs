// Test-only diagnostics. Never print capability URLs, transfer IDs, keys or joins.
export function safeRoute(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '[non-web URL]';
    const path = url.pathname
      .replace(/\/(s|ws\/v[12])\/[^/]+/g, '/$1/[transfer]')
      .replace(/\/api\/codes\/[^/]+/g, '/api/codes/[code]');
    return `${url.protocol}//${url.host}${path}`;
  } catch { return '[invalid URL]'; }
}

export function sanitizeDiagnostic(value, maxLength = 4000) {
  return String(value ?? '')
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/g, safeRoute)
    .replace(/#v[12]\.[A-Za-z0-9_-]+/g, '#[private capability]')
    .replace(/[A-Za-z0-9_-]{22,}/g, '[redacted token]')
    .slice(0, maxLength);
}

// CDP gives binary WebSocket payloads as base64. Inspect only the public
// 12-byte record header, never decode/log ciphertext. Text controls below are
// strictly allowlisted; join credentials, nonces and URLs never leave the parser.
// These are untrusted wire observations, not authenticated protocol results.
export function frameMetadata(opcode, payloadData) {
  if (typeof payloadData !== 'string') return { opcode, unavailable: true };
  if (opcode === 2) {
    const bytes = Buffer.byteLength(payloadData, 'base64');
    const header = Buffer.from(payloadData.slice(0, 16), 'base64');
    if (bytes < 28 || header.length !== 12 || header[0] !== 67 || header[1] !== 68 || header[2] !== 2) {
      return { opcode, bytes, record: 'unknown' };
    }
    const kinds = { 1: 'OFFER', 2: 'CHUNK', 3: 'END', 4: 'ACCEPT', 5: 'ACK', 6: 'COMPLETE', 9: 'SIGNAL' };
    return { opcode, bytes, kind: kinds[header[3]] ?? 'unknown', sequence: header.readUInt32BE(4), plaintextBytes: header.readUInt32BE(8) };
  }
  if (opcode === 1) {
    const metadata = { opcode, bytes: Buffer.byteLength(payloadData, 'utf8'), control: 'unknown' };
    try {
      const value = JSON.parse(payloadData);
      const allowed = ['join', 'accepted', 'peer-joined', 'peer-left', 'complete', 'completed', 'exhausted'];
      if (value?.protocol === 'cd-transfer-v2' && allowed.includes(value.type)) metadata.control = value.type;
    } catch { /* Malformed text is counted, not exposed. */ }
    return metadata;
  }
  return { opcode };
}

// The application displays a filename next to progress. Callers report only
// its presence; parse the progress label strictly so arbitrary text is lost.
export function numericProgress(value) {
  const match = /^(\d+(?:\.\d+)?)% · (\d+) \/ (\d+) bytes$/.exec(String(value ?? ''));
  if (!match) return null;
  const [percent, done, total] = match.slice(1).map(Number);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100 || !Number.isSafeInteger(done) || !Number.isSafeInteger(total) || done > total) return null;
  return { percent, done, total };
}

// Attach both handlers immediately, so an early open/navigation error cannot
// leave a rejected download wait unhandled and hide the original failure.
export function settle(promise) {
  return Promise.resolve(promise).then(value => ({ value }), error => ({ error }));
}
