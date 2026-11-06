import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
const bundle = await build({ stdin: { contents: `export { AccountRoom } from './worker/account-room.ts'; import { accountSubject } from './worker/account-auth.ts'; export default { async fetch(request) { return Response.json({ subject: await accountSubject(request, 'runtime-test-secret') }); } };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', external: ['cloudflare:workers'], platform: 'browser', target: 'es2022' });
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-12', durableObjects: { ACCOUNTS: { className: 'AccountRoom', useSQLite: true } }, outboundService: async () => Response.json({ active: true, client_id: 'A5eL6DW58r6rKyit', sub: 'user_runtime123' }) }));
try {
 const auth = await mf.dispatchFetch('https://internal/api/account/v1', { headers: { Authorization: 'Bearer runtime-test-access-token' } });
 assert.equal(auth.status, 200, auth.status === 200 ? "" : await auth.text());
 assert.equal((await auth.json()).subject, 'user_runtime123');
 const ns = await mf.getDurableObjectNamespace('ACCOUNTS');
 const a = ns.get(ns.idFromName('user_A'));
 const b = ns.get(ns.idFromName('user_B'));
 const id = 'abcdefghijklmnopqrstuv';
 const pairId = 'ABCDEFGHIJKLMNOPQRSTUV';
 const request = (stub, method, path, data) => stub.fetch(`https://internal${path}`, { method, ...(data ? { body: JSON.stringify(data) } : {}) });
 assert.equal((await request(a, 'POST', '/phone', { id, name: 'phone', publicKey: 'a'.repeat(120) })).status, 200);
 assert.deepEqual((await (await request(b, 'GET', '')).json()).phones, []);
 assert.equal((await request(b, 'POST', '/pair', { id: pairId, target: id, envelope: 'a'.repeat(128) })).status, 404);
 assert.equal((await request(a, 'POST', '/pair', { id: pairId, target: id, envelope: 'a'.repeat(128) })).status, 200);
 assert.equal((await (await request(a, 'GET', '')).json()).pairs[0].target, id);
 assert.deepEqual((await (await request(b, 'GET', '')).json()).pairs, []);
 assert.equal((await request(a, 'DELETE', '/phone', { id })).status, 200);
 assert.deepEqual((await (await request(a, 'GET', '')).json()).phones, []);
 assert.equal((await request(a, 'POST', '/phone', { id: '../../bad', name: 'phone' })).status, 400);
 console.log('Verified account isolation, private invitations, unknown-target rejection, and device revocation in real Durable Objects.');
} finally { await mf.dispose(); }
