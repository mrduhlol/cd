// Short numeric share codes ("48291"): one plane for every sender and
// receiver, terminal or browser. A code resolves through the relay's
// /api/codes directory to a transfer capability (transfer ID + master key).
// Unlike full links, codes are typable but not end-to-end encrypted — the
// directory holds the key, so TLS + the live relay carry the trust.
export const SHORT_CODE_PATTERN = /^\d{4,5}$/;
export const TRANSFER_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export const MASTER_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isShortCode(value) {
  return typeof value === 'string' && SHORT_CODE_PATTERN.test(value.trim());
}

export function cleanShortCode(value) {
  return String(value ?? '').trim();
}

// A numeric link supplies a code, just like a pasted number. Directory
// lookup stays on this page's configured origin, never on an input hostname.
export function shortCodeFromInput(value) {
  const raw = cleanShortCode(value);
  if (isShortCode(raw)) return raw;
  try {
    const url = new URL(raw);
    if ((url.protocol === 'https:' || url.protocol === 'http:') &&
        url.pathname === '/' && !url.username && !url.password && isShortCode(url.hash.slice(1))) {
      return url.hash.slice(1);
    }
  } catch { /* Not an absolute URL. */ }
  return '';
}

export function codeLookupPath(code) {
  const cleaned = cleanShortCode(code);
  if (!isShortCode(cleaned)) throw new Error('invalid share code');
  return `/api/codes/${encodeURIComponent(cleaned)}`;
}

export function shareUrlFromCapability(origin, transferId, key) {
  if (!TRANSFER_ID_PATTERN.test(transferId) || !MASTER_KEY_PATTERN.test(key)) {
    throw new Error('invalid share capability');
  }
  const base = String(origin).replace(/\/$/, '');
  return `${base}/s/${transferId}#v1.${key}`;
}

// Codes from cdx v0.1.0 live on the old host; the directory says so with an
// `origin`, and only this one is trusted so a lookup can't redirect anywhere.
export const LEGACY_ORIGIN = 'https://cdx.yash0.in';

export function parseCapability(body) {
  if (!body || typeof body !== 'object') throw new Error('invalid share capability');
  const { transferId, key } = body;
  if (!TRANSFER_ID_PATTERN.test(transferId) || !MASTER_KEY_PATTERN.test(key)) {
    throw new Error('invalid share capability');
  }
  return body.origin === LEGACY_ORIGIN ? { transferId, key, origin: LEGACY_ORIGIN } : { transferId, key };
}
