'use strict';
// Worker storage for the shared runtime (v2). Rows live in the platform logical database
// (see platform-data.js), in funx_udata, not in funx_workers / funx_worker_versions / funx_worker_bindings.
const { seal, open } = require('./secretbox');
const { versionOf } = require('./bundle');
const { MemoryDataStore, MysqlDataStore } = require('./data-store');
const { PlatformDb, PLATFORM_DOC_BYTES, KEEP_VERSIONS, versionKey, bindingKey } = require('./platform-data');

const notFound = (name) => Object.assign(new Error(`${name} does not exist`), { code: 'ResourceNotFound.Worker' });

function summary(w, bindings, entry) {
  const vars = {}; const secrets = [];
  for (const b of bindings) { if (b.kind === 'var') vars[b.bkey] = b.value; else secrets.push(b.bkey); }
  secrets.sort();
  return { name: w.name, owner: w.owner_id, disabled: !!w.disabled, version: w.current_version || null, entry: entry || null, modTime: w.updated_at || null, createdAt: w.created_at || null, vars, secrets };
}

function buildRuntimeConfig(key, w, bundle, bindings) {
  const env = {};
  for (const b of bindings) env[b.bkey] = b.kind === 'secret' ? open(key, w.name, b.bkey, b.sealed) : b.value;
  return { name: w.name, version: w.current_version, disabled: !!w.disabled, entry: bundle.entry, files: bundle.files, env };
}

class DataWorkerStore {
  constructor(data, { secretsKey }) {
    this.data = data;
    this.platform = new PlatformDb(data);
    this.key = secretsKey;
  }

  ensure() { return this.platform.ensure(); }

