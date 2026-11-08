import { readFile } from 'node:fs/promises';
import { stopChild } from './harness.mjs';

// Read evidence after stopping the child, including its signal-handler flush.
export async function collectBrowserTrial(browser, path, deadlineMs) {
  let timer, code, error, results;
  try {
    code = await Promise.race([browser.done, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('browser comparison deadline exceeded')), deadlineMs);
    })]);
  } catch (failure) { error = failure; }
  finally { clearTimeout(timer); await stopChild(browser.child); }
  try { results = JSON.parse(await readFile(path, 'utf8')); }
  catch (failure) { error ??= failure; }
  return { code, error, results };
}
