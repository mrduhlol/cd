import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanShortCode,
  shortCodeFromInput,
  codeLookupPath,
  isShortCode,
  parseCapability,
  shareUrlFromCapability
} from './agent-code.js';

describe('short share codes', () => {
  it('accepts four or five digits', () => {
    assert.equal(isShortCode('48291'), true);
    assert.equal(isShortCode('  4829  '), true);
    assert.equal(isShortCode('river-cloud'), false);
    assert.equal(isShortCode('482a1'), false);
    assert.equal(isShortCode('123456'), false);
    assert.equal(isShortCode(''), false);
    assert.equal(isShortCode(null), false);
  });

  it('builds the lookup path', () => {
    assert.equal(codeLookupPath('48291'), '/api/codes/48291');
    assert.throws(() => codeLookupPath('river-cloud'), /invalid share code/);
  });

  it('builds share links from capabilities', () => {
    const id = 'A'.repeat(22);
    const key = 'B'.repeat(43);
    assert.equal(
      shareUrlFromCapability('https://cd.yash0.in', id, key),
      `https://cd.yash0.in/s/${id}#v1.${key}`
    );
    assert.throws(() => shareUrlFromCapability('https://cd.yash0.in', 'short', key), /invalid/);
  });

  it('parses lookup responses strictly', () => {
    const id = 'A'.repeat(22);
    const key = 'B'.repeat(43);
    assert.deepEqual(parseCapability({ transferId: id, key }), { transferId: id, key });
    assert.throws(() => parseCapability({ transferId: id }), /invalid/);
    assert.throws(() => parseCapability(null), /invalid/);
  });

  it('keeps only the legacy host as a lookup origin', () => {
    const id = 'A'.repeat(22);
    const key = 'B'.repeat(43);
    assert.deepEqual(parseCapability({ transferId: id, key, origin: 'https://cdx.yash0.in' }), { transferId: id, key, origin: 'https://cdx.yash0.in' });
    assert.deepEqual(parseCapability({ transferId: id, key, origin: 'https://evil.example' }), { transferId: id, key });
  });

  it('cleans pasted codes', () => {
    assert.equal(cleanShortCode('  48291\n'), '48291');
  });
});


describe('numeric share input', () => {
  it('extracts complete numeric codes from input and advertised links', () => {
    assert.equal(shortCodeFromInput(' 04829 '), '04829');
    assert.equal(shortCodeFromInput(' https://cd.yash0.in/#04829 '), '04829');
    assert.equal(shortCodeFromInput('https://cd.yash0.in#4829'), '4829');
    assert.equal(shortCodeFromInput('http://127.0.0.1:8787/#48291'), '48291');
    assert.equal(shortCodeFromInput('https://elsewhere.example/#04829'), '04829');
  });

  it('rejects non-web URLs, credentials, other paths, and unrelated fragments', () => {
    for (const value of ['ftp://cd.yash0.in/#48291', 'javascript://cd.yash0.in/#48291',
      'https://user:secret@cd.yash0.in/#48291', 'https://cd.yash0.in/s/other#48291',
      'https://cd.yash0.in/#p2p.river-cloud', 'https://cd.yash0.in/#v1.key',
      'https://cd.yash0.in/#123456', '482a1']) assert.equal(shortCodeFromInput(value), '', value);
  });
});
