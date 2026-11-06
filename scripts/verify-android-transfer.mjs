import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { buildCLI, childExit, stopChild, withTimeout } from './harness.mjs';

// Pair the emulator through the real Trust screen first. This script never
// installs credentials or changes receiving preferences on the phone.
const serial = process.env.CD_VERIFY_ANDROID_SERIAL;
assert.ok(serial?.startsWith('emulator-'), 'Set CD_VERIFY_ANDROID_SERIAL to an Android emulator serial');
const device = process.env.CD_VERIFY_DEVICE_NAME;
assert.ok(device && process.env.CD_DEVICE_DIR && process.env.CD_STATE_DIR,
  'Set CD_VERIFY_DEVICE_NAME, CD_DEVICE_DIR and CD_STATE_DIR to an existing test pairing');
const route = process.env.CD_VERIFY_ANDROID_ROUTE ?? 'local';
assert.ok(['local', 'relay', 'webrtc'].includes(route));
assert.ok(process.env.CD_VERIFY_ANDROID_KILL_PROCESS !== '1' || process.env.CD_VERIFY_ANDROID_INTERRUPT === '1',
  'Process recovery also requires CD_VERIFY_ANDROID_INTERRUPT=1');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const adb = process.env.ADB ?? (sdk ? join(sdk, 'platform-tools', 'adb') : 'adb');
const work = await mkdtemp(join(tmpdir(), 'cd-android-transfer-'));
let sender;
let screenOff = false;
async function command(executable, args) {
  const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const code = await childExit(child, 30_000);
  assert.equal(code, 0, stderr || `${executable} failed`);
  return stdout;
}
const android = args => command(adb, ['-s', serial, ...args]);
async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
try {
  assert.equal((await android(['shell', 'getprop', 'ro.kernel.qemu'])).trim(), '1', 'Integration checks require an emulator');
  const executable = process.env.CD_VERIFY_CLI ?? await buildCLI(work);
  const name = `verify-${route}-${Date.now()}.bin`;
  const source = join(work, name);
  const file = await open(source, 'wx');
  const mebibytes = Number(process.env.CD_VERIFY_ANDROID_MIB ?? 128);
  assert.ok(Number.isInteger(mebibytes) && mebibytes >= 8 && mebibytes <= 512);
  try {
    for (let i = 0; i < mebibytes; i++) await file.write(randomBytes(1024 * 1024));
  } finally { await file.close(); }
  const env = { ...process.env, CD_DEVICE_LAN: route === 'local' ? '1' : '0', CD_DIRECT: route === 'relay' ? '0' : '1' };
  let output = '';
  const launch = () => {
    const child = spawn(executable, ['send', '--to', device, '--wait', '--json', '--progress', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { output += data; });
    return child;
  };
  sender = launch();
  if (process.env.CD_VERIFY_ANDROID_SCREEN_OFF === '1') {
    await android(['shell', 'input', 'keyevent', '223']);
    screenOff = true;
  }
  if (process.env.CD_VERIFY_ANDROID_INTERRUPT === '1') {
    const retained = await withTimeout((async () => {
      for (;;) {
        const match = output.match(/"transferId":"([A-Za-z0-9_-]+)"/);
        if (match) {
          const files = await android(['shell', 'run-as', 'in.yash0.cd', 'ls', '-l', 'files']);
          const partial = files.split('\n').find(line => line.endsWith(`resume-${match[1]}.part`));
          const checkpointName = `resume-${match[1]}.json`;
          if (partial && Number(partial.trim().split(/\s+/)[4]) >= 1048576 && files.split('\n').some(line => line.endsWith(checkpointName))) {
            const checkpoint = JSON.parse(await android(['shell', 'run-as', 'in.yash0.cd', 'cat', `files/${checkpointName}`]));
            if (checkpoint.offset >= 1048576) return { root: match[1], committed: checkpoint.offset };
          }
        }
        assert.equal(sender.exitCode, null, `Sender ended before interruption: ${output.slice(-2000)}`);
        await delay(100);
      }
    })(), 90_000, 'No durable staging progress before interruption');
    await stopChild(sender);
    if (process.env.CD_VERIFY_ANDROID_KILL_PROCESS === '1') {
      const pid = (await android(['shell', 'pidof', '-s', 'in.yash0.cd'])).trim();
      assert.match(pid, /^\d+$/, 'No running CD process to interrupt');
      await android(['shell', 'run-as', 'in.yash0.cd', 'kill', '-9', pid]);
    }
    output = '';
    sender = launch();
    assert.equal(await childExit(sender, 180_000), 0, output.slice(-2000));
    assert.ok(output.includes(`Resuming retained transfer ${retained.root}`), 'Identical rerun did not retain the same root');
    const progress = output.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).find(value => value.progress?.phase === 'sending');
    assert.ok(progress?.progress.done >= retained.committed, 'Receiver restarted below its durable retained checkpoint');
  } else {
    assert.equal(await childExit(sender, 180_000), 0, output.slice(-2000));
  }
  const root = output.match(/"transferId":"([A-Za-z0-9_-]+)"/)?.[1];
  assert.ok(root, 'No targeted transfer root was reported');
  const logs = await android(['logcat', '-d', '-s', 'CD']);
  if (route === 'local') assert.ok(logs.includes(`root=${root} route=local`), 'Android did not use the LAN data endpoint');
  else if (route === 'webrtc') assert.ok(output.includes('"transport":"webrtc"'), 'No native P2P switch was observed');
  else {
    assert.ok(logs.includes(`root=${root} route=relay`), 'Android did not use the relay');
    assert.ok(!output.includes('"transport":"webrtc"'), 'Forced relay unexpectedly used P2P');
  }
  const received = join(work, 'received.bin');
  await android(['pull', `/sdcard/Download/CD/${name}`, received]);
  assert.equal(await digest(received), await digest(source), 'Published Android bytes differ from the CLI source');
  await android(['shell', 'rm', `/sdcard/Download/CD/${name}`]);
  console.log(`Verified ${mebibytes} MiB CLI → Android ${route}, published SHA-256 matches${process.env.CD_VERIFY_ANDROID_INTERRUPT === '1' ? ', CLI restart kept the same root' : ''}${process.env.CD_VERIFY_ANDROID_KILL_PROCESS === '1' ? ', Android process restart' : ''}${screenOff ? ', screen off' : ''}.`);
} finally {
  await stopChild(sender);
  if (screenOff) await android(['shell', 'input', 'keyevent', '224']).catch(() => {});
  await rm(work, { recursive: true, force: true });
}
