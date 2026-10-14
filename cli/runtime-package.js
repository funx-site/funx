'use strict';
// Builds dist/funx-runtime.zip for the shared runtime (HK). No npm dependencies: runtime code, lib/names.js,
// the glibc-2.28 isolated-vm build for Node 18 and a non-secret config.json (apiBase, baseDomain, limits).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const { walk, bootstrap, FILE_ATTR, EXEC_ATTR, ROOT } = require('./package');

const IVM = path.join(ROOT, 'vendor', 'isolated-vm-node18-glibc228');

function buildRuntimeZip(cfg, { apiBase, baseDomain = cfg.baseDomain, limits = {} }) {
  if (!/^https:\/\/[a-z0-9.-]+(\/.*)?$/i.test(apiBase || '')) throw new Error('runtime-build needs --api https://<funx-api host>');
  // the shipped binary must be the one we built and checked (SHA256SUMS next to it)
  const sums = fs.readFileSync(path.join(IVM, 'SHA256SUMS'), 'utf8').trim().split(/\s+/);
  const got = crypto.createHash('sha256').update(fs.readFileSync(path.join(IVM, sums[1]))).digest('hex');
  if (got !== sums[0]) throw new Error('vendor isolated-vm binary does not match SHA256SUMS');
  const zip = new AdmZip();
  for (const f of ['egress.js', 'ivm.js', 'prelude.js', 'sandbox.js', 'server.js']) zip.addFile(`runtime/${f}`, fs.readFileSync(path.join(ROOT, 'runtime', f)), '', FILE_ATTR);
  zip.addFile('lib/names.js', fs.readFileSync(path.join(ROOT, 'lib', 'names.js')), '', FILE_ATTR);
  for (const f of walk(IVM)) zip.addFile(`runtime/vendor/isolated-vm/${f}`, fs.readFileSync(path.join(IVM, f)), '', f.endsWith('.node') ? EXEC_ATTR : FILE_ATTR);
  zip.addFile('runtime/config.json', Buffer.from(JSON.stringify({ apiBase, baseDomain, limits }, null, 2)), '', FILE_ATTR);
  zip.addFile('scf_bootstrap', bootstrap(path.join(ROOT, 'runtime', 'scf_bootstrap.tpl'), cfg.nodeDir), '', EXEC_ATTR);
  return zip.toBuffer();
}

module.exports = { buildRuntimeZip };
