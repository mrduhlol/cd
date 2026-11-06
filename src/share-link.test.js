import test from 'node:test';
import assert from 'node:assert/strict';
import { agentShareUrlFromInput } from './share-link.js';
const base = 'https://cd.example/';
const id = 'AAAAAAAAAAAAAAAAAAAAAA';
const key = 'A'.repeat(43);
for (const version of ['v1', 'v2']) {
  test(`accepts ${version} private links, bare codes, and pasted commands`, () => {
    const url = `${base}s/${id}#${version}.${key}`;
    assert.equal(agentShareUrlFromInput(url, base), url);
    assert.equal(agentShareUrlFromInput(`${id}#${version}.${key}`, base), url);
    assert.equal(agentShareUrlFromInput(`cdx receive "${url}"`, base), url);
    assert.equal(agentShareUrlFromInput(`/s/${id}#${version}.${key}`, base), url);
  });
}
test('rejects executable schemes and malformed private keys without turning them into numeric codes', () => {
  for (const value of [`javascript:/s/${id}#v2.${key}`, `data:/s/${id}#v1.${key}`, `${base}s/${id}#v3.${key}`, `${base}s/${id}#v2.${key}extra`, '12345']) {
    assert.equal(agentShareUrlFromInput(value, base), '');
  }
});
