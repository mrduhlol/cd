// Same random file, serial runs, complete output hashes. No historical timings.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir, hostname, loadavg } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { availablePort, buildCLI, cliEnv, startWorker, stopChild } from './harness.mjs';

const mib = Number(process.env.CD_FRESH_MIB ?? 600), runs = Number(process.env.CD_FRESH_RUNS ?? 3);
const timeout = Number(process.env.CD_FRESH_TIMEOUT_MS ?? 180000);
const croc = resolve(process.env.CD_FRESH_CROC ?? '/tmp/cd-croc-11.6.5/croc');
const output = resolve(process.env.CD_FRESH_OUTPUT ?? '/tmp/cd-compare-fresh.json');
assert.ok(Number.isSafeInteger(mib) && mib > 0 && Number.isSafeInteger(runs) && runs > 0);
assert.ok(Number.isSafeInteger(timeout) && timeout > 0);
assert.equal(process.env.CD_VERIFY_URL, undefined, 'this comparison requires local services');
const work = await mkdtemp(join(tmpdir(), 'cd-compare-fresh-'));
const children = new Set();
const report = { schema: 1, startedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), host: hostname(), load: loadavg(), mib, runs, rows: [],
  method: 'All tools receive the same independently generated random file on one Linux host. Browser pages preload; readiness is separate. Receive timing includes receiver startup or code entry through full saved output, without fsync. Full SHA-256 and byte count checked outside timing. OS cache allowed. croc CLI forced to TCP relay; CD CLI forced to WebSocket relay. CD browser auto may use WebRTC. HTTP is an unencrypted ceiling diagnostic, not a secure file-transfer competitor. No WAN or physical-phone claim.' };
