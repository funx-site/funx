'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { validateName, parseHost, toFunctionName, fromFunctionName, RESERVED } = require('../lib/names');

test('valid names', () => {
  for (const n of ['abc', 'my-app', 'a1b2', 'x'.repeat(32), '123']) assert.ok(validateName(n).ok, n);
});

test('invalid names', () => {
  for (const n of ['ab', 'x'.repeat(33), '-abc', 'abc-', 'ABC', 'a_b', 'a.b', 'ab c', '', 'héllo', null]) assert.ok(!validateName(n).ok, String(n));
});

test('reserved names are not assignable', () => {
  for (const n of ['api', 'auth', 'www', 'admin', 'app', 'console', 'status', 'mail']) {
    assert.ok(RESERVED.has(n));
    assert.ok(!validateName(n).ok);
    assert.throws(() => toFunctionName(n), /reserved/);
  }
});

test('function name mapping', () => {
  assert.equal(toFunctionName('hello'), 'funx-u-hello');
  assert.equal(fromFunctionName('funx-u-hello'), 'hello');
  assert.equal(fromFunctionName('funx-router'), null);
  assert.equal(fromFunctionName('demox-api'), null);
});

test('parseHost', () => {
  const b = 'funx.run';
  assert.deepEqual(parseHost('hello.funx.run', b), { kind: 'site', name: 'hello' });
  assert.deepEqual(parseHost('Hello.FUNX.run:443', b), { kind: 'site', name: 'hello' });
  assert.deepEqual(parseHost('hello.funx.run.', b), { kind: 'site', name: 'hello' });
  assert.deepEqual(parseHost('funx.run', b), { kind: 'apex' });
  assert.deepEqual(parseHost('www.funx.run', b), { kind: 'reserved', name: 'www' });
  assert.equal(parseHost('a.b.funx.run', b).kind, 'invalid');
  assert.equal(parseHost('-x-.funx.run', b).kind, 'invalid');
  assert.equal(parseHost('ab.funx.run', b).kind, 'invalid');
  assert.equal(parseHost('hello.funx.run.evil.com', b).kind, 'foreign');
  assert.equal(parseHost('evilfunx.run', b).kind, 'foreign');
  assert.equal(parseHost('1250000000-abc.ap-hongkong.tencentscf.com', b).kind, 'foreign');
  assert.equal(parseHost(undefined, b).kind, 'invalid');
});
