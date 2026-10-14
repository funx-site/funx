'use strict';
// Worker bundles for the shared runtime: { entry, files: { path: utf8 source } }, version = sha256 of the
// canonical JSON. ES modules (.js/.mjs), .json (default export) and text modules (.txt/.html/.css/.md).
const crypto = require('crypto');
const { resolveEntry } = require('../cli/package');

const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_FILES = 64;
const OK_EXT = /\.(m?js|json|txt|html|css|md)$/;
const EXCLUDE = [/(^|\/)\.env(\..*)?$/, /(^|\/)\.dev\.vars$/, /\.pem$/, /\.key$/, /(^|\/)\.git(\/|$)/, /(^|\/)node_modules\//, /(^|\/)\.DS_Store$/];

function bad(msg) { return Object.assign(new Error(msg), { status: 400, code: 'bad_bundle' }); }

function canonical(bundle) {
  const files = {};
  for (const k of Object.keys(bundle.files).sort()) files[k] = bundle.files[k];
  return JSON.stringify({ entry: bundle.entry, files });
}
const versionOf = (bundle) => crypto.createHash('sha256').update(canonical(bundle)).digest('hex');

// files: Map<path, Buffer|string>
function bundleFromFiles(files) {
  const out = {};
  let size = 0;
  for (const [p0, data] of files) {
    const p = String(p0).replace(/^\.\//, '');
    if (EXCLUDE.some((re) => re.test(p))) continue;
    if (p.startsWith('/') || p.split('/').some((s) => s === '..' || s === '') || /[\\\0]/.test(p)) throw bad(`bad file path ${p}`);
    if (['package.json', 'wrangler.toml', 'package-lock.json', 'README.md'].includes(p)) continue;
    if (!OK_EXT.test(p)) continue; // assets/binaries are not part of a worker bundle (v1)
    const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    size += Buffer.byteLength(s);
    out[p] = s;
  }
  if (!Object.keys(out).length) throw bad('code is empty');
  if (Object.keys(out).length > MAX_FILES) throw bad(`too many files (max ${MAX_FILES})`);
  if (size > MAX_BUNDLE_BYTES) throw bad(`worker is ${(size / 1024).toFixed(0)} KB; limit is ${MAX_BUNDLE_BYTES / 1024} KB`);
  const fm = new Map([...files].map(([k, v]) => [String(k).replace(/^\.\//, ''), Buffer.isBuffer(v) ? v : Buffer.from(String(v))]));
  let entry;
  try { entry = resolveEntry(fm).entry; } catch (e) { throw bad(e.message); }
  if (!out[entry]) throw bad(`entry file ${entry} must be .js or .mjs`);
  if (!/\.m?js$/.test(entry)) throw bad('entry must be a .js or .mjs module');
  if (!/\bexport\s+default\b/.test(out[entry])) throw bad('entry must use module syntax: export default { fetch(request, env, ctx) { ... } }');
  const bundle = { entry, files: out };
  return { bundle, version: versionOf(bundle), size };
}

const bundleFromSource = (code) => {
  if (typeof code !== 'string' || !code.trim()) throw bad('code is empty');
  return bundleFromFiles(new Map([['index.js', code]]));
};

module.exports = { bundleFromFiles, bundleFromSource, versionOf, MAX_BUNDLE_BYTES };
