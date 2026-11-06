import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { buildCLI, captureOutput, childExit, cliEnv, startWorker, stopChild } from './harness.mjs';

// Linux /proc lets the lost-response scenario stop the parent after it forks
// the holder, before it can return readiness, without a production test hook.
assert.equal(process.platform, 'linux', 'retry verification requires Linux signals and /proc');
const work = await mkdtemp(join(tmpdir(), 'cd-verify-retries-'));
const stateDir = join(work, 'state');
const children = new Set();
const holders = new Set();
const measurements = [];
let worker;
let executable;
let env;
const sha = (data) => createHash('sha256').update(data).digest('hex');

async function poll(check, message, milliseconds = 10_000) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(5);
  }
  throw new Error(message);
}
function launch(args) {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  return { child, output: captureOutput(child) };
}
async function execute(args, timeout = 15_000) {
  const { child, output } = launch(args);
  const started = performance.now();
  const code = await childExit(child, timeout);
  await output.finished;
  return { code, ...output, milliseconds: performance.now() - started };
}
async function states() {
  let entries;
  try { entries = await readdir(stateDir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const found = [];
  for (const filename of entries.filter((name) => /^[A-Za-z0-9_-]{22}\.json$/.test(name))) {
    const state = JSON.parse(await readFile(join(stateDir, filename), 'utf8'));
    holders.add(state.pid);
    found.push(state);
  }
  return found;
}
async function send(requestId, path, flags = []) {
  const result = await execute(['send', '--json', '--request-id', requestId, ...flags, path]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal(result.stderr, '', 'default captured sends must stay quiet');
  return { ready: JSON.parse(result.stdout), milliseconds: result.milliseconds };
}
const idOf = (ready) => new URL(ready.url).pathname.split('/').at(-1);
async function stateOf(ready) {
  return (await states()).find((state) => state.transferId === idOf(ready));
}
async function expectFailure(requestId, path, kind, flags = []) {
  const result = await execute(['send', '--json', '--request-id', requestId, ...flags, path]);
  assert.equal(result.code, 1, `expected ${kind}: ${result.stderr}${result.stdout}`);
  const failure = JSON.parse(result.stdout);
  assert.equal(failure.error.kind, kind, result.stdout);
  assert.ok(failure.error.message.length > 0, 'failure needs an actionable message');
  assert.ok(failure.error.retry, 'failure needs explicit retry guidance');
  return failure;
}
async function record(name, operation) {
  const started = performance.now();
  const details = await operation();
  measurements.push({ scenario: name, passed: true, milliseconds: Number((performance.now() - started).toFixed(3)), ...details });
}
async function finish(ready, source, name) {
  const output = join(work, `${name}-received.bin`);
  const waiter = execute(['wait', '--json', '--timeout', '30s', '--', idOf(ready)], 35_000);
  const receiver = await execute(['receive', '--json', ready.code ?? ready.url, '--out', output], 35_000);
  assert.equal(receiver.code, 0, receiver.stderr + receiver.stdout);
  const waited = await waiter;
  assert.equal(waited.code, 0, `sender wait did not verify: ${waited.stdout}${waited.stderr}`);
  assert.equal(sha(await readFile(output)), sha(source), 'payload differs');
}
try {
  executable = await buildCLI(work);
  worker = await startWorker(work);
  env = cliEnv(worker, { CD_STATE_DIR: stateDir });
  const source = randomBytes(1_048_577);
  const sourcePath = join(work, 'payload.bin');
  await writeFile(sourcePath, source);
  await record('invalid request IDs and foreground requests are rejected', async () => {
    for (const requestId of ['../escape', 'spaces are unsafe', 'x'.repeat(129)]) {
      const result = await execute(['send', '--json', '--request-id', requestId, sourcePath]);
      assert.equal(result.code, 2, `invalid ID was accepted: ${requestId}`);
    }
    const foreground = await execute(['send', '--json', '--request-id', 'foreground', '--wait', sourcePath]);
    assert.equal(foreground.code, 2, 'request IDs must use detached sends');
    assert.equal((await states()).length, 0);
    return { invalidRequests: 4 };
  });
  let concurrentReady;
  await record('four simultaneous requests and exact completion', async () => {
    const requests = await Promise.all(Array.from({ length: 4 }, () => send('concurrent-request', sourcePath)));
    concurrentReady = requests[0].ready;
    for (const result of requests) assert.deepEqual(result.ready, concurrentReady);
    const persisted = await states();
    assert.equal(persisted.length, 1, 'concurrent requests created multiple holders');
    assert.equal(persisted[0].transferId, idOf(concurrentReady));
    assert.ok(persisted[0].pid > 0);
    await finish(concurrentReady, source, 'concurrent');
    const completedReplay = (await send('concurrent-request', sourcePath)).ready;
    assert.equal(idOf(completedReplay), idOf(concurrentReady), 'completed request replay changed transfer');
    assert.equal(completedReplay.url, concurrentReady.url, 'completed request replay changed capability');
    assert.ok(!completedReplay.code, 'completed replay retained a consumed share code');
    return { requests: 4, holders: 1, readinessMilliseconds: requests.map((request) => Number(request.milliseconds.toFixed(3))), bytesVerified: source.length };
  });
  await record('changed content path and options cannot reuse identity', async () => {
    const changed = Buffer.from(source);
    changed[0] ^= 1;
    await writeFile(sourcePath, changed);
    await expectFailure('concurrent-request', sourcePath, 'request_conflict');
    await writeFile(sourcePath, source);
    const copy = join(work, 'same-bytes-different-path.bin');
    await writeFile(copy, source);
    await expectFailure('concurrent-request', copy, 'request_conflict');
    await expectFailure('concurrent-request', sourcePath, 'request_conflict', ['--link']);
    assert.equal((await states()).length, 1, 'conflicts created a holder');
    return { conflictsVerified: 3 };
  });
  await record('changed bytes after readiness cannot publish a file', async () => {
    const { ready } = await send('changed-after-ready', sourcePath);
    const changed = Buffer.from(source);
    changed[0] ^= 1;
    await writeFile(sourcePath, changed);
    const destination = join(work, 'changed-after-ready.bin');
    const waiter = execute(['wait', '--json', '--timeout', '30s', '--', idOf(ready)], 35_000);
    const receiver = await execute(['receive', '--json', ready.code, '--out', destination], 35_000);
    assert.equal(receiver.code, 1, 'receiver accepted bytes that changed after request reservation');
    assert.equal((await waiter).code, 1, 'sender accepted changed request bytes');
    await assert.rejects(readFile(destination), { code: 'ENOENT' }, 'failed receive published final destination');
    const replacement = await send('changed-new-request', sourcePath);
    await finish(replacement.ready, changed, 'changed-new-request');
    await writeFile(sourcePath, source);
    return { changedBytesRejected: source.length, replacementBytesVerified: changed.length };
  });
  await record('lost parent response replays persisted holder readiness', async () => {
    // A large tree gives /proc observation time between fork and readiness.
    const folder = join(work, 'slow-preparation');
    await mkdir(folder);
    for (let i = 0; i < 1000; i += 1) await writeFile(join(folder, `file-${i}`), Buffer.alloc(64 * 1024));
    const parent = launch(['send', '--json', '--request-id', 'lost-response', folder]);
    const holderPID = await poll(async () => {
      try {
        // Go may fork from any runtime OS thread, so inspect every task.
        const tasks = await readdir(`/proc/${parent.child.pid}/task`);
        for (const task of tasks) {
          try {
            const pids = (await readFile(`/proc/${parent.child.pid}/task/${task}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
            if (pids.length) return Number(pids[0]);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (parent.child.exitCode !== null) throw new Error(`parent exited before holder observation: ${parent.output.stderr}${parent.output.stdout}`);
        return false;
      } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }, 'parent exited before its holder could be observed');
    holders.add(holderPID);
    parent.child.kill('SIGSTOP');
    const state = await poll(async () => (await states()).find((state) => state.pid === holderPID && state.phase === 'waiting'), 'holder never persisted readiness while parent stopped');
    parent.child.kill('SIGKILL');
    await childExit(parent.child);
    await parent.output.finished;
    const retry = await send('lost-response', folder);
    assert.equal(idOf(retry.ready), state.transferId);
    assert.equal(retry.ready.code, state.code);
    assert.equal((await stateOf(retry.ready)).pid, holderPID, 'lost response spawned another holder');
    const output = join(work, 'lost-response-files');
    const receiver = await execute(['receive', '--json', retry.ready.code, '--out', output], 35_000);
    assert.equal(receiver.code, 0, receiver.stderr + receiver.stdout);
    assert.equal((await execute(['wait', '--json', '--timeout', '30s', '--', state.transferId], 35_000)).code, 0);
    const received = JSON.parse(receiver.stdout);
    assert.equal(received.size, state.size);
    assert.equal(received.files.length, 1000, 'bundle must unpack every file');
    assert.equal((await readdir(output)).join(), 'slow-preparation');
    assert.equal((await readdir(join(output, 'slow-preparation'))).length, 1000);
    const expectedHash = sha(Buffer.alloc(64 * 1024));
    for (let index = 0; index < 1000; index += 1) {
      assert.equal(sha(await readFile(join(output, 'slow-preparation', `file-${index}`))), expectedHash, `file-${index} differs`);
    }
    return { holderPID, originalTransferId: state.transferId, filesVerified: 1000, bytesVerified: 1000 * 64 * 1024, replayMilliseconds: Number(retry.milliseconds.toFixed(3)) };
  });
  for (const [name, signal, kind] of [['stale holder', 'SIGKILL', 'disconnected'], ['cancellation', 'SIGTERM', 'canceled']]) {
    await record(name, async () => {
      const requestId = name.replaceAll(' ', '-');
      const { ready } = await send(requestId, sourcePath);
      const state = await stateOf(ready);
      process.kill(state.pid, signal);
      await poll(async () => {
        const result = await execute(['status', '--json', '--', idOf(ready)]);
        return JSON.parse(result.stdout).phase === 'failed';
      }, `${name} never became failed`);
      const failure = await expectFailure(requestId, sourcePath, kind);
      assert.equal((await states()).filter((entry) => entry.transferId === state.transferId).length, 1);
      return { kind: failure.error.kind, retry: failure.error.retry };
    });
  }
  console.log(JSON.stringify({ version: 1, passed: measurements.length, failed: 0, measurements }));
} finally {
  try {
    for (const child of children) await stopChild(child);
    try { await states(); } catch {}
    for (const pid of holders) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await poll(async () => {
      for (const pid of holders) {
        try {
          const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
          if (!/\)\s+[ZX]/.test(stat)) return false;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return true;
    }, 'cleanup left a live background holder', 3000);
  } finally {
    await worker?.stop();
    await rm(work, { recursive: true, force: true });
  }
}
