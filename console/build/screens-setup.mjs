// Screenshots for 设计: setup page, expired-link page, settings rows (删除 as plain text). Mock mode.
// Usage: node screens-setup.mjs [chromePath]
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
const SEED = { workers: { hello: { name: 'hello', owner: 'me', disabled: false, modTime: '2026-10-10 18:02:21', vars: { GREETING: 'funx' }, secrets: { API_TOKEN: 'x' }, code: 'export default { fetch: () => new Response("hi") }' } } };

const browser = await chromium.launch({ executablePath: process.argv[2] || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const errors = [];
for (const [label, viewport, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['mobile', { width: 375, height: 812 }, true]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN', colorScheme: 'light' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  const shot = (n) => page.screenshot({ path: join(OUT, `${n}-${label}.png`) });

  await page.goto(base + 'index.html');
  await page.evaluate((seed) => { localStorage.clear(); localStorage.setItem('funx.lang', 'zh'); localStorage.setItem('funx.mock', JSON.stringify(seed)); }, SEED);

  // valid link
  await page.goto(base + 'index.html#/setup?t=demo-setup-token-0123456789');
  await page.waitForSelector('#f input[name=password]');
  if (page.url().includes('t=')) errors.push(`[${label}] token still in URL`);
  await shot('20-setup');
  await page.fill('input[name=password]', 'short'); await page.fill('input[name=password2]', 'short');
  await page.click('button[type=submit]'); await page.waitForSelector('#err svg');
  await shot('21-setup-error');
  await page.fill('input[name=password]', 'a good long passphrase'); await page.fill('input[name=password2]', 'a good long passphrase');
  await page.click('button[type=submit]');
  await page.waitForFunction(() => location.hash === '#/');
  // reuse -> expired page
  await page.evaluate(() => localStorage.removeItem('funx.token'));
  await page.goto(base + 'index.html#/setup?t=demo-setup-token-0123456789');
  await page.waitForSelector('.authcard.expired');
  await shot('22-expired');
  // settings rows: 删除 for var and secret
  await page.evaluate(() => localStorage.setItem('funx.token', 'mock.x.local'));
  await page.evaluate((seed) => localStorage.setItem('funx.mock', JSON.stringify(seed)), SEED);
  await page.goto(base + 'index.html#/workers/hello/settings');
  await page.reload();
  await page.waitForSelector('[data-delsecret]');
  const bg = await page.evaluate(() => [...document.querySelectorAll('[data-delvar],[data-delsecret]')].map((b) => getComputedStyle(b).backgroundColor));
  if (new Set(bg).size !== 1 || !/rgba\(0, 0, 0, 0\)|transparent/.test(bg[0])) errors.push(`[${label}] delete button backgrounds ${bg.join(' / ')}`);
  await page.reload(); await page.waitForSelector('[data-delsecret]');
  await shot('23-settings-rows');
  await ctx.close();
}
await browser.close(); server.close();
console.log(errors.length ? errors.join('\n') : 'no page errors, checks ok');
