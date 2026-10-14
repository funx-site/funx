// 设计 review round 2: only the changed spots (setup header/email/hint, short + mismatch errors, expired header). Mock mode.
// Usage: node screens-setup-v2.mjs [chromePath]
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
const box = async (page, sels, pad = 8) => {
  const r = await page.evaluate((ss) => { const bs = ss.map((s) => document.querySelector(s).getBoundingClientRect()); return { x: Math.min(...bs.map((b) => b.left)), y: Math.min(...bs.map((b) => b.top)), r: Math.max(...bs.map((b) => b.right)), b: Math.max(...bs.map((b) => b.bottom)) }; }, sels);
  return { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad), width: r.r - r.x + 2 * pad, height: r.b - r.y + 2 * pad };
};
for (const [label, viewport, mobile] of [['desktop', { width: 1440, height: 900 }, false], ['mobile', { width: 375, height: 812 }, true]]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, locale: 'zh-CN', colorScheme: 'light' });
  const page = await ctx.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
  await page.goto(base + 'index.html');
  await page.evaluate((seed) => { localStorage.clear(); localStorage.setItem('funx.lang', 'zh'); localStorage.setItem('funx.mock', JSON.stringify(seed)); }, SEED);
  await page.goto(base + 'index.html#/setup?t=demo-setup-token-0123456789');
  await page.waitForSelector('#pw');
  const hdr = await page.evaluate(() => [...document.querySelector('header.top').querySelectorAll('a,button,nav,span,p')].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map((e) => e.textContent.trim()).filter(Boolean));
  if (JSON.stringify(hdr) !== JSON.stringify(['funx', 'EN'])) errors.push(`[${label}] setup header ${hdr.join('|')}`);
  if (await page.$('.mockline:not([hidden])') && await page.evaluate(() => getComputedStyle(document.querySelector('.mockline')).display !== 'none')) errors.push(`[${label}] mockline on setup`);
  const ac = await page.evaluate(() => [...document.querySelectorAll('#f input')].map((i) => `${i.name}:${i.autocomplete}:${i.hidden}`));
  if (ac.join() !== 'username:username:true,password:new-password:false,password2:new-password:false') errors.push(`[${label}] inputs ${ac}`);
  await page.screenshot({ path: join(OUT, `30-setup-top-${label}.png`), clip: await box(page, ['header.top', '#f h1', '#pw'], 0).then((b) => ({ ...b, x: 0, width: viewport.width, height: b.height + 16 })) });
  await page.screenshot({ path: join(OUT, `31-setup-email-hint-${label}.png`), clip: await box(page, ['#f h1', '#acct', '#pwhint', '#pw', '#pw2']) });
  await page.fill('#pw', 'short'); await page.fill('#pw2', 'short'); await page.click('button[type=submit]');
  await page.waitForSelector('#pwhint.bad svg');
  await page.screenshot({ path: join(OUT, `32-setup-short-${label}.png`), clip: await box(page, ['#acct', '#pwhint', '#pw', '#pw2']) });
  await page.fill('#pw', 'a good long passphrase'); await page.fill('#pw2', 'a different passphrase'); await page.click('button[type=submit]');
  await page.waitForSelector('#err svg');
  const txt = await page.textContent('#err');
  if (txt.trim() !== '两次输入不一样') errors.push(`[${label}] mismatch text ${txt}`);
  if (await page.$('#pwhint.bad')) errors.push(`[${label}] hint still error`);
  await page.screenshot({ path: join(OUT, `33-setup-mismatch-${label}.png`), clip: await box(page, ['#pwhint', '#pw', '#pw2', '#err', '#f button[type=submit]']) });
  await page.goto(base + 'index.html#/setup?t=nope-0000');
  await page.waitForSelector('.authcard.expired');
  const hdr2 = await page.evaluate(() => [...document.querySelector('header.top').querySelectorAll('a,button,nav,span,p')].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map((e) => e.textContent.trim()).filter(Boolean));
  if (JSON.stringify(hdr2) !== JSON.stringify(['funx', 'EN'])) errors.push(`[${label}] expired header ${hdr2.join('|')}`);
  await page.screenshot({ path: join(OUT, `34-expired-header-${label}.png`), clip: await box(page, ['header.top', '.authcard.expired h1'], 0).then((b) => ({ ...b, x: 0, width: viewport.width, height: b.height + 16 })) });
  await ctx.close();
}
await browser.close(); server.close();
console.log(errors.length ? errors.join('\n') : 'no page errors, checks ok');
