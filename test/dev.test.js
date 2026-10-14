'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startDev, parseDotVars } = require('../cli/dev');

test('parseDotVars', () => {
  assert.deepEqual(parseDotVars('A=1\n# c\nexport B="two words"\nC=\'x\'\nbad line\n'), { A: '1', B: 'two words', C: 'x' });
});

test('funx dev serves a worker on localhost with env from .dev.vars and reloads on change', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'funxdev-'));
  fs.writeFileSync(path.join(d, '.dev.vars'), 'TOKEN=local\n');
  fs.writeFileSync(path.join(d, 'index.js'), 'export default { fetch: (req, env) => new Response("v1 " + env.TOKEN + " " + env.EXTRA + " " + new URL(req.url).host) }');
  const dev = await startDev({ target: d, vars: { EXTRA: 'cli' }, log: () => {} });
  try {
    assert.equal(await (await fetch(dev.url + '/')).text(), `v1 local cli localhost:${dev.port}`);
    fs.writeFileSync(path.join(d, 'index.js'), 'export default { fetch: () => new Response("v2") }');
    // the file watcher restarts the worker; poll until the new code answers
    let text = '';
    for (let i = 0; i < 50 && text !== 'v2'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { text = await (await fetch(dev.url + '/')).text(); } catch { /* restarting */ }
    }
    assert.equal(text, 'v2');
  } finally { await dev.close(); }
});

test('funx dev accepts a single file and rejects platform names', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'funxdev-'));
  fs.writeFileSync(path.join(d, 'w.mjs'), 'export default { fetch: () => new Response("file") }');
  const dev = await startDev({ target: path.join(d, 'w.mjs'), watch: false, log: () => {} });
  try { assert.equal(await (await fetch(dev.url)).text(), 'file'); } finally { await dev.close(); }
  await assert.rejects(startDev({ target: d, vars: { FUNX_ROUTE_KEY: 'x' }, watch: false }), /reserved/);
});
