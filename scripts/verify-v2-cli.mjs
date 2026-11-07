import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { childExit, cliEnv, firstLine, startWorker, stopChild } from './harness.mjs';

// Exercise private transfers and restart recovery against the candidate CLI.
assert.ok(process.env.CD_V2_VERIFY_CLI, 'Set CD_V2_VERIFY_CLI to a verified v2-capable cdx binary');
assert.equal(process.env.CD_VERIFY_URL, undefined, 'This verification starts an isolated local Worker');
function captureOutput(child) {
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return { get stdout() { return stdout; }, get stderr() { return stderr; },
    finished: new Promise(resolve => child.once('close', resolve)) };
}

const work = await mkdtemp(join(tmpdir(), 'cd-verify-v2-cli-'));
const children = new Set();
const measurements = [];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
let worker;
let executable;
let env;
function launch(args) {
  const child = spawn(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  return { child, output: captureOutput(child) };
}
async function execute(args, timeout = 15000) {
  const command = launch(args);
  const code = await childExit(command.child, timeout);
  await command.output.finished;
  return { code, ...command.output };
}
async function ready(args) {
  const command = launch(args);
  const value = JSON.parse(await firstLine(command.child.stdout, 15000));
  assert.equal(value.version, 2, JSON.stringify(value));
  assert.match(value.url, /#v2\./);
  return { ...command, ready: value };
}
async function poll(check, message, timeout = 15000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(3);
  }
  throw new Error(message);
}
async function checkpoint(root, directory, size) {
  const path = join(directory, `.cd-${root}.checkpoint.json`);
  const value = await poll(async () => {
    try {
      const cp = JSON.parse(await readFile(path, 'utf8'));
      return cp.offset > 0 && cp.offset < size ? cp : null;
    } catch { return null; }
  }, 'receiver did not persist an incomplete verified checkpoint');
  return { path, value };
}
async function interrupted(name, source, size) {
  const directory = join(work, name);
  await mkdir(directory);
  const destination = join(directory, 'payload.bin');
  const sender = await ready(['send', '--resumable', '--json', source]);
  const root = sender.ready.transferId ?? new URL(sender.ready.url).pathname.split('/').at(-1);
  const receiver = launch(['receive', '--json', sender.ready.url, '--out', destination]);
  const cp = await checkpoint(root, directory, size);
  receiver.child.kill('SIGKILL');
  await childExit(receiver.child, 10000);
  await childExit(sender.child, 10000);
  await sender.output.finished;
  cp.value = JSON.parse(await readFile(cp.path, 'utf8'));
  return { root, sender, destination, directory, checkpoint: cp };
}
try {
  executable = process.env.CD_V2_VERIFY_CLI;
  worker = await startWorker(work);
  env = cliEnv(worker, { CD_STATE_DIR: join(work, 'state') });
  const payload = randomBytes(Number(process.env.CD_RESUME_MIB ?? 32) * 1024 * 1024 + 77);
  const source = join(work, 'payload.bin');
  await writeFile(source, payload);

  const started = performance.now();
  const first = await interrupted('restart', source, payload.length);
  assert.equal(first.checkpoint.value.prefixSha256, sha(payload.subarray(0, first.checkpoint.value.offset)));
  const resumed = await ready(['send', '--resume', first.root, '--json', source]);
  assert.equal(resumed.ready.transferId, first.root);
  const received = await execute(['receive', '--resume', '--json', resumed.ready.url, '--out', first.destination], 30000);
  assert.equal(received.code, 0, received.stderr + received.stdout);
  const result = JSON.parse(received.stdout.trim().split('\n').at(-1));
  assert.equal(result.resumedBytes, first.checkpoint.value.offset);
  assert.equal(await childExit(resumed.child, 30000), 0, resumed.output.stderr);
  assert.equal(sha(await readFile(first.destination)), sha(payload));
  measurements.push({ scenario: 'cli-restart', passed: true, verifiedRetainedBytes: first.checkpoint.value.offset, exactBytes: payload.length, milliseconds: Math.round(performance.now() - started) });

  const second = await interrupted('changed', source, payload.length);
  const changed = Buffer.from(payload);
  changed[0] ^= 1;
  await writeFile(source, changed);
  const rejected = await execute(['send', '--resume', second.root, '--json', source]);
  assert.equal(rejected.code, 1, rejected.stdout + rejected.stderr);
  assert.ok(rejected.stderr.length, 'changed source failure needs an explanation');
  await writeFile(source, payload);
  measurements.push({ scenario: 'same-size-source-change', passed: true });

  const cp = second.checkpoint.value;
  await writeFile(second.checkpoint.path, JSON.stringify({ ...cp, offset: cp.offset + 262144 }));
  const tamperedSender = await ready(['send', '--resume', second.root, '--json', source]);
  const tampered = await execute(['receive', '--resume', '--json', tamperedSender.ready.url, '--out', second.destination]);
  assert.equal(tampered.code, 1, tampered.stdout + tampered.stderr);
  assert.ok(tampered.stderr.length, 'tampered checkpoint needs an explanation');
  await stopChild(tamperedSender.child);
  await assert.rejects(readFile(second.destination), { code: 'ENOENT' });
  measurements.push({ scenario: 'checkpoint-tamper', passed: true });
  console.log(JSON.stringify({ version: 1, completed: measurements.length, measurements }));
} finally {
  for (const child of children) await stopChild(child);
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
