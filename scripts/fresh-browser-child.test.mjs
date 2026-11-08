import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectBrowserTrial } from './fresh-browser-child.mjs';
import { stopChild } from './harness.mjs';

test('deadline retains earlier rows and the child final report', async () => {
  const work = await mkdtemp(join(tmpdir(), 'cd-browser-child-test-'));
  const path = join(work, 'report.json');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs';
    const rows = [{ route: 'auto', ok: true }];
    writeFileSync(process.argv[1], JSON.stringify({ rows }));
    process.on('SIGTERM', () => {
      rows.push({ route: 'relay', ok: false, error: 'interrupted' });
      writeFileSync(process.argv[1], JSON.stringify({ rows }));
      process.exit(1);
    });
    setInterval(() => {}, 1000);
    console.log('ready');
  `, path], { stdio: ['ignore', 'pipe', 'pipe'] });
  const done = once(child, 'close').then(([code]) => code);
  try {
    await once(child.stdout, 'data');
    const result = await collectBrowserTrial({ child, done }, path, 20);
    assert.match(result.error.message, /deadline exceeded/);
    assert.deepEqual(result.results.rows, [{ route: 'auto', ok: true }, { route: 'relay', ok: false, error: 'interrupted' }]);
    assert.notEqual(child.exitCode, null);
  } finally { await stopChild(child); await rm(work, { recursive: true, force: true }); }
});
