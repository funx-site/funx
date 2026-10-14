'use strict';
// `funx dev`: run a worker on localhost with the same shim the platform uses (no route key).
// The worker runs in a child process that is restarted whenever a file in the directory changes,
// so ES module caches never serve stale code. Local secrets come from .dev.vars (KEY=value lines,
// as in wrangler) and --var KEY=value; they are never packaged by `funx deploy`.

const fs = require('fs');
const path = require('path');
const net = require('net');
const { fork } = require('child_process');
const { validateBindingName } = require('../lib/bindings');

const SHIM = path.join(__dirname, '..', 'shim', 'funx_entry.cjs');

function parseDotVars(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function resolveTarget(target) {
  const abs = path.resolve(target || '.');
  if (!fs.existsSync(abs)) throw new Error(`${target} not found`);
  if (fs.statSync(abs).isDirectory()) return { root: abs, entry: undefined };
  return { root: path.dirname(abs), entry: path.basename(abs) };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// Returns { url, port, reload(), close() }.
async function startDev({ target, port, vars = {}, watch = true, log = (m) => console.error(m) }) {
  const { root, entry } = resolveTarget(target);
  const fileVars = fs.existsSync(path.join(root, '.dev.vars')) ? parseDotVars(fs.readFileSync(path.join(root, '.dev.vars'), 'utf8')) : {};
  const all = { ...fileVars, ...vars };
  for (const k of Object.keys(all)) { const v = validateBindingName(k); if (!v.ok) throw new Error(`${k}: ${v.reason}`); }
  const p = port || await freePort();
  let child = null;

  const spawn = () => new Promise((resolve, reject) => {
    const args = ['--dev', '--root', root, ...(entry ? ['--entry', entry] : [])];
    const env = { ...process.env, ...all, PORT: String(p), FUNX_META: JSON.stringify({ v: Object.keys(all).sort(), s: [] }) };
    delete env.FUNX_ROUTE_KEY;
    const c = fork(SHIM, args, { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const onExit = (code) => reject(new Error(`worker process exited (${code})`));
    c.once('exit', onExit);
    c.once('message', (m) => { if (m && m.ready) { c.off('exit', onExit); resolve(c); } });
    child = c;
  });

  const stop = () => new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
  });

  await spawn();
  let watcher = null;
  let timer = null;
  let restarting = Promise.resolve();
  const reload = () => { restarting = restarting.then(async () => { await stop(); await spawn(); log('funx dev: reloaded'); }).catch((e) => log(`funx dev: ${e.message}`)); return restarting; };
  if (watch) {
    watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
      if (!file || /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(file)) return;
      clearTimeout(timer);
      timer = setTimeout(reload, 80);
    });
  }
  return {
    url: `http://localhost:${p}`, port: p, reload,
    async close() { clearTimeout(timer); if (watcher) watcher.close(); await restarting; await stop(); },
  };
}

module.exports = { startDev, parseDotVars, resolveTarget };
