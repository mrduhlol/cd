// Full v1/v2 capabilities stay in private links, not the numeric code directory.
// Cross-origin links retain their sender origin and are navigated by main.js.
const AGENT_LINK_PATH = /^\/s\/([A-Za-z0-9_-]{22})\/?$/;
const AGENT_LINK_KEY = /^v[12]\.([A-Za-z0-9_-]{43})$/;
const AGENT_BARE_CODE = /^([A-Za-z0-9_-]{22})#(v[12])\.([A-Za-z0-9_-]{43})$/;

export function agentShareUrlFromInput(value, base = globalThis.location?.href) {
  const raw = String(value ?? '').trim();
  if (!raw || !/#v[12]\./.test(raw)) return '';
  const candidates = [raw];
  for (const token of raw.split(/[\s"'<>]+/)) {
    if (token && token !== raw) candidates.push(token);
  }
  for (const candidate of candidates) {
    const bare = AGENT_BARE_CODE.exec(candidate);
    if (bare) return `${new URL(base).origin}/s/${bare[1]}#${bare[2]}.${bare[3]}`;
    try {
      const url = new URL(candidate, base);
      // Only web links: `javascript:/s/...` would otherwise pass the path check.
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      const path = AGENT_LINK_PATH.exec(url.pathname);
      const key = AGENT_LINK_KEY.exec(url.hash.slice(1));
      if (path && key) return url.toString();
    } catch { /* Not a URL; try the next candidate. */ }
  }
  return '';
}
