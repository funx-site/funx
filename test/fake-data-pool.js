'use strict';
// In-memory stand-in for the statements MysqlDataStore actually sends. Two pools do not share rows.
const { cmpPk } = require('../api/data-store');

function fakeDataPool() {
  const db = { funx_data_nodes: [], funx_udb: [], funx_utbl: [], funx_udata: [], auto: { funx_udb: 1, funx_utbl: 1 } };
  const sqlLog = [];
  let fail = null;
  const clone = (state) => JSON.parse(JSON.stringify(state));
  const queryOn = (state, sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim().replace(/ FOR UPDATE$/, '');
    sqlLog.push(s);
    const boom = typeof fail === 'function' ? fail(s, params) : fail && fail.test(s);
    if (boom) throw Object.assign(new Error('boom'), { code: 'ER_FAKE' });
    if (s.startsWith('CREATE TABLE IF NOT EXISTS')) return [{}];
    if (s.startsWith('INSERT IGNORE INTO funx_data_nodes') || s.startsWith('INSERT INTO funx_data_nodes')) {
      const [id, schema_name, status] = params;
      if (state.funx_data_nodes.some((r) => r.id === id)) {
        if (s.startsWith('INSERT IGNORE')) return [{}];
        throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      }
      state.funx_data_nodes.push({ id, schema_name, status, created_at: new Date() });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('UPDATE funx_data_nodes SET status = ? WHERE id = ?')) {
      const row = state.funx_data_nodes.find((r) => r.id === params[1]);
      if (row) row.status = params[0];
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (s === "SELECT id FROM funx_data_nodes WHERE status = 'active' ORDER BY id") {
      return [state.funx_data_nodes.filter((r) => r.status === 'active').map((r) => ({ id: r.id })).sort((a, b) => a.id - b.id)];
    }
    if (s.startsWith('SELECT id FROM funx_udb WHERE owner_id = ? AND name = ?')) {
      return [state.funx_udb.filter((r) => r.owner_id === params[0] && r.name === params[1]).map((r) => ({ id: r.id }))];
    }
    if (s.startsWith('SELECT COUNT(*) AS n FROM funx_udb WHERE owner_id = ?')) {
      return [[{ n: state.funx_udb.filter((r) => r.owner_id === params[0]).length }]];
    }
    if (s.startsWith('SELECT node_id FROM funx_udb WHERE owner_id = ? ORDER BY id LIMIT 1')) {
      const rows = state.funx_udb.filter((r) => r.owner_id === params[0]).sort((a, b) => a.id - b.id);
      return [rows[0] ? [{ node_id: rows[0].node_id }] : []];
    }
    if (s.startsWith('INSERT INTO funx_udb')) {
      if (state.funx_udb.some((r) => r.owner_id === params[0] && r.name === params[1])) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      const row = { id: state.auto.funx_udb++, owner_id: params[0], name: params[1], node_id: params[2], ddl_version: 1, created_at: new Date() };
      state.funx_udb.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }
    if (s.startsWith('SELECT id, owner_id, name, node_id, ddl_version, created_at FROM funx_udb WHERE owner_id = ? AND name = ?')) {
      return [state.funx_udb.filter((r) => r.owner_id === params[0] && r.name === params[1])];
    }
    if (s.startsWith('SELECT id, owner_id, name, node_id, ddl_version, created_at FROM funx_udb WHERE owner_id = ? ORDER BY name')) {
      return [[...state.funx_udb.filter((r) => r.owner_id === params[0])].sort((a, b) => (a.name < b.name ? -1 : 1))];
    }
    if (s.startsWith('DELETE FROM funx_udb WHERE id = ?')) {
      const before = state.funx_udb.length;
      state.funx_udb = state.funx_udb.filter((r) => r.id !== params[0]);
      return [{ affectedRows: before - state.funx_udb.length }];
    }
    if (s.startsWith('UPDATE funx_udb SET ddl_version = ddl_version + 1 WHERE id = ?')) {
      const row = state.funx_udb.find((r) => r.id === params[0]);
      if (row) row.ddl_version += 1;
      return [{ affectedRows: row ? 1 : 0 }];
    }
    if (s.startsWith('SELECT COUNT(*) AS n FROM funx_utbl WHERE udb_id = ?')) {
      return [[{ n: state.funx_utbl.filter((r) => r.udb_id === params[0]).length }]];
    }
    if (s.startsWith('SELECT id, udb_id, name, columns_json, created_at FROM funx_utbl WHERE udb_id = ? AND name = ?')) {
      return [state.funx_utbl.filter((r) => r.udb_id === params[0] && r.name === params[1])];
    }
    if (s.startsWith('SELECT id, udb_id, name, columns_json, created_at FROM funx_utbl WHERE udb_id = ? ORDER BY name')) {
      return [[...state.funx_utbl.filter((r) => r.udb_id === params[0])].sort((a, b) => (a.name < b.name ? -1 : 1))];
    }
    if (s.startsWith('INSERT INTO funx_utbl')) {
      if (state.funx_utbl.some((r) => r.udb_id === params[0] && r.name === params[1])) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
      const row = { id: state.auto.funx_utbl++, udb_id: params[0], name: params[1], columns_json: JSON.parse(JSON.stringify(params[2])), created_at: new Date() };
      state.funx_utbl.push(row);
      return [{ insertId: row.id, affectedRows: 1 }];
    }
    if (s.startsWith('DELETE FROM funx_utbl WHERE udb_id = ?')) {
      const before = state.funx_utbl.length;
      state.funx_utbl = state.funx_utbl.filter((r) => r.udb_id !== params[0]);
      return [{ affectedRows: before - state.funx_utbl.length }];
    }
    if (s.startsWith('DELETE FROM funx_utbl WHERE id = ?')) {
      const before = state.funx_utbl.length;
      state.funx_utbl = state.funx_utbl.filter((r) => r.id !== params[0]);
      return [{ affectedRows: before - state.funx_utbl.length }];
    }
    const lim = s.match(/ LIMIT (\d+)$/);
    if (lim && s.startsWith('SELECT pk, doc, updated_at FROM funx_udata') && s.includes('ORDER BY pk LIMIT')) {
      const n = Number(lim[1]);
      const rows = state.funx_udata.filter((r) => r.udb_id === params[0] && r.utbl_id === params[1] && r.pk !== '\u0000' && udataInRange(s, r.pk, params)).sort((a, b) => cmpPk(a.pk, b.pk));
      return [rows.slice(0, n)];
    }
    if (s.startsWith('SELECT doc FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?')) {
      return [state.funx_udata.filter((r) => r.udb_id === params[0] && r.utbl_id === params[1] && r.pk === params[2]).map((r) => ({ doc: r.doc }))];
    }
    if (s.startsWith('SELECT pk, doc, updated_at FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?')) {
      return [state.funx_udata.filter((r) => r.udb_id === params[0] && r.utbl_id === params[1] && r.pk === params[2])];
    }
    if (s.startsWith('SELECT pk FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?')) {
      return [state.funx_udata.filter((r) => r.udb_id === params[0] && r.utbl_id === params[1] && r.pk === params[2]).map((r) => ({ pk: r.pk }))];
    }
    if (s.startsWith('INSERT INTO funx_udata')) {
      const hit = state.funx_udata.find((r) => r.udb_id === params[0] && r.utbl_id === params[1] && r.pk === params[2]);
      if (!s.includes('ON DUPLICATE')) {
        if (hit) throw Object.assign(new Error('dup'), { code: 'ER_DUP_ENTRY' });
        state.funx_udata.push({ udb_id: params[0], utbl_id: params[1], pk: params[2], doc: JSON.parse(JSON.stringify(params[3])), updated_at: new Date() });
        return [{ affectedRows: 1 }];
      }
      if (hit) { hit.doc = JSON.parse(JSON.stringify(params[3])); hit.updated_at = new Date(); return [{ affectedRows: 2 }]; }
      state.funx_udata.push({ udb_id: params[0], utbl_id: params[1], pk: params[2], doc: JSON.parse(JSON.stringify(params[3])), updated_at: new Date() });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith('DELETE FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?')) {
      const before = state.funx_udata.length;
      state.funx_udata = state.funx_udata.filter((r) => !(r.udb_id === params[0] && r.utbl_id === params[1] && r.pk === params[2]));
      return [{ affectedRows: before - state.funx_udata.length }];
    }
    if (s.startsWith('DELETE FROM funx_udata WHERE udb_id = ? AND utbl_id = ?')) {
      const before = state.funx_udata.length;
      state.funx_udata = state.funx_udata.filter((r) => !(r.udb_id === params[0] && r.utbl_id === params[1]));
      return [{ affectedRows: before - state.funx_udata.length }];
    }
    if (s.startsWith('DELETE FROM funx_udata WHERE udb_id = ?')) {
      const before = state.funx_udata.length;
      state.funx_udata = state.funx_udata.filter((r) => r.udb_id !== params[0]);
      return [{ affectedRows: before - state.funx_udata.length }];
    }
    throw new Error(`fake data pool: unexpected SQL ${s}`);
  };
  const pool = {
    query: async (sql, p) => queryOn(db, sql, p),
    getConnection: async () => {
      let tx = null;
      return {
        beginTransaction: async () => { tx = clone(db); },
        query: async (sql, p) => queryOn(tx, sql, p),
        commit: async () => { Object.assign(db, tx); tx = null; },
        rollback: async () => { tx = null; },
        release() {},
      };
    },
  };
  return { pool, db, sql: sqlLog, failOn: (re) => { fail = re; } };
}

function asBuf(v) { return Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'); }
function cmpRaw(a, b) { return Buffer.compare(asBuf(a), asBuf(b)); }

// Prefix scans pass a byte upper bound, which is not always a valid string.
function udataInRange(sql, pk, params) {
  if (sql.includes('pk >= ? AND pk < ?')) return cmpRaw(pk, params[2]) >= 0 && cmpRaw(pk, params[3]) < 0;
  if (sql.includes('pk > ? AND pk < ?')) return cmpRaw(pk, params[2]) > 0 && cmpRaw(pk, params[3]) < 0;
  if (sql.includes('AND pk > ?')) return cmpRaw(pk, params[2]) > 0;
  return true;
}


module.exports = { fakeDataPool };
