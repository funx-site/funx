'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const AdmZip = require('adm-zip');

// adm-zip takes plain permission bits and stores them as unix mode in the external attributes.
const EXEC_ATTR = 0o755;
const FILE_ATTR = 0o644;
const ROOT = path.join(__dirname, '..');

// Never ship these from a user directory.
const EXCLUDE = [/^\.git(\/|$)/, /(^|\/)\.env(\..*)?$/, /(^|\/)\.dev\.vars$/, /\.pem$/, /\.key$/, /(^|\/)id_(rsa|ed25519)/, /(^|\/)\.DS_Store$/, /(^|\/)\.funx/, /(^|\/)\.wrangler(\/|$)/];
const SHIM_FILE = 'funx_entry.cjs';
const MANIFEST = 'funx.json';
const RESERVED_FILES = new Set([SHIM_FILE, 'funx_entry.js', 'scf_bootstrap', MANIFEST]);
const DEFAULT_ENTRIES = ['index.mjs', 'index.js', 'index.cjs', 'worker.mjs', 'worker.js', 'src/index.mjs', 'src/index.js'];

function walk(dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = path.relative(base, abs).split(path.sep).join('/');
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    if (ent.isSymbolicLink()) continue;
    if (ent.isDirectory()) walk(abs, base, out);
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

function bootstrap(tplPath, nodeDir) {
  return Buffer.from(fs.readFileSync(tplPath, 'utf8').replace('__NODE__', nodeDir));
}

function looksLikeEsm(src) {
  try { new vm.Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`); return false; } // eslint-disable-line no-new
  catch (e) { return e instanceof SyntaxError && /(^|\n)\s*(import|export)\b/.test(src); }
}

function parseJson(buf, what) { try { return JSON.parse(buf.toString('utf8')); } catch { throw new Error(`${what} is not valid JSON`); } }

// wrangler.toml `main = "src/index.js"` is honoured so a simple Workers project deploys as is.
function wranglerMain(buf) {
  const m = buf.toString('utf8').match(/^\s*main\s*=\s*["']([^"']+)["']/m);
  return m ? m[1] : null;
}

// Pick the entry file: package.json "main" > wrangler.toml "main" > index.mjs/index.js/... .
function resolveEntry(files) {
  const pkg = files.has('package.json') ? parseJson(files.get('package.json'), 'package.json') : null;
  const clean = (p) => p.replace(/^\.\//, '');
  if (pkg && typeof pkg.main === 'string') {
    if (!files.has(clean(pkg.main))) throw new Error(`entry file ${pkg.main} not found`);
    return { entry: clean(pkg.main), pkg };
  }
  if (files.has('wrangler.toml')) {
    const m = wranglerMain(files.get('wrangler.toml'));
    if (m) { if (!files.has(clean(m))) throw new Error(`entry file ${m} (wrangler.toml main) not found`); return { entry: clean(m), pkg }; }
  }
  const hit = DEFAULT_ENTRIES.find((f) => files.has(f));
  if (!hit) throw new Error('entry file index.js not found (or index.mjs, worker.js, src/index.js, package.json "main")');
  return { entry: hit, pkg };
}

// files: Map<relative path, Buffer> of the user's code. Adds funx.json, the shim and the bootstrap.
// An ES-module entry in a .js file gets "type": "module" in the packaged package.json, because the
// SCF Node 18 runtime does not detect module syntax by itself.
function buildUserZipFromFiles(files, cfg) {
  for (const f of files.keys()) {
    if (RESERVED_FILES.has(f)) throw new Error(`${f} is reserved by Funx; rename it`);
    if (f.startsWith('/') || f.split('/').includes('..')) throw new Error(`bad file path ${f}`);
  }
  const { entry, pkg } = resolveEntry(files);
  let format = entry.endsWith('.mjs') || (pkg && pkg.type === 'module') ? 'esm' : entry.endsWith('.cjs') ? 'cjs' : null;
  const out = new Map(files);
  if (!format) {
    if (looksLikeEsm(files.get(entry).toString('utf8'))) {
      format = 'esm';
      out.set('package.json', Buffer.from(JSON.stringify({ ...(pkg || {}), type: 'module' }, null, 2)));
    } else format = 'cjs';
  }
  const zip = new AdmZip();
  for (const [f, buf] of [...out.entries()].sort(([a], [b]) => a.localeCompare(b))) zip.addFile(f, buf, '', FILE_ATTR);
  zip.addFile(MANIFEST, Buffer.from(JSON.stringify({ entry, format })), '', FILE_ATTR);
  zip.addFile(SHIM_FILE, fs.readFileSync(path.join(ROOT, 'shim', SHIM_FILE)), '', FILE_ATTR);
  zip.addFile('scf_bootstrap', bootstrap(path.join(ROOT, 'shim', 'scf_bootstrap.tpl'), cfg.nodeDir), '', EXEC_ATTR);
  const buf = zip.toBuffer();
  if (buf.length > cfg.maxZipBytes) throw new Error(`package is ${(buf.length / 1048576).toFixed(1)} MB; v1 limit is ${cfg.maxZipBytes / 1048576} MB`);
  return buf;
}

function readDirFiles(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return new Map(walk(dir).map((f) => [f, fs.readFileSync(path.join(dir, f))]));
}

function buildUserZip(dir, cfg) { return buildUserZipFromFiles(readDirFiles(dir), cfg); }

// Single-module worker (console editor, API): the code becomes worker.mjs.
function buildSourceZip(source, cfg) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('code is empty');
  return buildUserZipFromFiles(new Map([['worker.mjs', Buffer.from(source)]]), cfg);
}

// Read the user's entry source back out of a deployed package (for the console editor).
function readEntryFromZip(buf) {
  const zip = new AdmZip(buf);
  const m = zip.getEntry(MANIFEST);
  let entry = m ? parseJson(m.getData(), MANIFEST).entry : null;
  if (!entry) entry = DEFAULT_ENTRIES.find((f) => zip.getEntry(f));
  const e = entry && zip.getEntry(entry);
  if (!e) return null;
  const files = zip.getEntries().map((x) => x.entryName).filter((n) => !RESERVED_FILES.has(n) && !n.startsWith('node_modules/'));
  return { entry, code: e.getData().toString('utf8'), files };
}

function buildRouterZip(cfg) {
  const zip = new AdmZip();
  for (const f of ['router/router.js', 'router/server.js', 'lib/names.js', 'lib/headers.js', 'lib/routes.js']) {
    zip.addFile(f, fs.readFileSync(path.join(ROOT, f)), '', FILE_ATTR);
  }
  zip.addFile('scf_bootstrap', bootstrap(path.join(ROOT, 'router', 'scf_bootstrap.tpl'), cfg.nodeDir), '', EXEC_ATTR);
  return zip.toBuffer();
}

module.exports = { buildUserZip, buildUserZipFromFiles, buildSourceZip, readDirFiles, readEntryFromZip, resolveEntry, buildRouterZip, walk, looksLikeEsm, EXEC_ATTR, FILE_ATTR, ROOT, SHIM_FILE, MANIFEST, bootstrap };
