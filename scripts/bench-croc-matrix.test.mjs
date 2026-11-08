import test from 'node:test';
import assert from 'node:assert/strict';
import { median, summarize, cases } from './bench-croc-matrix.mjs';
function row(tool, value, extra = {}) {
  return { tool, storage: 'tmpfs', route: 'auto', case: 'random-4k', ok: true, readyMs: value, receiverMs: value, durableMs: value, totalMs: value * 2, ...extra };
}
test('median uses middle pair and does not mutate samples', () => {
  const values = [9, 1, 7, 3]; assert.equal(median(values), 5); assert.deepEqual(values, [9, 1, 7, 3]);
});
test('gate requires every timing metric against both croc configurations', () => {
  const passing = [row('cd', 10), row('croc', 22), row('croc-no-compress', 21)];
  assert.equal(summarize(passing, 1)[0].pass2, true);
  assert.equal(summarize([...passing.slice(0, 2), row('croc-no-compress', 21, { readyMs: 14 })], 1)[0].pass1_5, false);
});
test('failed, missing or incomplete repetitions never pass', () => {
  const rows = [row('cd', 1), row('croc', 9), row('croc-no-compress', 9)];
  assert.equal(summarize(rows, 2)[0].pass1_5, false);
  assert.equal(summarize(rows.slice(0, 2), 1)[0].pass1_5, false);
  assert.equal(summarize([...rows.slice(0, 2), row('croc-no-compress', 9, { ok: false })], 1)[0].pass1_5, false);
});
test('matrix includes random and compressible small, medium and bulk payloads', () => {
  assert.deepEqual(Object.keys(cases), ['random-4k', 'random-1m', 'random-64m', 'random-256m', 'compressible-4k', 'compressible-1m', 'compressible-64m', 'compressible-256m']);
});
test('summary exposes spread while gating median results', () => {
  const rows = ['cd', 'croc', 'croc-no-compress'].flatMap(tool => [row(tool, tool === 'cd' ? 2 : 8), row(tool, tool === 'cd' ? 4 : 12)]);
  const summary = summarize(rows, 2)[0];
  assert.equal(summary.tools.cd.durableMs, 3);
  assert.deepEqual(summary.tools.cd.spread.durableMs, { min: 2, max: 4 });
  assert.equal(summary.pass2, true);
});
test('benchmark worker has isolated rate namespaces and no deployment routes', async () => {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(new URL('./bench-worker.wrangler.jsonc', import.meta.url), 'utf8');
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
  assert.equal(config.workers_dev, false);
  assert.deepEqual(config.routes, []);
  assert.equal(config.main, '../worker/index.ts');
  assert.deepEqual(config.ratelimits.map(binding => binding.namespace_id), ['9237491', '9237492']);
  assert.ok(config.ratelimits.every(binding => binding.simple.limit >= 100000));
  assert.deepEqual(config.durable_objects.bindings.map(binding => binding.name), ['TRANSFERS', 'PEERS', 'CODES', 'DEVICES']);
});

test('input manifests preserve filenames, empty directories and every file hash', async () => {
  const { mkdtemp, mkdir, writeFile, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { manifest } = await import('./bench-croc-matrix.mjs');
  const root = await mkdtemp(join(tmpdir(), 'cd-task-manifest-'));
  try {
    const input = join(root, 'project');
    await mkdir(join(input, 'empty'), { recursive: true });
    await writeFile(join(input, 'readme.md'), 'hello');
    assert.deepEqual(await manifest(input), [
      { name: 'project', directory: true },
      { name: 'project/empty', directory: true },
      { name: 'project/readme.md', size: 5, sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' }
    ]);
    const before = await manifest(input);
    await writeFile(join(input, 'readme.md'), 'HELLO');
    assert.notDeepEqual(await manifest(input), before);
    if (process.platform !== 'win32') {
      await symlink(join(input, 'readme.md'), join(input, 'linked'));
      await assert.rejects(manifest(input), /unsupported benchmark input/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real-task fixtures contain actual source, a readable archive and a mixed folder', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'cd-real-task-fixtures-'));
  try {
    execFileSync(process.execPath, [new URL('./bench-real-task-fixtures.mjs', import.meta.url).pathname, root]);
    assert.deepEqual(await readFile(join(root, 'small-file.go')), await readFile(new URL('../cmd/cdx/protocol.go', import.meta.url)));
    const entries = execFileSync('tar', ['-tzf', join(root, 'source-tree.tar.gz')], { encoding: 'utf8' });
    assert.match(entries, /source-tree\/cmd\/cdx\/protocol.go/);
    assert.deepEqual(await readFile(join(root, 'mixed/project-backup.tar.gz')), await readFile(join(root, 'source-tree.tar.gz')));
    assert.equal(JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8')).length, 4);
    assert.throws(() => execFileSync(process.execPath, [new URL('./bench-real-task-fixtures.mjs', import.meta.url).pathname, root], { stdio: 'pipe' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('croc zip mode rejects values other than explicit 0 or 1', async () => {
  const { main } = await import('./bench-croc-matrix.mjs');
  await assert.rejects(main(['--croc-zip', 'true']), /--croc-zip must be 0 or 1/);
});
