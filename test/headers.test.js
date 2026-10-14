'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stripHeaders, scopeSetCookie } = require('../lib/headers');

test('strips hop-by-hop, Connection-listed, x-scf-* and x-funx-*', () => {
  const out = stripHeaders({
    connection: 'keep-alive, X-Secret-Hop', 'keep-alive': 'timeout=5', 'transfer-encoding': 'chunked', upgrade: 'h2c', te: 'trailers',
    'proxy-authorization': 'Basic x', 'x-secret-hop': '1', 'x-scf-request-id': 'r', 'X-SCF-Remote-Addr': '1.2.3.4',
    'x-funx-route-key': 'forged', 'X-Funx-Anything': 'x', authorization: 'Bearer t', cookie: 'a=b', 'content-type': 'text/plain',
  });
  assert.deepEqual(out, { authorization: 'Bearer t', cookie: 'a=b', 'content-type': 'text/plain' });
});

test('extra headers can be dropped', () => {
  assert.deepEqual(stripHeaders({ host: 'h', 'content-length': '3', a: '1' }, { extra: ['Host', 'content-length'] }), { a: '1' });
});

test('works with WHATWG Headers incl. multiple set-cookie', () => {
  const h = new Headers();
  h.append('set-cookie', 'a=1; Path=/');
  h.append('set-cookie', 'b=2; Domain=.funx.run; HttpOnly');
  h.append('x-scf-status', '200');
  h.append('content-type', 'text/html');
  const out = stripHeaders(h);
  assert.deepEqual(out['set-cookie'], ['a=1; Path=/', 'b=2; Domain=.funx.run; HttpOnly']);
  assert.equal(out['x-scf-status'], undefined);
  assert.equal(out['content-type'], 'text/html');
});

test('Set-Cookie Domain attribute is removed (host-only cookies)', () => {
  assert.deepEqual(scopeSetCookie(['s=1; Domain=funx.run; Path=/; Secure', 't=2;domain=.funx.run', 'u=3; HttpOnly']),
    ['s=1; Path=/; Secure', 't=2', 'u=3; HttpOnly']);
  assert.deepEqual(scopeSetCookie('v=domain=x; Path=/'), ['v=domain=x; Path=/']);
});
