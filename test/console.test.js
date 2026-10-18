'use strict';
// Console mock API (runs standalone, no server) and static-hosting rules.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'console');
const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('console mock client: login, deploy, list, vars/secrets, disable, delete', async () => {
  const { createClient, bjNow } = await import(path.join(ROOT, 'js', 'api.js'));
  const storage = memStorage();
  const api = createClient({ storage, runLive: async ({ code, env }) => ({ ok: true, status: 200, body: `${code.length}:${env.A}` }) });
  assert.equal(api.mock, true);
  await assert.rejects(api.list(), /unauthorized/);
  await assert.rejects(api.login('bad', 'x'), /email/);
  await api.login('Me@Example.com', 'longenough1');
  assert.equal(api.session.user.email, 'me@example.com');
  await assert.rejects(api.deploy('Bad Name', 'x'), /name/);
  const w = await api.deploy('demo', 'export default {}');
  assert.equal(w.url, 'https://demo.funx.run');
  assert.match(bjNow(new Date(Date.UTC(2026, 9, 10, 9, 0, 0))), /^2026-10-10 17:00:00$/);
  assert.deepEqual((await api.list()).map((x) => x.name), ['demo']);
  assert.deepEqual((await api.setVars('demo', { A: '1' })).vars, { A: '1' });
  assert.deepEqual((await api.putSecret('demo', 'S', 'v')).secrets, ['S']);
  await assert.rejects(api.putSecret('demo', 'FUNX_X', 'v'), /reserved/);
  const got = await api.get('demo');
  assert.deepEqual(got.secrets, ['S']);
  assert.ok(!JSON.stringify(got).includes('"v"'));
  assert.equal((await api.invoke('demo', { path: '/' })).body, '17:1');
  await api.setDisabled('demo', true);
  assert.equal((await api.invoke('demo', { path: '/' })).status, 403);
  await assert.rejects(api.logs('demo'), /not available/);
  await api.remove('demo');
  assert.deepEqual(await api.list(), []);
  api.logout();
  assert.equal(api.session.token, null);
});

test('console real client: Bearer header, no cookies, 401 clears the token', async () => {
  const { createClient } = await import(path.join(ROOT, 'js', 'api.js'));
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url.endsWith('/v1/auth/login')) return new Response(JSON.stringify({ token: 'a.b.c', user: { id: 'u', email: 'e@x.co' } }), { status: 200 });
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  };
  const api = createClient({ apiBase: 'https://api.example/', storage: memStorage(), fetchImpl });
  await api.login('e@x.co', 'longenough1');
  await assert.rejects(api.list(), /unauthorized/);
  assert.equal(seen[1].url, 'https://api.example/v1/workers');
  assert.equal(seen[1].init.headers.authorization, 'Bearer a.b.c');
  assert.equal(seen[1].init.credentials, 'omit');
  assert.equal(api.session.token, null);
});

