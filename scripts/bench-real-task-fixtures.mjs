// Build ordinary tasks from this checkout once, then use the same frozen
// inputs for each candidate. This does not download private/user data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] || '/tmp/cd-real-tasks');
await mkdir(root, { recursive: true });
for (const name of ['source-tree', 'source-tree.tar.gz', 'mixed', 'small-file.go']) {
  await assert.rejects(stat(join(root, name)), { code: 'ENOENT' }, `${name} already exists; choose a fresh output directory`);
}
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
for (const name of ['cmd/cdx', 'src', 'docs/guides']) {
  await cp(join(repo, name), join(root, 'source-tree', name), { recursive: true });
}
const tar = spawnSync('tar', ['-czf', join(root, 'source-tree.tar.gz'), '-C', root, 'source-tree'], { encoding: 'utf8' });
assert.equal(tar.status, 0, `tar failed: ${tar.stderr || tar.error}`);
await cp(join(root, 'source-tree'), join(root, 'mixed', 'project'), { recursive: true });
await cp(join(root, 'source-tree.tar.gz'), join(root, 'mixed', 'project-backup.tar.gz'));
await mkdir(join(root, 'mixed', 'empty-directory'));
await cp(join(repo, 'cmd/cdx/protocol.go'), join(root, 'small-file.go'));
const tasks = ['small-file.go', 'source-tree', 'source-tree.tar.gz', 'mixed'].map(name => ({
  name, input: join(root, name),
  command: `node scripts/bench-croc-matrix.mjs --cdx /absolute/candidate --input ${JSON.stringify(join(root, name))} --routes auto,relay --storage disk --runs 3 --output ${JSON.stringify(join(root, name + '-results.json'))}`
}));
await writeFile(join(root, 'tasks.json'), JSON.stringify(tasks, null, 2) + '\n');
console.log(JSON.stringify({ root, tasks }, null, 2));
