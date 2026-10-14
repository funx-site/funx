'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRouter } = require('../router/router');
const { listen, request } = require('./helpers');

const KEY = 'R'.repeat(43);
const routes = new Map([
  ['hello', { originId: '1250000000-abcd1234', key: KEY, disabled: false }],
  ['banned', { originId: '1250000000-dead0000', key: KEY, disabled: true }],
]);

function setup(fetchImpl, extra = {}) {
  const logs = [];
  const handler = createRouter({ routes, fetch: fetchImpl, log: (l) => logs.push(l), ...extra });
  return listen(handler).then((s) => ({ ...s, logs }));
}

const okFetch = (calls) => async (url, init) => {
  calls.push({ url, init });
  return new Response('hi', { status: 200, headers: { 'content-type': 'text/plain' } });
};

test('forwards to the mapped origin with the route key and clean headers', async () => {
  const calls = [];
  const s = await setup(okFetch(calls));
  try {
    const r = await request(s.port, {
      method: 'POST', path: '/a/b?x=1&y=2',
      headers: { host: 'hello.funx.run', 'content-type': 'application/json', authorization: 'Bearer user-token', cookie: 'sid=1',
        'x-funx-route-key': 'forged', 'x-funx-other': 'x', 'x-scf-remote-addr': '6.6.6.6', 'x-forwarded-host': 'evil.com', connection: 'x-drop', 'x-drop': '1', 'accept-encoding': 'gzip' },
      body: '{"a":1}',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, 'hi');
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'https://1250000000-abcd1234.ap-hongkong.tencentscf.com/a/b?x=1&y=2');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.equal(Buffer.from(init.body).toString(), '{"a":1}');
    const h = init.headers;
    assert.equal(h['x-funx-route-key'], KEY);
    assert.equal(h['x-funx-other'], undefined);
    assert.equal(h['x-scf-remote-addr'], undefined);
    assert.equal(h['x-drop'], undefined);
    assert.equal(h.host, undefined);
    assert.equal(h['x-forwarded-host'], 'hello.funx.run');
    assert.equal(h['x-forwarded-proto'], 'https');
    assert.equal(h['accept-encoding'], 'identity');
    assert.equal(h.authorization, 'Bearer user-token');
    assert.equal(h.cookie, 'sid=1');
  } finally { await s.close(); }
});

test('path cannot change the upstream host', async () => {
  const calls = [];
  const s = await setup(okFetch(calls));
  try {
    await request(s.port, { path: '//evil.com/x', headers: { host: 'hello.funx.run' } });
    assert.equal(new URL(calls[0].url).host, '1250000000-abcd1234.ap-hongkong.tencentscf.com');
  } finally { await s.close(); }
});

test('404 for unknown, reserved, foreign and malformed hosts; 200 for apex', async () => {
  const calls = [];
  const s = await setup(okFetch(calls));
  try {
    for (const host of ['nobody.funx.run', 'www.funx.run', 'api.funx.run', 'admin.funx.run', 'a.b.funx.run', 'example.com', '1250000000-abcd1234.ap-hongkong.tencentscf.com', 'xx.funx.run']) {
      const r = await request(s.port, { headers: { host } });
      assert.equal(r.status, 404, host);
    }
    assert.equal((await request(s.port, { headers: { host: 'funx.run' } })).status, 200);
    assert.equal(calls.length, 0);
  } finally { await s.close(); }
});

test('kill switch: disabled site answers 403 without calling the origin', async () => {
  const calls = [];
  const s = await setup(okFetch(calls));
  try {
    const r = await request(s.port, { headers: { host: 'banned.funx.run' } });
    assert.equal(r.status, 403);
    assert.equal(calls.length, 0);
  } finally { await s.close(); }
});

test('request body over the limit is 413 (declared and streamed)', async () => {
  const calls = [];
  const s = await setup(okFetch(calls), { maxRequestBytes: 10 });
  try {
    assert.equal((await request(s.port, { method: 'POST', headers: { host: 'hello.funx.run' }, body: 'x'.repeat(11) })).status, 413);
    assert.equal((await request(s.port, { method: 'POST', headers: { host: 'hello.funx.run', 'transfer-encoding': 'chunked' }, body: 'x'.repeat(50) })).status, 413);
    assert.equal(calls.length, 0);
  } finally { await s.close(); }
});

test('response over the limit is 502', async () => {
  const s = await setup(async () => new Response('y'.repeat(100), { status: 200 }), { maxResponseBytes: 10 });
  try {
    assert.equal((await request(s.port, { headers: { host: 'hello.funx.run' } })).status, 502);
  } finally { await s.close(); }
});

test('streamed response over the limit (no content-length) is 502', async () => {
  const s = await setup(async () => {
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 5; i++) c.enqueue(new TextEncoder().encode('zzzz')); c.close(); } });
    return new Response(stream, { status: 200 });
  }, { maxResponseBytes: 10 });
  try {
    assert.equal((await request(s.port, { headers: { host: 'hello.funx.run' } })).status, 502);
  } finally { await s.close(); }
});

test('timeout is 504', async () => {
  const slow = (url, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(new Response('late')), 2000);
    init.signal.addEventListener('abort', () => { clearTimeout(t); reject(init.signal.reason); });
  });
  const s = await setup(slow, { timeoutMs: 50 });
  try {
    assert.equal((await request(s.port, { headers: { host: 'hello.funx.run' } })).status, 504);
  } finally { await s.close(); }
});

test('network error is 502', async () => {
  const s = await setup(async () => { throw new TypeError('fetch failed'); });
  try {
    assert.equal((await request(s.port, { headers: { host: 'hello.funx.run' } })).status, 502);
  } finally { await s.close(); }
});

test('response headers are cleaned and cookies made host-only; redirects pass through', async () => {
  const s = await setup(async () => {
    const h = new Headers({ location: '/next', 'x-scf-request-id': 'abc', 'x-funx-route-key': 'leak', 'content-encoding': 'gzip', 'keep-alive': 'x', 'x-app': 'ok' });
    h.append('set-cookie', 'sid=1; Domain=.funx.run; Path=/; HttpOnly');
    h.append('set-cookie', 'b=2; Path=/');
    return new Response('moved', { status: 302, headers: h });
  });
  try {
    const r = await request(s.port, { headers: { host: 'hello.funx.run' } });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/next');
    assert.equal(r.headers['x-app'], 'ok');
    assert.equal(r.headers['x-scf-request-id'], undefined);
    assert.equal(r.headers['x-funx-route-key'], undefined);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.deepEqual(r.headers['set-cookie'], ['sid=1; Path=/; HttpOnly', 'b=2; Path=/']);
    assert.equal(r.headers['content-length'], '5');
  } finally { await s.close(); }
});

test('access log has only name, status and duration', async () => {
  const s = await setup(okFetch([]));
  try {
    await request(s.port, { path: '/secret?token=abc', headers: { host: 'hello.funx.run', authorization: 'Bearer zzz', cookie: 'sid=1' } });
    await request(s.port, { headers: { host: 'nobody.funx.run' } });
    assert.equal(s.logs.length, 2);
    for (const l of s.logs) assert.deepEqual(Object.keys(l).sort(), ['ms', 'n', 's']);
    assert.equal(s.logs[0].n, 'hello');
    assert.ok(!JSON.stringify(s.logs).match(/token|Bearer|sid|abcd1234/));
  } finally { await s.close(); }
});