let worker, relay, http;
function launch(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
  const proc = { child, text: '' };
  child.once('error', error => { proc.error = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { proc.text = (proc.text + data).slice(-65536); });
  proc.done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  proc.done.catch(() => {});
  return proc;
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('transfer deadline exceeded')), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function ready(process, pattern) {
  const deadline = performance.now() + timeout;
  for (;;) {
    if (process.error) throw process.error;
    const match = process.text.match(pattern);
    if (match) return match;
    if (process.child.exitCode !== null || process.child.signalCode !== null) throw new Error('sender exited before readiness');
    if (performance.now() > deadline) throw new Error('sender readiness deadline exceeded');
    await delay(10);
  }
}
async function digest(path) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(path)) { bytes += chunk.length; hash.update(chunk); }
  return { bytes, sha256: hash.digest('hex') };
}
async function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1'); socket.setTimeout(200);
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
  });
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  report.interrupted = signal;
  void Promise.allSettled([...children].map(stopChild));
});
try {
  const input = join(work, 'payload.bin'), file = await open(input, 'w');
  try { for (let index = 0; index < mib; index++) await file.writeFile(randomBytes(1048576)); }
  finally { await file.close(); }
  const expected = await digest(input); report.input = expected;
  report.benchmarkSHA256 = (await digest('scripts/bench-transfer-compare-fresh.mjs')).sha256;
  report.runtimeOverride = process.env.MINIFLARE_WORKERD_PATH ? execFileSync(process.env.MINIFLARE_WORKERD_PATH, ['--version'], { encoding: 'utf8' }).trim() : null;
  const executable = await buildCLI(work);
  report.cdx = await digest(executable); report.croc = { ...await digest(croc), version: execFileSync(croc, ['--version'], { encoding: 'utf8' }).trim() };
  worker = await startWorker(join(work, 'worker'));
  const ports = []; while (ports.length < 5) { const port = await availablePort(); if (!ports.includes(port)) ports.push(port); }
  relay = launch(croc, ['relay', '--host', '127.0.0.1', '--ports', ports.join(',')]);
  for (let index = 0; !await portOpen(ports[0]); index++) { assert.ok(index < 100, 'croc relay failed to start'); await delay(50); }
  http = createServer((request, response) => {
    if (request.url !== '/payload') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Length': expected.bytes });
    void pipeline(createReadStream(input), response).catch(() => response.destroy());
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const tools = ['cd-browser', 'cd-cli-relay', 'croc-cli-relay', 'http-ceiling'];
  for (let run = 0; run < runs; run++) for (const tool of tools.slice(run % tools.length).concat(tools.slice(0, run % tools.length))) {
    if (report.interrupted) throw new Error('benchmark interrupted');
    const row = { run, tool, ok: false }, active = [];
    const directory = join(work, `receive-${run}-${tool}`); await mkdir(directory);
    const target = join(directory, 'payload.bin');
    try {
      if (tool === 'cd-browser') {
        const browserOutput = join(work, `browser-${run}.json`);
        const browser = launch(process.execPath, ['scripts/bench-transfer-fresh.mjs'], { ...process.env, CD_FRESH_INPUT: input, CD_FRESH_OUTPUT: browserOutput, CD_FRESH_RUNS: '1' }); active.push(browser.child);
        const code = await bounded(browser.done);
        const results = JSON.parse(await readFile(browserOutput, 'utf8'));
        report.rows.push(...results.rows.map(result => ({ ...result, run, tool, browserCommit: results.commit, input: results.input, load: results.load })));
        assert.equal(code, 0, 'browser child failed; see retained rows');
        assert.equal(results.rows.length, 2);
        assert.ok(results.rows.every(result => result.ok && result.received.sha256 === expected.sha256 && result.received.bytes === expected.bytes));
        continue;
      }
      const start = performance.now();
      if (tool === 'http-ceiling') {
        row.readyMs = 0;
        const response = await fetch(`http://127.0.0.1:${http.address().port}/payload`, { signal: AbortSignal.timeout(timeout) });
        assert.equal(response.status, 200); await pipeline(response.body, createWriteStream(target));
        row.receiveMs = performance.now() - start;
      } else {
        const native = tool === 'cd-cli-relay';
        const env = native ? cliEnv(worker, { CD_STATE_DIR: join(directory, 'state'), CD_DIRECT: '0', CD_TRANSPORT_REPORT: '1' }) : { ...process.env, CROC_SECRET: randomBytes(16).toString('hex'), CROC_NO_UPDATE_CHECK: '1' };
        const flags = ['--ignore-stdin', '--relay', `127.0.0.1:${ports[0]}`, '--relay6', `127.0.0.1:${ports[0]}`, '--yes', '--overwrite', '--disable-clipboard'];
        const sender = native ? launch(executable, ['send', '--wait', input], env) : launch(croc, [...flags, 'send', '--transport', 'relay', '--no-local', input], env); active.push(sender.child);
        const marker = await ready(sender, native ? /^(\d{4,5})\s*$/m : /Code is:|On the other computer, run:/);
        row.readyMs = performance.now() - start;
        const receive = performance.now();
        const receiver = native ? launch(executable, ['receive', marker[1], '--out', target], env) : launch(croc, [...flags, '--out', directory], env); active.push(receiver.child);
        assert.equal(await bounded(receiver.done), 0, 'receiver failed'); row.receiveMs = performance.now() - receive;
        assert.equal(await bounded(sender.done), 0, 'sender failed');
        if (native) {
          row.transport = (sender.text + '\n' + receiver.text).split('\n').flatMap(line => { try { const item = JSON.parse(line); return item.transport ? [item] : []; } catch { return []; } });
          assert.ok(row.transport.length > 0 && row.transport.every(item => item.directBytes === 0), 'missing forced-relay evidence');
        } else row.transport = { requested: 'relay', noLocal: true, multiplexing: 'default', compression: 'default' };
      }
      row.received = await digest(target); assert.deepEqual(row.received, expected);
      row.mibPerSecond = mib / (row.receiveMs / 1000); row.ok = true;
    } catch (error) { row.error = error.message; }
    finally { for (const child of active) { await stopChild(child); children.delete(child); } await rm(directory, { recursive: true, force: true }); }
    report.rows.push(row); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(row));
  }
} catch (error) { report.error = error.message; }
finally {
  for (const child of children) await stopChild(child);
  http?.closeAllConnections(); if (http) await new Promise(resolve => http.close(resolve));
  await worker?.stop(); await rm(work, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
}
if (report.error || report.rows.length !== runs * 5 || report.rows.some(row => !row.ok)) process.exitCode = 1;
console.log(JSON.stringify({ output, error: report.error, rows: report.rows.length }));
