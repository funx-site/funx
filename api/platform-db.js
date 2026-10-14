'use strict';
// v2 platform: workers live in MySQL and run in the shared funx-runtime. Same shapes as cli/ops.js returns, so
// app.js, the console and the CLI don't change. No cloud API calls at all.
const { bundleFromFiles, bundleFromSource } = require('./bundle');

const MAX_BINDINGS = 64;
const MAX_VALUE_BYTES = 4096;

function createDbPlatform({ workers, cfg }) {
  const url = (name) => `https://${name}.${cfg.baseDomain}`;
  return {
    kind: 'db',
    async list() {
      return (await workers.list()).map((w) => ({ name: w.name, owner: w.owner, url: url(w.name), status: w.version ? 'Active' : 'Empty', disabled: w.disabled, routed: true, modTime: w.modTime }));
    },
    async getWorker({ name }) {
      const w = await workers.get(name);
      if (!w) return null;
      return { name, url: url(name), status: w.version ? 'Active' : 'Empty', routed: true, disabled: w.disabled, owner: w.owner, runtime: 'funx-runtime', modTime: w.modTime, version: w.version, vars: w.vars, secrets: w.secrets };
    },
    bundle(body) {
      if (typeof body.code === 'string') return bundleFromSource(body.code);
      if (body.files && typeof body.files === 'object') {
        const files = new Map();
        for (const [f, b64] of Object.entries(body.files)) {
          if (typeof b64 !== 'string') throw Object.assign(new Error('bad_files'), { status: 400, code: 'bad_files' });
          files.set(f, Buffer.from(b64, 'base64'));
        }
        return bundleFromFiles(files);
      }
      throw Object.assign(new Error('send "code" (single module) or "files"'), { status: 400, code: 'no_code' });
    },
    async deploy({ name, bundle, owner }) { const r = await workers.deploy(name, owner, bundle.bundle); return { url: url(name), version: r.version }; },
    async remove({ name }) { await workers.remove(name); },
    async setDisabled({ name, disabled }) { await workers.setDisabled(name, disabled); return { origin: 'flag' }; },
    async updateBindings({ name, set, type, remove }) {
      const cur = await workers.get(name);
      if (!cur) throw Object.assign(new Error(`${name} does not exist`), { code: 'ResourceNotFound.Worker' });
      for (const [k, v] of Object.entries(set || {})) if (Buffer.byteLength(String(v)) > MAX_VALUE_BYTES) throw new Error(`${k}: value is larger than ${MAX_VALUE_BYTES} bytes`);
      const names = new Set([...Object.keys(cur.vars), ...cur.secrets, ...Object.keys(set || {})]);
      for (const k of remove || []) names.delete(k);
      if (names.size > MAX_BINDINGS) throw new Error(`vars and secrets: at most ${MAX_BINDINGS} per worker`);
      // a name is either a var or a secret: setting one removes the other kind
      return workers.setBindings(name, { set: set || {}, type, remove: remove || [] });
    },
    async getCode({ name }) {
      const b = await workers.getBundle(name);
      if (!b) return null;
      return { entry: b.entry, code: b.files[b.entry], files: Object.keys(b.files).sort(), version: b.version };
    },
    async getLogs() { throw Object.assign(new Error('logs are not available yet'), { code: 'UnsupportedOperation.Logs' }); },
  };
}

function createScfPlatform({ ops, scf, cfg, download, buildSourceZip, buildUserZipFromFiles }) {
  return {
    kind: 'scf',
    list: () => ops.list(scf, cfg),
    getWorker: (a) => ops.getWorker(scf, cfg, a),
    bundle(body) {
      if (typeof body.code === 'string') return { zip: buildSourceZip(body.code, cfg) };
      if (body.files && typeof body.files === 'object') {
        const files = new Map();
        for (const [f, b64] of Object.entries(body.files)) {
          if (typeof b64 !== 'string') throw Object.assign(new Error('bad_files'), { status: 400, code: 'bad_files' });
          files.set(f, Buffer.from(b64, 'base64'));
        }
        return { zip: buildUserZipFromFiles(files, cfg) };
      }
      throw Object.assign(new Error('send "code" (single module) or "files"'), { status: 400, code: 'no_code' });
    },
    deploy: ({ name, bundle, owner, skipDomain }) => ops.deploy(scf, cfg, { name, zip: bundle.zip, owner, skipDomain }).then((u) => ({ url: u })),
    remove: (a) => ops.remove(scf, cfg, a),
    setDisabled: (a) => ops.setDisabled(scf, cfg, a),
    updateBindings: (a) => ops.updateBindings(scf, cfg, a),
    getCode: ({ name }) => ops.getCode(scf, cfg, { name, download }),
    getLogs: (a) => ops.getLogs(scf, cfg, a),
  };
}

module.exports = { createDbPlatform, createScfPlatform };
