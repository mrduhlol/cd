import { boundedPushJSON } from './device-push.ts';
export const clerkIssuer = 'https://electric-arachnid-4684.clerk.accounts.dev';
export const clerkClientID = 'A5eL6DW58r6rKyit';

export async function accountSubject(request: Request, clientSecret: string | undefined, fetcher: typeof fetch = fetch): Promise<string | null> {
  const authorization = request.headers.get('Authorization');
  if (!clientSecret || !authorization || !/^Bearer [A-Za-z0-9._~-]{16,8192}$/.test(authorization)) return null;
  const response = await fetcher(`${clerkIssuer}/oauth/token_info`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${clerkClientID}:${clientSecret}`)}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'cd-account-service/1.0' },
    body: new URLSearchParams({ token: authorization.slice(7), token_type_hint: 'access_token' }),
    signal: AbortSignal.timeout(10000), redirect: 'manual',
  });
  if (!response.ok) return null;
  const token: unknown = await boundedPushJSON(response, 32768);
  return token && typeof token === 'object'
    && 'active' in token && token.active === true
    && 'client_id' in token && token.client_id === clerkClientID
    && (!('exp' in token) || (typeof token.exp === 'number' && token.exp * 1000 > Date.now()))
    && 'sub' in token && typeof token.sub === 'string' && /^user_[A-Za-z0-9]{1,128}$/.test(token.sub)
    ? token.sub : null;
}
