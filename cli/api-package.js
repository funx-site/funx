'use strict';
// Builds dist/funx-api.zip: api/ + the shared CLI library + production node_modules.
// Building only; deploying is a separate, reviewed step (operator runbook kept private).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const AdmZip = require('adm-zip');
const { walk, bootstrap, FILE_ATTR, EXEC_ATTR, ROOT } = require('./package');

const SOURCES = ['api', 'lib', 'shim', 'cli/ops.js', 'cli/package.js', 'cli/config.js', 'cli/auth.js', 'cli/scf.js', 'cli/deploy-keys.json', 'examples/worker/index.js', 'package.json'];

function prodModules() {
  const out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter((l) => l && l !== ROOT && l.includes(`${path.sep}node_modules${path.sep}`));
}

function buildApiZip(cfg) {
  const zip = new AdmZip();
  const add = (abs) => zip.addFile(path.relative(ROOT, abs).split(path.sep).join('/'), fs.readFileSync(abs), '', FILE_ATTR);
  for (const s of SOURCES) {
    const abs = path.join(ROOT, s);
    if (fs.statSync(abs).isDirectory()) for (const f of walk(abs)) { if (!f.endsWith('.tpl') || s !== 'api') add(path.join(abs, f)); }
    else add(abs);
  }
  for (const dir of prodModules()) for (const f of walk(dir)) { if (!f.includes('node_modules/')) add(path.join(dir, f)); }
  zip.addFile('scf_bootstrap', bootstrap(path.join(ROOT, 'api', 'scf_bootstrap.tpl'), cfg.nodeDir), '', EXEC_ATTR);
  return zip.toBuffer();
}

module.exports = { buildApiZip };
