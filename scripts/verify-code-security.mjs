import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';
import { encodeBase64Url, receiverAdmission } from '../src/agent-protocol.js';
import { withTimeout } from './verify-helpers.mjs';

// Real workerd Worker/DO tests, with isolated SQLite and no internet egress.
// Only fixture setup, clock advancement, and eviction use Miniflare controls.
const work = await mkdtemp(join(tmpdir(), 'cd-code-security-'));
const sockets = [];
const origin = 'https://cd.yash0.in';
const legacyCapability = { transferId: 'L'.repeat(22), key: 'M'.repeat(43) };
let legacyProbes = 0;
let mf;
const baseline = process.env.CD_SECURITY_BASELINE === '1';
try {
  const scriptPath = join(work, 'worker.mjs');
  await build({
    ...(baseline ? { stdin: { contents: execFileSync('git', ['show', '8520156:worker/index.ts'], { encoding: 'utf8' }), resolveDir: resolve('worker'), loader: 'ts' } } : { entryPoints: ['worker/index.ts'] }),
    bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers'], outfile: scriptPath,
  });
  const { workerOptions } = unstable_getMiniflareWorkerOptions('wrangler.jsonc');
  mf = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: workerOptions.compatibilityDate,
    compatibilityFlags: workerOptions.compatibilityFlags,
    durableObjects: workerOptions.durableObjects, ratelimits: workerOptions.ratelimits,
    name: 'cd-security', rootPath: work, modulesRoot: work,
    modules: true, scriptPath, port: 0, inspectorPort: 0,
    durableObjectsPersist: join(work, 'state'), unsafeInspectDurableObjects: true,
    log: new Log(LogLevel.WARN),
    outboundService: async (request) => {
      assert.equal(new URL(request.url).origin, 'https://cdx.yash0.in', 'unexpected internet egress');
      legacyProbes += 1;
      return new Response(JSON.stringify(legacyCapability), { headers: { 'Content-Type': 'application/json' } });
    },
  }));
  await mf.ready;
  const request = (path, ip, init = {}) => mf.dispatchFetch(`${origin}${path}`, {
    ...init, headers: { 'CF-Connecting-IP': ip, ...init.headers },
  });
  const capability = () => ({ transferId: randomBytes(16).toString('base64url'), key: randomBytes(32).toString('base64url') });
  const post = (cap, ip, headers = {}) => request('/api/codes', ip, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(cap),
  });
  async function sql(name) {
    return mf.unsafeGetDurableObjectStorage('cd-security', 'CodeDirectory', { name });
  }
  async function socket(cap, ip, role = 'sender', withKey = true, headers = {}) {
    const response = await request(`/ws/v1/${cap.transferId}`, ip, { headers: { Upgrade: 'websocket', ...headers } });
    assert.equal(response.status, 101, `upgrade: ${await response.text()}`);
    const ws = response.webSocket;
    assert.ok(ws);
    ws.accept();
    sockets.push(ws);
    const { digest, token } = await receiverAdmission({ id: Buffer.from(cap.transferId, 'base64url'), key: Buffer.from(cap.key, 'base64url') });
    const accepted = nextMessage(ws);
    ws.send(JSON.stringify(role === 'sender' ? {
      type: 'join', protocol: 'cd-transfer-v1', role, receiverTokenHash: encodeBase64Url(digest), ...(withKey ? { shareKey: typeof withKey === 'string' ? withKey : cap.key } : {}),
    } : { type: 'join', protocol: 'cd-transfer-v1', role, receiverToken: encodeBase64Url(token) }));
    return { ws, accepted: JSON.parse(await accepted) };
  }
  function nextMessage(ws) {
    return withTimeout(new Promise((resolve, reject) => {
      ws.addEventListener('message', (event) => resolve(event.data), { once: true });
      ws.addEventListener('close', (event) => reject(new Error(`unexpected close ${event.code}: ${event.reason}`)), { once: true });
    }), 8000, 'missing Worker event');
  }
  async function eventually(check, label) {
    for (let i = 0; i < 80; i += 1) {
      if (await check()) return;
      await delay(25);
    }
    assert.fail(label);
  }

  const rogue = capability();
  const crossSite = await post(rogue, '192.0.2.1', { Origin: 'https://attacker.invalid', 'Content-Type': 'text/plain' });
  const statuses = [];
  const beforeIPv6 = legacyProbes;
  for (let i = 1; i <= 35; i += 1) statuses.push((await request('/api/codes/98234', `2001:db8:10:20::${i.toString(16)}`)).status);
  console.log('cross-site nonexistent claim:', crossSite.status, 'IPv6 /64 lookups:', JSON.stringify(statuses), 'legacy probes:', legacyProbes - beforeIPv6);
  assert.equal(crossSite.status, 403, 'cross-site text/plain claim must be forbidden');
  assert.ok(statuses.filter((status) => status === 429).length >= 23, 'address rotation must share durable /64 budget');
  assert.equal(legacyProbes - beforeIPv6, 12, 'legacy fallback must consume the same /64 probe budget');
  if (baseline) assert.fail('baseline unexpectedly passed security regressions');
  console.log('PASS #41 /64 address rotation and legacy budget; #42 cross-site exploit');

  assert.equal((await post(rogue, '192.0.2.2')).status, 403, 'nonexistent room');
  assert.equal((await post(rogue, '192.0.2.2', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(rogue, '192.0.2.2', { Origin: 'null' })).status, 403);
  assert.equal((await post(rogue, '192.0.2.2', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request('/api/codes', '192.0.2.2', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(257) })).status, 413);
  for (const path of [`/ws/v1/${rogue.transferId}`, '/peerjs/peerjs?id=test&key=peerjs']) {
    assert.equal((await request(path, '192.0.2.3', { headers: { Upgrade: 'websocket', Origin: 'https://attacker.invalid' } })).status, 403);
  }
  console.log('PASS nonexistent rooms, content type, bounded body, opaque/cross-site Origin and relay/signaling upgrades');

  // All spellings and mapped IPv4 addresses must debit the same object.
  const spellings = ['2001:db8:11:21::1', '2001:0DB8:0011:0021:0000:0000:0000:0001', '2001:db8:11:21:abcd::2'];
  for (let i = 0; i < 12; i += 1) assert.equal((await request('/api/codes/88234', spellings[i % spellings.length])).status, 200);
  assert.equal((await request('/api/codes/78234', '2001:db8:11:21::ffff')).status, 429, 'different shard must share prefix budget');
  for (let i = 0; i < 12; i += 1) assert.equal((await request('/api/codes/78234', i % 2 ? '::ffff:c000:0204' : '192.0.2.4')).status, 200);
  assert.equal((await request('/api/codes/78234', '::ffff:192.0.2.4')).status, 429);
  const prefixName = 'code-prefix-v1-v6:2001:0db8:0011:0021/64';
  await mf.unsafeEvictDurableObject('cd-security', 'CodeDirectory', { name: prefixName });
  assert.equal((await request('/api/codes/78234', spellings[0])).status, 429, 'eviction must not reset budget');
  await (await sql(prefixName)).exec('UPDATE lookup_budget SET updated_at = updated_at - 60000');
  assert.equal((await request('/api/codes/78234', spellings[1])).status, 200, 'budget must refill');
  console.log('PASS canonical spellings, IPv4-mapped IPv6, cross-shard prefix budget, durable eviction and refill');

  // Concurrent calls from unrelated prefixes cannot multiply a shard budget.
  const beforeAggregate = legacyProbes;
  const aggregate = [];
  const aggregateStarted = Date.now();
  for (let i = 0; i < 10; i += 1) {
    aggregate.push(...await Promise.all(Array.from({ length: 6 }, (_, j) => request('/api/codes/68234', `2001:db8:${100 + i}:${j}::1`).then((res) => res.status))));
  }
  const aggregateAllowed = aggregate.filter((status) => status === 200).length;
  // Workerd may run slowly under parallel race tests. Refills during the
  // measured interval are legitimate, bounded at one additional probe/sec.
  assert.ok(aggregateAllowed >= 30 && aggregateAllowed <= 30 + Math.floor((Date.now() - aggregateStarted) / 1000), `aggregate allowed ${aggregateAllowed} probes outside burst/refill bound`);
  assert.ok(aggregate.filter((status) => status === 429).length >= 20, 'rotated prefixes bypassed aggregate throttle');
  assert.equal(legacyProbes - beforeAggregate, aggregateAllowed, 'aggregate denial must not probe legacy');
  const shardStore = await sql('codes-v2-6');
  const beforeEviction = await shardStore.exec('SELECT tokens, updated_at FROM lookup_budget');
  assert.ok(beforeEviction[0].tokens < 1, 'aggregate exhausted its burst');
  await mf.unsafeEvictDurableObject('cd-security', 'CodeDirectory', { name: 'codes-v2-6' });
  assert.deepEqual(await shardStore.exec('SELECT tokens, updated_at FROM lookup_budget'), beforeEviction, 'eviction reset durable aggregate budget');
  const afterEviction = await Promise.all(Array.from({ length: 6 }, (_, i) => request('/api/codes/68234', `198.51.100.${20 + i}`).then((res) => res.status)));
  const evictedAllowance = Math.floor(beforeEviction[0].tokens + (Date.now() - beforeEviction[0].updated_at) / 1000);
  assert.ok(afterEviction.filter((status) => status === 200).length <= evictedAllowance, 'evicted shard bypassed persisted budget');
  assert.equal((await request('/api/codes/58234', '198.51.100.20')).status, 200, 'unrelated shard remains usable');
  await (await sql('codes-v2-6')).exec('UPDATE lookup_budget SET updated_at = updated_at - 60000');
  assert.equal((await request('/api/codes/68234', '198.51.100.20')).status, 200);
  console.log('PASS bounded aggregate probes across rotated prefixes, concurrent requests, eviction, shard isolation and recovery');

  const cap = capability();
  const admitted = await socket(cap, '198.51.100.30', 'sender', false, { Origin: origin });
  assert.equal(admitted.accepted.type, 'accepted');
  assert.equal((await post({ ...cap, key: rogue.key }, '198.51.100.31')).status, 403, 'mismatched key');
  const claims = await Promise.all(Array.from({ length: 6 }, () => post(cap, '198.51.100.31', { Origin: origin }).then(async (response) => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return response.json();
  })));
  assert.equal(new Set(claims.map((claim) => claim.code)).size, 1, 'concurrent old-client claims must be idempotent');
  const claim = claims[0];
  await mf.unsafeEvictDurableObject('cd-security', 'TransferRoom', { name: cap.transferId, webSockets: 'hibernate' });
  const afterHibernate = await post(cap, '198.51.100.31');
  assert.equal(afterHibernate.status, 200);
  assert.deepEqual(await afterHibernate.json(), claim, 'room hibernation preserves code and authorization');
  const lookup = await request(`/api/codes/${claim.code}`, '198.51.100.32');
  assert.equal(lookup.status, 200);
  assert.deepEqual(await lookup.json(), cap);
  const guard = await sql('code-prefix-v1-v4:198.51.100.30');
  assert.equal((await guard.exec('SELECT COUNT(*) AS n FROM holds'))[0].n, 1, 'claim charged to sender prefix, not POST caller');
  await socket(cap, '198.51.100.32', 'receiver');
  await eventually(async () => (await guard.exec('SELECT COUNT(*) AS n FROM holds'))[0].n === 0, 'pairing did not release holding slot');
  assert.equal((await post(cap, '198.51.100.31')).status, 403, 'paired room cannot reclaim');
  assert.equal((await (await sql(`codes-v2-${claim.code[0]}`)).exec('SELECT COUNT(*) AS n FROM codes WHERE code = ?', claim.code))[0].n, 0);
  console.log('PASS same-origin old-client fallback, master-key proof, concurrent idempotency and pair cleanup');

  const badJoinCap = capability();
  const badJoin = await socket(badJoinCap, '198.51.100.35', 'sender', rogue.key);
  assert.equal(badJoin.accepted.code, undefined, 'join-time mismatched shareKey must not claim');
  assert.equal((await post({ ...badJoinCap, key: rogue.key }, '198.51.100.36')).status, 403);
  assert.equal((await post(badJoinCap, '198.51.100.36')).status, 200, 'correct admitted proof remains usable');
  badJoin.ws.close(1000, 'cancel');
  const badJoinStore = await sql('code-prefix-v1-v4:198.51.100.35');
  await eventually(async () => (await badJoinStore.exec('SELECT COUNT(*) AS n FROM holds'))[0].n === 0, 'cancelled room leaked lease');
  assert.equal((await post(badJoinCap, '198.51.100.36')).status, 403, 'closed room cannot claim');

  // Cross-object requests can race a sender cancellation. Regardless of
  // which wins admission, no code or holding slot may survive completion.
  for (let i = 0; i < 3; i += 1) {
    const racingCap = capability();
    const racingSender = await socket(racingCap, `198.51.100.${40 + i}`, 'sender', false);
    const claiming = post(racingCap, '198.51.100.45');
    racingSender.ws.close(1000, 'cancel during claim');
    const result = await claiming;
    assert.ok([200, 403].includes(result.status), `racing claim returned ${result.status}`);
    const racingStore = await sql(`code-prefix-v1-v4:198.51.100.${40 + i}`);
    await eventually(async () => (await racingStore.exec('SELECT COUNT(*) AS n FROM holds'))[0].n === 0, 'cancel/claim race leaked lease');
    if (result.status === 200) {
      const racedCode = (await result.json()).code;
      await eventually(async () => (await (await sql(`codes-v2-${racedCode[0]}`)).exec('SELECT COUNT(*) AS n FROM codes WHERE code = ?', racedCode))[0].n === 0, 'cancel/claim race leaked code');
    }
    assert.equal((await post(racingCap, '198.51.100.45')).status, 403);
  }
  console.log('PASS join-time master-key proof, closed-room denial and three actual cancellation/claim races');

  // The cap applies across all ten code shards and all addresses in one /64.
  const held = [];
  for (let i = 0; i < 16; i += 4) held.push(...await Promise.all(Array.from({ length: 4 }, (_, j) => socket(capability(), `2001:db8:40:50::${i + j + 1}`))));
  held.push(await socket(capability(), '2001:db8:40:50::17'));
  assert.equal(held.filter((entry) => /^\d{5}$/.test(entry.accepted.code ?? '')).length, 16);
  assert.equal(held[16].accepted.code, undefined, 'seventeenth concurrent holding must be rejected');
  const holds = await sql('code-prefix-v1-v6:2001:0db8:0040:0050/64');
  assert.equal((await holds.exec('SELECT COUNT(*) AS n FROM holds'))[0].n, 16);
  await mf.unsafeEvictDurableObject('cd-security', 'CodeDirectory', { name: 'code-prefix-v1-v6:2001:0db8:0040:0050/64' });
  assert.equal((await holds.exec('SELECT COUNT(*) AS n FROM holds'))[0].n, 16, 'holding cap survives eviction');
  held[0].ws.close(1000, 'sender cancelled');
  await eventually(async () => (await holds.exec('SELECT COUNT(*) AS n FROM holds'))[0].n === 15, 'sender close did not release slot');
  assert.match((await socket(capability(), '2001:db8:40:50::99')).accepted.code, /^\d{5}$/);
  // Expired orphan leases cannot permanently deny future senders. Advancing
  // fixture expiry exercises the real indexed cleanup used by hold().
  await holds.exec('UPDATE holds SET expires_at = ?', Date.now() - 1);
  assert.match((await socket(capability(), '2001:db8:40:50::100')).accepted.code, /^\d{5}$/);
  assert.equal((await holds.exec('SELECT COUNT(*) AS n FROM holds'))[0].n, 1);
  // A stale close must not remove the replacement room's lease.
  held[1].ws.close(1000, 'stale sender');
  await delay(100);
  assert.equal((await holds.exec('SELECT COUNT(*) AS n FROM holds'))[0].n, 1);
  console.log('PASS 16-code /64 bound across shards, sender-close release, orphan expiry and stale-release safety');

  const bindings = await mf.getBindings('cd-security');
  const expiryGuard = bindings.CODES.getByName('test-expiring-leases');
  const expiryStore = await sql('test-expiring-leases');
  const leasesExpireAt = Date.now() + 1500;
  for (let i = 0; i < 16; i += 1) assert.equal(await expiryGuard.hold(`lease-${i}`, leasesExpireAt), true);
  assert.equal(await expiryGuard.hold('blocked-lease', leasesExpireAt), false);
  await eventually(async () => (await expiryStore.exec('SELECT COUNT(*) AS n FROM holds'))[0].n === 0, 'real alarm did not expire orphan leases');
  assert.equal(await expiryGuard.hold('new-lease', Date.now() + 500), true);
  await expiryGuard.unhold('lease-0');
  assert.equal((await expiryStore.exec('SELECT COUNT(*) AS n FROM holds'))[0].n, 1);
  console.log('PASS actual scheduled alarm expires all orphan leases and old lease IDs cannot release replacements');

  // Repeated wrong guesses never delete or consume another user's live code.
  const survivor = capability();
  const survivorSender = await socket(survivor, '203.0.113.50');
  const survivorCode = survivorSender.accepted.code;
  await (await sql(`codes-v2-${survivorCode[0]}`)).exec('UPDATE lookup_budget SET updated_at = updated_at - 60000');
  const wrongCode = `${survivorCode[0]}${survivorCode.endsWith('0000') ? '0001' : '0000'}`;
  for (let i = 0; i < 15; i += 1) await request(`/api/codes/${wrongCode}`, '203.0.113.51');
  const survived = await request(`/api/codes/${survivorCode}`, '203.0.113.52');
  assert.equal(survived.status, 200);
  assert.deepEqual(await survived.json(), survivor);
  for (let i = 0; i < 12; i += 1) {
    const hit = await request(`/api/codes/${survivorCode}`, '203.0.113.53');
    assert.equal(hit.status, 200);
    assert.deepEqual(await hit.json(), survivor);
  }
  const throttledHit = await request(`/api/codes/${survivorCode}`, '203.0.113.53');
  assert.equal(throttledHit.status, 429, 'successful current-directory lookups must spend the same budget');
  assert.equal(throttledHit.headers.get('Retry-After'), '5');
  assert.equal(throttledHit.headers.get('Cache-Control'), 'no-store');
  console.log('PASS wrong guesses preserve individual codes and legitimate receiving');
  console.log('PASS all local Worker/DO code-directory security regressions');
} finally {
  for (const ws of sockets) { try { ws.close(1000, 'test complete'); } catch {} }
  await mf?.dispose();
  await rm(work, { recursive: true, force: true });
}
