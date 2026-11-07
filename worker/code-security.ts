// CF-Connecting-IP is supplied by Cloudflare. Invalid/missing values share
// one bucket; untrusted textual spellings must never create fresh budgets.
export function clientPrefix(request: Request): string {
  const raw = request.headers.get('CF-Connecting-IP') ?? '';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) {
    const parts = raw.split('.').map(Number);
    if (parts.every((part) => part <= 255)) return `v4:${parts.join('.')}`;
  }
  if (!/^[0-9a-f:.]+$/i.test(raw) || !raw.includes(':')) return 'unknown';
  try {
    const canonical = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
    const halves = canonical.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const words = halves.length === 2
      ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right].map((word) => Number.parseInt(word, 16))
      : left.map((word) => Number.parseInt(word, 16));
    if (words.length !== 8) return 'unknown';
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return `v4:${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
    }
    return `v6:${words.slice(0, 4).map((word) => word.toString(16).padStart(4, '0')).join(':')}/64`;
  } catch { return 'unknown'; }
}

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  return origin === null
    ? !['cross-site', 'same-site'].includes(request.headers.get('Sec-Fetch-Site') ?? '')
    : origin === new URL(request.url).origin;
}
