import assert from 'node:assert/strict';
import test from 'node:test';
import {
  P2P_CODE_ALPHABET,
  P2P_CODE_LENGTH,
  P2P_WORDS,
  cleanCode,
  codeFromUrl,
  generateCode,
  generateEphemeralId,
  isValidCode,
  isNewCode,
  normalizeCode,
  peerIdFor,
  receiveLinkFor,
} from './p2p-code.js';

test('new codes are 5-char CAPS without ambiguous chars', () => {
  assert.equal(P2P_CODE_LENGTH, 5);
  for (const ch of ['I', 'L', 'O', '0', '1']) {
    assert.ok(!P2P_CODE_ALPHABET.includes(ch), `${ch} must be excluded`);
  }
  const code = generateCode();
  assert.equal(code.length, 5);
  assert.match(code, /^[A-Z2-9]{5}$/);
  assert.equal(isNewCode(code), true);
  assert.equal(isValidCode(code), true);
});

test('legacy word list stays short plain words', () => {
  assert.ok(P2P_WORDS.length >= 100);
  assert.equal(new Set(P2P_WORDS).size, P2P_WORDS.length);
  for (const word of P2P_WORDS) {
    assert.match(word, /^[a-z]{3,5}$/);
  }
});

test('generates a 5-char code deterministically', () => {
  const a = generateCode({ getRandomValues: (bytes) => bytes.fill(0) });
  const b = generateCode({ getRandomValues: (bytes) => bytes.fill(0) });
  assert.equal(a, b);
  assert.equal(a, P2P_CODE_ALPHABET[0].repeat(5));
  assert.equal(isValidCode(a), true);
});

test('codes are letters and numbers only', () => {
  // cleanCode strips specials; the receive input uppercases after.
  assert.equal(cleanCode('ab!12#'), 'ab12');
  assert.equal(cleanCode('k-7_q.2'), 'k7q2');
  assert.equal(isValidCode('K7-2M'), false);
});
test('lowercase typing auto-upgrades to CAPS', () => {
  const code = generateCode();
  assert.equal(isValidCode(code.toLowerCase()), true);
  assert.equal(normalizeCode(code.toLowerCase()), code);
  assert.equal(cleanCode(code.toLowerCase()), code);
  assert.equal(cleanCode(' ' + code.toLowerCase() + '!'), code);
  assert.equal(peerIdFor(code.toLowerCase()), `cd-${code}`);
  const link = receiveLinkFor(code.toLowerCase(), 'https://cd.yash0.in/anything?old=1');
  assert.ok(link.includes(`#p2p.${code}`));
  assert.equal(codeFromUrl(link), code);
});

test('ephemeral ids stay random base64url', () => {
  const id = generateEphemeralId({ getRandomValues: (bytes) => bytes.fill(0xff) });
  assert.equal(id, '________');
  assert.equal(id.length, 8);
});

test('codes are case-insensitive but links stay lowercase', () => {
  assert.equal(isValidCode('RIVER'), true);
  assert.equal(isValidCode('river'), true);
  assert.equal(normalizeCode('RIVER'), 'river');
  assert.equal(peerIdFor('RIVER'), 'cd-river');
  const link = receiveLinkFor('RIVER', 'https://cd.yash0.in/anything?old=1');
  assert.equal(link, 'https://cd.yash0.in/#p2p.river');
  assert.equal(codeFromUrl(link), 'river');
  assert.equal(codeFromUrl('https://cd.yash0.in/#p2p.RIVER'), 'river');
});

test('rejects random short strings that are not words', () => {
  assert.equal(isValidCode('waffle'), false);
  assert.equal(isValidCode('HELLO'), false);
  assert.equal(isValidCode('AB12C'), false);
  // cleanCode surfaces CAPS for display; normalize keeps legacy words lowercase.
  assert.equal(cleanCode(' river!'), 'RIVER');
  assert.equal(normalizeCode(cleanCode(' river!')), 'river');
});

test('still accepts legacy random codes', () => {
  assert.equal(isValidCode('AbCdEfGh'), true);
  assert.equal(isValidCode('AbCdEfGhIjKlMnOpQrStUv'), true);
  assert.equal(peerIdFor('AbCdEfGh'), 'cd-AbCdEfGh');
  assert.equal(codeFromUrl('https://cd.yash0.in/#p2p.AbCdEfGh'), 'AbCdEfGh');
});

test('does not turn an unrelated URL into a code', () => {
  assert.equal(codeFromUrl('https://example.com/abcdefghijklmnopqrstuv'), '');
});
