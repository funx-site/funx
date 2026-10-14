'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseRoutes, serializeRoutes, originIdFromUrl, originHost, envSize, ENV_LIMIT_BYTES } = require('../lib/routes');

const KEY = 'k'.repeat(43);

test('round trip', () => {
  const m = new Map([['hello', { originId: '1250000000-abc123', key: KEY, disabled: false }], ['bad-site', { originId: '1250000000-zz', key: KEY, disabled: true }]]);
  const s = serializeRoutes(m);
  assert.deepEqual(parseRoutes(s), m);
});

test('invalid entries are dropped, never trusted', () => {
  const m = parseRoutes(JSON.stringify({
    ok1: ['1250000000-abc', KEY, 0],
    www: ['1250000000-abc', KEY, 0], // reserved
    evil: ['evil.com/x', KEY, 0], // not an origin id
    short: ['1250000000-abc', 'short', 0],
  }));
  assert.deepEqual([...m.keys()], ['ok1']);
  assert.equal(parseRoutes('').size, 0);
  assert.throws(() => parseRoutes('{nope'), /not valid JSON/);
});

test('origin url <-> id', () => {
  assert.equal(originIdFromUrl('https://1250000000-abcd1234.ap-hongkong.tencentscf.com', 'ap-hongkong'), '1250000000-abcd1234');
  assert.equal(originIdFromUrl('https://1250000000-abcd1234.ap-guangzhou.tencentscf.com', 'ap-hongkong'), null);
  assert.equal(originIdFromUrl('https://evil.com/?x=1250000000-a.ap-hongkong.tencentscf.com', 'ap-hongkong'), null);
  assert.equal(originHost('1250000000-abcd1234', 'ap-hongkong'), '1250000000-abcd1234.ap-hongkong.tencentscf.com');
});

test('about 40 sites fit in the 4 KB env limit', () => {
  const m = new Map();
  for (let i = 0; i < 40; i++) m.set(`site-number-${String(i).padStart(3, '0')}`, { originId: '1250000000-abcdefgh', key: KEY, disabled: false });
  const size = envSize([{ Key: 'FUNX_ROUTES', Value: serializeRoutes(m) }, { Key: 'FUNX_BASE_DOMAIN', Value: 'funx.run' }]);
  assert.ok(size < ENV_LIMIT_BYTES, `size ${size}`);
});
