import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// A conservative loopback floor, below every retained 600 MiB trial.
// This catches KB/s stalls; it does not certify WAN or physical-phone speed.
export function transferGateErrors(report) {
  const errors = [];
  if (report?.schema !== 1 || !Number.isInteger(report.runs) || report.runs < 3) return ['three or more fresh repetitions are required'];
  const bytes = report.input?.bytes, hash = report.input?.sha256;
  if (!Number.isSafeInteger(bytes) || bytes < 64 * 1048576 || !/^[a-f0-9]{64}$/.test(hash ?? '')) return ['a verified input of at least 64 MiB is required'];
  if (report.error || report.interrupted) errors.push('the benchmark did not finish cleanly');
  const seen = new Set();
  for (const row of report.rows ?? []) {
    const key = `${row.run}/${row.route}`;
    if (!['auto', 'relay'].includes(row.route) || !Number.isInteger(row.run) || row.run < 0 || row.run >= report.runs || seen.has(key)) errors.push(`unexpected or duplicate trial ${key}`);
    seen.add(key);
    if (!row.ok || row.received?.bytes !== bytes || row.received?.sha256 !== hash) errors.push(`${key} did not verify the complete input`);
    if (!Number.isFinite(row.receiveMs) || row.receiveMs <= 0 || bytes / 1048576 / (row.receiveMs / 1000) < 8) errors.push(`${key} fell below 8 MiB/s`);
    const stats = row.transport;
    if (!stats || !Number.isSafeInteger(stats.direct) || stats.direct < 0 || !Number.isSafeInteger(stats.relay) || stats.relay < 0 || stats.direct + stats.relay < bytes) errors.push(`${key} lacks payload transport evidence`);
    if (row.route === 'auto' && !(stats?.direct >= 4 * 1048576)) errors.push(`${key} did not exercise direct transfer`);
    if (row.route === 'relay' && (stats?.direct !== 0 || stats?.relay !== bytes)) errors.push(`${key} did not exercise only relay`);
    if (!Number.isFinite(stats?.maxGapMs) || stats.maxGapMs < 0 || stats.maxGapMs > 5000) errors.push(`${key} stalled for more than five seconds or lacks timing evidence`);
  }
  for (let run = 0; run < report.runs; run++) for (const route of ['auto', 'relay']) if (!seen.has(`${run}/${route}`)) errors.push(`missing trial ${run}/${route}`);
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = transferGateErrors(JSON.parse(await readFile(process.argv[2], 'utf8')));
  console.log(JSON.stringify({ ok: errors.length === 0, errors }));
  if (errors.length) process.exitCode = 1;
}
