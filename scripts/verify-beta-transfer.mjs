import assert from 'node:assert/strict';
import { sanitizeDiagnostic } from './v2-browser-diagnostics.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCLI, childExit, cliEnv, firstLine, startWorker, stopChild } from './harness.mjs';

const work = await mkdtemp(join(tmpdir(), 'cd-beta-'));
const children = [];
let worker;
try {
  worker = await startWorker(work);
  const executable = await buildCLI(work);
  const env = cliEnv(worker, { CD_STATE_DIR: join(work, 'state'), CD_DIRECT: '0' });
  const source = join(work, 'payload.bin');
  const payload = randomBytes(1048653);
  await writeFile(source, payload);
  for (const resumable of [false, true]) {
    const sender = spawn(executable, ['send', '--json', ...(resumable ? ['--resumable'] : ['--link', '--wait']), source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(sender);
    sender.stderr.resume();
    const ready = JSON.parse(await firstLine(sender.stdout, 20000));
    assert.ok(ready.url, 'sender did not publish an invitation');
    const destination = join(work, resumable ? 'v2.bin' : 'v1.bin');
    const receiver = spawn(executable, ['receive', '--json', ready.url, '--out', destination], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(receiver);
    receiver.stdout.resume();
    let failure = '';
    receiver.stderr.on('data', chunk => { failure += chunk; });
    assert.equal(await childExit(receiver, 60000), 0, `receiver failed: ${sanitizeDiagnostic(failure)}`);
    assert.equal(await childExit(sender, 30000), 0, 'sender failed');
    assert.deepEqual(await readFile(destination), payload);
    console.log(`PASS ${resumable ? 'v2 private resumable' : 'v1 private'} relay: ${payload.length} exact bytes`);
  }
} finally {
  for (const child of children) await stopChild(child);
  await worker?.stop();
  await rm(work, { recursive: true, force: true });
}