  async list() {
    await this.ensure();
    const rows = await this.platform.listAll('workers');
    return rows.map((r) => ({
      name: r.values.name,
      owner: r.values.owner_id,
      disabled: !!r.values.disabled,
      version: r.values.current_version,
      modTime: r.values.updated_at || null,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async _bindings(name) {
    const rows = await this.platform.listAll('worker_bindings', { prefix: `${name}@` });
    return rows.filter((r) => r.values.name === name).map((r) => r.values);
  }

  async get(name) {
    await this.ensure();
    const w = await this.platform.getRow('workers', name);
    if (!w) return null;
    const v = w.values.current_version ? await this.platform.getRow('worker_versions', versionKey(name, w.values.current_version)) : null;
    return summary(w.values, await this._bindings(name), v && v.values.entry);
  }

  async getBundle(name) {
    await this.ensure();
    const w = await this.platform.getRow('workers', name);
    if (!w || !w.values.current_version) return null;
    const v = await this.platform.getRow('worker_versions', versionKey(name, w.values.current_version));
    if (!v || !v.values.bundle) return null;
    return { version: w.values.current_version, entry: v.values.bundle.entry, files: v.values.bundle.files };
  }

  async deploy(name, ownerId, bundle) {
    await this.ensure();
    const version = versionOf(bundle);
    const now = new Date().toISOString();
    const size = Buffer.byteLength(JSON.stringify(bundle));
    const created = await this.platform.transact(async (tx) => {
      const w = await tx.getRow('workers', name, { lock: true });
      if (!w) {
        await tx.insertRow('workers', name, {
          name, owner_id: ownerId || null, disabled: false, current_version: null, created_at: now, updated_at: now,
        });
      }
      const vk = versionKey(name, version);
      if (!(await tx.getRow('worker_versions', vk))) {
        await tx.insertRow('worker_versions', vk, {
          id: vk, name, version, entry: bundle.entry, bundle, size, created_at: now, created_by: ownerId || null,
        }, { maxBytes: PLATFORM_DOC_BYTES });
      }
      const cur = w || await tx.getRow('workers', name);
      await tx.putRow('workers', name, { ...cur.values, current_version: version, updated_at: now });
      return !w;
    });
    await this._prune(name, version);
    return { version, created };
  }

  async _prune(name, current) {
    const rows = (await this.platform.listAll('worker_versions', { prefix: `${name}@` })).filter((r) => r.values.name === name);
    rows.sort((a, b) => {
      if (a.values.created_at === b.values.created_at) return a.values.version < b.values.version ? 1 : -1;
      return a.values.created_at < b.values.created_at ? 1 : -1;
    });
    const keep = new Set(rows.slice(0, KEEP_VERSIONS).map((r) => r.values.version));
    keep.add(current);
    for (const r of rows) if (!keep.has(r.values.version)) await this.platform.deleteRow('worker_versions', r.pk);
  }

  async remove(name) {
    await this.ensure();
    for (const table of ['worker_versions', 'worker_bindings']) {
      const rows = await this.platform.listAll(table, { prefix: `${name}@` });
      for (const r of rows) if (r.values.name === name) await this.platform.deleteRow(table, r.pk);
    }
    await this.platform.deleteRow('workers', name);
  }

  async setDisabled(name, disabled) {
    await this.ensure();
    const w = await this.platform.getRow('workers', name);
    if (!w) throw notFound(name);
    await this.platform.putRow('workers', name, { ...w.values, disabled: !!disabled, updated_at: new Date().toISOString() });
  }

  async setBindings(name, { set = {}, type = 'var', remove = [] }) {
    await this.ensure();
    if (!(await this.platform.getRow('workers', name))) throw notFound(name);
    for (const k of remove) await this.platform.deleteRow('worker_bindings', bindingKey(name, k));
    for (const [k, v] of Object.entries(set)) {
      const id = bindingKey(name, k);
      const row = type === 'secret'
        ? { id, name, bkey: k, kind: 'secret', value: null, sealed: seal(this.key, name, k, v) }
        : { id, name, bkey: k, kind: 'var', value: String(v), sealed: null };
      await this.platform.putRow('worker_bindings', id, row);
    }
    const s = await this.get(name);
    return { vars: s.vars, secrets: s.secrets };
  }

  async runtimeConfig(name) {
    await this.ensure();
    const w = await this.platform.getRow('workers', name);
    if (!w || !w.values.current_version) return null;
    const v = await this.platform.getRow('worker_versions', versionKey(name, w.values.current_version));
    if (!v || !v.values.bundle) return null;
    return buildRuntimeConfig(this.key, w.values, v.values.bundle, await this._bindings(name));
  }
}

class MemoryWorkerStore {
  constructor({ secretsKey }) {
    this.data = new MemoryDataStore();
    this.inner = new DataWorkerStore(this.data, { secretsKey });
  }
  migrate() { return this.inner.ensure(); }
  list() { return this.inner.list(); }
  get(name) { return this.inner.get(name); }
  getBundle(name) { return this.inner.getBundle(name); }
  deploy(name, ownerId, bundle) { return this.inner.deploy(name, ownerId, bundle); }
  remove(name) { return this.inner.remove(name); }
  setDisabled(name, disabled) { return this.inner.setDisabled(name, disabled); }
  setBindings(name, spec) { return this.inner.setBindings(name, spec); }
  runtimeConfig(name) { return this.inner.runtimeConfig(name); }
}

class MysqlWorkerStore {
  constructor(pool, { secretsKey, dataStore, schemaName } = {}) {
    this.data = dataStore || new MysqlDataStore(pool, { schemaName: schemaName || 'funx' });
    this.inner = new DataWorkerStore(this.data, { secretsKey });
  }
  migrate() { return this.inner.ensure(); }
  list() { return this.inner.list(); }
  get(name) { return this.inner.get(name); }
  getBundle(name) { return this.inner.getBundle(name); }
  deploy(name, ownerId, bundle) { return this.inner.deploy(name, ownerId, bundle); }
  remove(name) { return this.inner.remove(name); }
  setDisabled(name, disabled) { return this.inner.setDisabled(name, disabled); }
  setBindings(name, spec) { return this.inner.setBindings(name, spec); }
  runtimeConfig(name) { return this.inner.runtimeConfig(name); }
}

module.exports = { MemoryWorkerStore, MysqlWorkerStore, DataWorkerStore };