test('console is portable static files: relative asset paths, no cookies, no purple', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(m[1].startsWith('./') || m[1].startsWith('data:'), `absolute path ${m[1]}`);
  const files = ['js/main.js', 'js/api.js', 'js/runner.js', 'js/i18n.js', 'app.css', 'config.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  assert.ok(!/document\.cookie/.test(files));
  assert.ok(!/demox/i.test(files.replace(/funx\.demox\.site/g, '')), 'no Demox references in console code');
  const css = fs.readFileSync(path.join(ROOT, 'app.css'), 'utf8');
  assert.ok(!/purple|violet|#a78bfa|#7c3aed|hsl\(2[6-9]\d/i.test(css));
  assert.ok(!/\bred\b|#ef4444|#dc2626/i.test(css));
  assert.ok(!/@keyframes/.test(css), 'no entrance animations');
  assert.ok(fs.existsSync(path.join(ROOT, 'vendor', 'codemirror.js')));
});

test('one sample source: examples/worker/index.js is sample("zh"); comments follow the UI language', async () => {
  const { sample, isSample } = await import(path.join(ROOT, 'js', 'sample.js'));
  assert.equal(sample('zh'), fs.readFileSync(path.join(__dirname, '..', 'examples', 'worker', 'index.js'), 'utf8'));
  assert.match(sample('en'), /Same shape as a Cloudflare Worker/);
  assert.ok(isSample(sample('en')) && isSample(sample('zh')) && !isSample('x'));
});

test('first-paint view has the same lines and text as the source (only markup added)', async () => {
  const { highlightLines, staticCodeHtml } = await import(path.join(ROOT, 'js', 'highlight.js'));
  const { sample } = await import(path.join(ROOT, 'js', 'sample.js'));
  const unhtml = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  for (const src of [sample('zh'), sample('en'), 'const a = `x ${b + `y ${c}`} z`; // <tag> & "q"\n/* multi\nline */ let s = "esc\\"aped";']) {
    const lines = highlightLines(src);
    assert.deepEqual(lines.map(unhtml), src.split('\n'));
  }
  const html = staticCodeHtml(sample('zh'));
  assert.equal((html.match(/class="cs-row/g) || []).length, sample('zh').split('\n').length);
  assert.match(html, /<span class="tk-kw">export<\/span>/);
});

test('sample-data label only in mock mode; production config (apiBase set) never renders it', async () => {
  const { isMockMode, headerHtml } = await import(path.join(ROOT, 'js', 'chrome.js'));
  const { createClient } = await import(path.join(ROOT, 'js', 'api.js'));
  const { dict } = await import(path.join(ROOT, 'js', 'i18n.js'));
  const labels = Object.values(dict).map((d) => d.mock);
  assert.deepEqual(labels.sort(), ['Sample data · this browser only', '示例数据 · 只存在本机'].sort());
  const prod = { apiBase: 'https://api.example.test', baseDomain: 'funx.run' };
  assert.equal(isMockMode(prod), false);
  assert.equal(isMockMode({ apiBase: '' }), true);
  assert.equal(isMockMode({ apiBase: '   ' }), true);
  assert.equal(isMockMode(undefined), true);
  const client = createClient({ apiBase: prod.apiBase, storage: memStorage(), fetchImpl: async () => { throw new Error('no network'); } });
  assert.equal(client.mock, false);
  // main.js must not offer a ?mock override and must take mock mode from the config only
  const main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
  assert.ok(!/params\.has\(['"]mock/.test(main) && !/searchParams|URLSearchParams\(location\.search\)/.test(main), 'no URL override of mock mode');
  assert.match(main, /isMockMode\(cfg\)/);
  for (const lang of ['zh', 'en']) {
    const t = (k) => dict[lang][k] ?? k;
    for (const hash of ['#/', '#/workers', '#/new', '#/workers/hello', '#/workers/hello/settings', '#/w/hello', '#/login', '#/setup']) {
      for (const user of [null, { email: 'a@b.c' }]) {
        for (const minimal of [false, true]) {
          const html = headerHtml({ t, lang, mock: client.mock, user, hash, minimal });
          for (const l of labels) assert.ok(!html.includes(l), `${lang} ${hash} label leaked`);
          assert.ok(!html.includes('mockline') && !html.includes('title="mock"'));
        }
      }
    }
    // and in mock mode it does show (full header only)
    assert.ok(headerHtml({ t, lang, mock: true, hash: '#/' }).includes(dict[lang].mock));
  }
});

test('logged-out header (setup / expired link): wordmark + language toggle only', async () => {
  const { headerHtml } = await import(path.join(ROOT, 'js', 'chrome.js'));
  const { dict } = await import(path.join(ROOT, 'js', 'i18n.js'));
  for (const lang of ['zh', 'en']) {
    const t = (k) => dict[lang][k];
    for (const mock of [true, false]) {
      const html = headerHtml({ t, lang, mock, user: null, hash: '#/setup', minimal: true });
      assert.match(html, /class="wordmark"/);
      assert.match(html, /id="lang"/);
      for (const k of ['workers', 'login', 'logout', 'mock']) assert.ok(!html.includes(dict[lang][k]), `${lang}: ${k} in minimal header`);
      assert.ok(!/<nav|id="logout"|href="#\/login"/.test(html));
    }
  }
  const main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
  const setup = main.slice(main.indexOf('function expiredPage'), main.indexOf('// ---------- list'));
  assert.ok(!/header\(\)/.test(setup), 'setup/expired pages use the minimal header');
  assert.match(setup, /autocomplete="username"/);
  assert.equal((setup.match(/autocomplete="new-password"/g) || []).length, 2);
  assert.equal(dict.zh.pwMismatch, '两次输入不一样');
});

test('home is the worker list; editor lives at #/workers/:name; old list URL redirects', async () => {
  const { resolveRoute, isListHash } = await import(path.join(ROOT, 'js', 'routes.js'));
  const { headerHtml } = await import(path.join(ROOT, 'js', 'chrome.js'));
  const { dict } = await import(path.join(ROOT, 'js', 'i18n.js'));
  assert.deepEqual(resolveRoute('#/'), { page: 'list' });
  assert.deepEqual(resolveRoute(''), { page: 'list' });
  assert.deepEqual(resolveRoute('#/workers'), { page: 'redirect', to: '#/' });
  assert.deepEqual(resolveRoute('#/workers/'), { page: 'redirect', to: '#/' });
  assert.deepEqual(resolveRoute('#/new'), { page: 'editor', name: null });
  assert.deepEqual(resolveRoute('#/workers/hello'), { page: 'editor', name: 'hello' });
  assert.deepEqual(resolveRoute('#/workers/time-api/settings'), { page: 'settings', name: 'time-api' });
  assert.deepEqual(resolveRoute('#/w/hello'), { page: 'redirect', to: '#/workers/hello' });
  assert.deepEqual(resolveRoute('#/w/hello/settings'), { page: 'redirect', to: '#/workers/hello/settings' });
  assert.deepEqual(resolveRoute('#/login'), { page: 'login' });
  assert.deepEqual(resolveRoute('#/setup?t=abc'), { page: 'setup' });
  assert.equal(dict.zh.emptyCta, '新建 Worker');
  assert.equal(dict.en.emptyCta, 'New Worker');
  const t = (k) => dict.zh[k];
  const nav = (html) => html.match(/<nav class="nav">([\s\S]*?)<\/nav>/)[1];
  const home = headerHtml({ t, lang: 'zh', mock: false, user: { email: 'a@b.c' }, hash: '#/' });
  assert.match(nav(home), /href="#\/" class="on"/);
  const editor = headerHtml({ t, lang: 'zh', mock: false, user: { email: 'a@b.c' }, hash: '#/workers/hello' });
  assert.match(nav(editor), /href="#\/">/);
  assert.equal(isListHash('#/workers/hello'), false);
  assert.equal(isListHash('#/new'), false);
  const main = fs.readFileSync(path.join(ROOT, 'js', 'main.js'), 'utf8');
  assert.match(main, /href="#\/new"/);
  assert.match(main, /href="#\/workers\/\$\{esc\(w\.name\)\}"/);
  assert.ok(!/href="#\/w\//.test(main), 'editor links use #/workers/:name');
});
