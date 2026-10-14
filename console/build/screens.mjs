// Screenshots of the console in mock mode (no API). Usage: node screens.mjs [chromePath]
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'screens');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try { const b = await readFile(join(ROOT, p.endsWith('/') ? p + 'index.html' : p)); res.writeHead(200, { 'content-type': TYPES[extname(p) || '.html'] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/`;

const SEED = {
  workers: {
    hello: { name: 'hello', owner: 'me', disabled: false, modTime: '2026-10-10 17:42:08', vars: { GREETING: 'funx' }, secrets: { API_TOKEN: 'x' },
      code: (await readFile(join(ROOT, '..', 'examples', 'worker', 'index.js'), 'utf8')) },
    'time-api': { name: 'time-api', owner: 'me', disabled: false, modTime: '2026-10-10 16:05:51', vars: {}, secrets: {}, code: 'export default { fetch: () => Response.json({ now: Date.now() }) }' },
    webhook: { name: 'webhook', owner: 'me', disabled: true, modTime: '2026-10-09 21:30:12', vars: {}, secrets: { SIGNING_KEY: 'x' }, code: 'export default { fetch: () => new Response("ok") }' },
  },
};

const LONG = `export default {
  async fetch(request, env) {
    const data = { now: Date.now(), path: new URL(request.url).pathname, note: "this line is long on purpose so the editor has to scroll sideways to show all of it" };
    return Response.json(data);
  },
};
`;
SEED.workers['time-api'].code = LONG;

const browser = await chromium.launch({ executablePath: process.argv[2] || '/usr/bin/google-chrome', args: ['--no-sandbox'], ignoreDefaultArgs: ['--hide-scrollbars'] });
const shots = [];
for (const [label, viewport, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['mobile', { width: 375, height: 812 }, true]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN', colorScheme: 'light' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => console.error(`[${label}] pageerror`, e.message));
  const shot = async (name, fullPage = false) => { const f = join(OUT, `${name}-${label}.png`); await page.screenshot({ path: f, fullPage }); shots.push(f); };

  // First paint vs CodeMirror: hold the editor bundle until the static view is captured.
  let release;
  const gate = new Promise((r) => { release = r; });
  await page.route('**/vendor/codemirror.js', async (route) => { await gate; await route.continue(); });
  await page.goto(base + '#/');
  await page.waitForSelector('#code .cs-row');
  await shot('10-first-paint-static');
  release();
  await page.waitForSelector('.cm-host.ready');
  await page.waitForTimeout(150);
  await shot('11-first-paint-codemirror');
  await page.unroute('**/vendor/codemirror.js');

  // run the sample in the browser
  if (mobile) await page.click('.tabs [data-tab="test"]');
  await page.fill('#path', '/api/time');
  await page.click('#send');
  await page.waitForSelector('.status');
  if (mobile) { await shot('02-editor-test-tab'); await page.click('.tabs [data-tab="code"]'); await shot('02-editor-code-tab'); }
  else await shot('02-editor-run');

  // logged in (mock), seeded sample data
  await page.evaluate((seed) => {
    localStorage.setItem('funx.mock', JSON.stringify(seed));
    localStorage.setItem('funx.token', 'mock.demo.local');
    localStorage.setItem('funx.user', JSON.stringify({ id: 'me', email: 'user@example.com', role: 'user' }));
  }, SEED);
  await page.goto(base + '#/workers'); await page.reload();
  await page.waitForSelector('.row .name');
  await shot('03-list');

  await page.goto(base + '#/w/hello');
  await page.waitForSelector('#deployed');
  await page.waitForSelector('.cm-host.ready');
  await shot('04-editor-deployed-code');
  if (mobile) await page.click('.tabs [data-tab="test"]');
  await page.click('.seg [data-mode="live"]');
  await page.click('#send');
  await page.waitForSelector('.status');
  await shot('04-editor-deployed-test');

  await page.goto(base + '#/w/webhook'); await page.waitForSelector('#deployed');
  if (mobile) await page.click('.tabs [data-tab="test"]');
  await page.click('.seg [data-mode="live"]');
  await page.click('#send'); await page.waitForSelector('.status');
  await shot('05-editor-non2xx');

  await page.goto(base + '#/w/time-api'); await page.waitForSelector('.cm-host.ready'); await page.waitForTimeout(150);
  await shot('08-editor-long-line');

  await page.goto(base + '#/w/hello/settings');
  await page.waitForSelector('#varf');
  await shot('06-settings', true);

  await page.evaluate(() => { localStorage.removeItem('funx.token'); localStorage.removeItem('funx.user'); });
  await page.goto(base + '#/login'); await page.reload();
  await page.waitForSelector('#f');
  await shot('07-login');
  await ctx.close();
}
await browser.close();
server.close();
console.log(shots.join('\n'));
