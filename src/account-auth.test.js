import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountSubject, clerkIssuer } from '../worker/account-auth.ts';

test('missing and malformed credentials never reach Clerk', async () => {
  for (const authorization of [null, 'Bearer user_attacker', 'Basic secret']) {
    const request = new Request('https://cd.example/api/account/v1', { headers: authorization ? { Authorization: authorization } : {} });
    assert.equal(await accountSubject(request, "test-secret", () => { throw new Error('must not fetch'); }), null);
  }
});
test('Clerk response establishes the account, never client-supplied identity', async () => {
  const request = new Request('https://cd.example/api/account/v1?user_id=user_attacker', { headers: { Authorization: 'Bearer an-opaque-access-token' } });
  const subject = await accountSubject(request, "test-secret", async (url, options) => {
    assert.equal(url, `${clerkIssuer}/oauth/token_info`);
    assert.equal(options.headers.Authorization, `Basic ${btoa('A5eL6DW58r6rKyit:test-secret')}`);
    assert.equal(options.body.get('token'), 'an-opaque-access-token');
    return Response.json({ active: true, client_id: 'A5eL6DW58r6rKyit', exp: Math.floor(Date.now()/1000)+300, sub: 'user_verified123' });
  });
  assert.equal(subject, 'user_verified123');
  assert.equal(await accountSubject(request, "test-secret", async () => new Response('invalid', { status: 401 })), null);
  assert.equal(await accountSubject(request, "test-secret", async () => Response.json({ sub: '../../other-account' })), null);
});

test('tokens from another OAuth client and expired tokens cannot authorize receiving', async () => {
 const request = new Request('https://cd.example/api/account/v1', { headers: { Authorization: 'Bearer an-opaque-access-token' } });
 const valid = { active: true, client_id: 'A5eL6DW58r6rKyit', exp: Math.floor(Date.now()/1000)+300, sub: 'user_verified123' };
 for (const changes of [{ active: false }, { client_id: 'other-app' }, { exp: 1 }]) assert.equal(await accountSubject(request, 'test-secret', async () => Response.json({ ...valid, ...changes })), null);
 assert.equal(await accountSubject(request, undefined, () => { throw Error('must not fetch'); }), null);
});
