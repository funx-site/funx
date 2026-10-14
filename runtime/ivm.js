'use strict';
// isolated-vm loader: on SCF (Node 18, ABI 108) use the glibc-2.28 build shipped in the package
// (vendor/isolated-vm-node18-glibc228, see infra/runtime/build-ivm.sh); elsewhere the npm install.
const path = require('path');
const fs = require('fs');
const candidates = [path.join(__dirname, 'vendor', 'isolated-vm'), path.join(__dirname, '..', 'vendor', 'isolated-vm-node18-glibc228')];
let mod = null;
if (process.versions.modules === '108') {
  for (const c of candidates) { if (fs.existsSync(path.join(c, 'out', 'isolated_vm.node'))) { mod = require(c); break; } }
}
module.exports = mod || require('isolated-vm');
