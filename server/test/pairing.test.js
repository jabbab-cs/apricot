import assert from 'node:assert/strict';
import test from 'node:test';
import { pairingLink } from '../src/pairing.js';

test('pairing link carries name, token and every address in order', () => {
  const link = new URL(pairingLink({ name: 'My Mac', token: 'abc', urls: ['http://192.168.1.5:7420', 'https://x.trycloudflare.com'] }));
  assert.equal(link.protocol, 'apricot:');
  assert.equal(link.searchParams.get('n'), 'My Mac');
  assert.equal(link.searchParams.get('t'), 'abc');
  assert.deepEqual(link.searchParams.getAll('u'), ['http://192.168.1.5:7420', 'https://x.trycloudflare.com']);
});
