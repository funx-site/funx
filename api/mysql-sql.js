'use strict';
// A small SQL surface over one account's logical databases.
// Enough for the mysql client, a GUI, and an application connection string:
// create and drop databases and tables, insert, select, update, delete.
// Joins, secondary indexes, and non-string primary keys are refused.

const { cmpPk } = require('./data-store');

const SERVER_VERSION = '5.7.40-funx';
const RESERVED = new Set(`from where and or order group limit offset set values into table database
select insert update delete create drop show use primary key not null as by asc desc like join left
right inner on if exists replace start commit rollback begin transaction describe desc columns
databases tables variables status full schema character charset collate comment default unique index
constraint references check auto_increment ignore replace into`.split(/\s+/));

function sqlError(errno, message, sqlState = '42000') {
  return Object.assign(new Error(message), { errno, sqlState });
}

function stripComments(sql) {
  let out = '';
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 1;
      out += ' ';
      continue;
    }
    if (sql[i] === '#') {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length - 1 : end - 1;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-' && (sql[i + 2] == null || /[\s]/.test(sql[i + 2]))) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length - 1 : end - 1;
      continue;
    }
    out += sql[i];
  }
  return out;
}

function tokenize(sql) {
  const s = stripComments(sql);
  const tokens = [];
  let i = 0;
  const push = (t, v) => tokens.push({ t, v });
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let out = '';
      while (j < s.length) {
        if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2; continue; }
        if (s[j] === c) {
          if (s[j + 1] === c) { out += c; j += 2; continue; }
          break;
        }
        out += s[j++];
      }
      if (j >= s.length) throw sqlError(1064, 'unclosed string');
      push('str', out);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let out = '';
      while (j < s.length) {
        if (s[j] === '`' && s[j + 1] === '`') { out += '`'; j += 2; continue; }
        if (s[j] === '`') break;
        out += s[j++];
      }
      if (j >= s.length) throw sqlError(1064, 'unclosed name');
      push('id', out);
      i = j + 1;
      continue;
    }
    if (c === '@' && s[i + 1] === '@') {
      const m = /^[A-Za-z0-9_.]+/.exec(s.slice(i + 2));
      if (!m) throw sqlError(1064, 'expected a variable name');
      push('sys', m[0].toLowerCase());
      i += 2 + m[0].length;
      continue;
    }
    if (c === '-' && /[0-9]/.test(s[i + 1]) || /[0-9]/.test(c)) {
      const m = /^-?\d+/.exec(s.slice(i));
      if (!m) throw sqlError(1064, 'bad number');
      if (s[i + m[0].length] === '.') throw sqlError(1235, 'fractional numbers are not supported');
      push('num', Number(m[0]));
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z0-9_]+/.exec(s.slice(i));
      push('word', m[0]);
      i += m[0].length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '<>' || two === '!=') { push('op', two); i += 2; continue; }
    push('op', c);
    i++;
  }
  return tokens;
}

function splitStatements(sql) {
  const tokens = tokenize(sql);
  const parts = [];
  let cur = [];
  for (const tok of tokens) {
    if (tok.t === 'op' && tok.v === ';') {
      if (cur.length) parts.push(cur);
      cur = [];
    } else cur.push(tok);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function parser(tokens) {
  return {
    tokens,
    i: 0,
    peek() { return tokens[this.i]; },
    eat() { return tokens[this.i++]; },
    word(w) { const t = tokens[this.i]; return !!(t && t.t === 'word' && t.v.toLowerCase() === w); },
    takeWord(w) { if (!this.word(w)) return false; this.i++; return true; },
    op(v) { const t = tokens[this.i]; return !!(t && t.t === 'op' && t.v === v); },
    takeOp(v) { if (!this.op(v)) return false; this.i++; return true; },
    expectOp(v) { if (!this.takeOp(v)) throw sqlError(1064, `expected ${v}`); },
    expectWord(w) { if (!this.takeWord(w)) throw sqlError(1064, `expected ${w}`); },
    done() { if (this.i < tokens.length) throw sqlError(1064, `unexpected ${tokens[this.i].v}`); },
  };
}

function foldName(name) {
  const n = String(name).toLowerCase();
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(n)) throw sqlError(1064, `bad name ${name}`);
  return n;
}

function parseIdent(p, allowReserved = false) {
  const t = p.peek();
  if (!t) throw sqlError(1064, 'expected a name');
  if (t.t === 'id') { p.eat(); return foldName(t.v); }
  if (t.t === 'word' && (allowReserved || !RESERVED.has(t.v.toLowerCase()))) { p.eat(); return foldName(t.v); }
  throw sqlError(1064, `expected a name near ${t.v}`);
}

function parseQualified(p) {
  const a = parseIdent(p);
  if (p.takeOp('.')) return { schema: a, name: parseIdent(p, true) };
  return { schema: null, name: a };
}

function parseLiteral(p) {
  const t = p.peek();
  if (!t) throw sqlError(1064, 'expected a value');
  if (t.t === 'str') { p.eat(); return t.v; }
  if (t.t === 'num') { p.eat(); return t.v; }
  if (t.t === 'word' && t.v.toLowerCase() === 'null') { p.eat(); return null; }
  if (t.t === 'word' && t.v.toLowerCase() === 'default') { p.eat(); return null; }
  if (t.t === 'word' && (t.v.toLowerCase() === 'true' || t.v.toLowerCase() === 'false')) {
    p.eat();
    return t.v.toLowerCase() === 'true';
  }
  throw sqlError(1235, `unsupported value ${t.v}`);
}

function parseSetValue(p) {
  const t = p.peek();
  if (t && t.t === 'word' && (t.v.toLowerCase() === 'on' || t.v.toLowerCase() === 'off')) {
    p.eat();
    return t.v.toLowerCase();
  }
  if (t && (t.t === 'word' || t.t === 'id') && !p.op('=')) return parseIdent(p);
  return parseLiteral(p);
}

function parseType(p) {
  const t = p.peek();
  if (!t || t.t !== 'word') throw sqlError(1064, 'expected a column type');
  p.eat();
  const n = t.v.toLowerCase();
  let len = null;
  if (p.takeOp('(')) {
    const num = p.peek();
    if (!num || num.t !== 'num') throw sqlError(1064, 'expected a length');
    len = num.v;
    p.eat();
    if (p.takeOp(',')) {
      if (!p.peek() || p.peek().t !== 'num') throw sqlError(1064, 'expected a length');
      p.eat();
    }
    p.expectOp(')');
  }
  if (['varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext'].includes(n)) return 'string';
  if (n === 'tinyint' && len === 1) return 'bool';
  if (n === 'bool' || n === 'boolean') return 'bool';
  if (['int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint'].includes(n)) return 'int';
  if (n === 'json') return 'json';
  throw sqlError(1235, `column type ${t.v} is not supported; use VARCHAR, INT, BOOL, or JSON`);
}

function parseColumnRest(p, col) {
  while (p.peek() && !p.op(',') && !p.op(')')) {
    if (p.takeWord('primary')) { p.expectWord('key'); col.primary = true; continue; }
    if (p.takeWord('not')) { p.takeWord('null'); continue; }
    if (p.takeWord('null')) continue;
    if (p.takeWord('default')) { parseLiteral(p); continue; }
    if (p.takeWord('comment')) { parseLiteral(p); continue; }
    if (p.takeWord('collate')) { parseIdent(p); continue; }
    if (p.takeWord('character')) { p.takeWord('set'); parseIdent(p); continue; }
    if (p.takeWord('charset')) { parseIdent(p); continue; }
    if (p.takeWord('auto_increment')) continue;
    const w = p.peek();
    if (w && w.t === 'word' && ['unique', 'key', 'index', 'constraint', 'references', 'check'].includes(w.v.toLowerCase())) {
      throw sqlError(1235, 'indexes other than the primary key are not supported');
    }
    throw sqlError(1064, `unexpected ${w ? w.v : 'end'} in a column`);
  }
}

function parseWhere(p) {
  if (!p.takeWord('where')) return null;
  const terms = [];
  do {
    const t = p.peek();
    if (t && (t.t === 'num' || t.t === 'str')) {
      const left = parseLiteral(p);
      if (!p.peek() || p.peek().t !== 'op') {
        terms.push({ constant: left });
      } else {
        const op = p.eat().v;
        terms.push({ left, op, right: parseLiteral(p), constantCmp: true });
      }
    } else {
      let col = parseIdent(p);
      if (p.takeOp('.')) col = parseIdent(p);
      if (p.takeWord('is')) {
        const not = p.takeWord('not');
        p.expectWord('null');
        terms.push({ col, op: not ? 'is not' : 'is' });
      } else {
        const opTok = p.peek();
        if (!opTok || opTok.t !== 'op' || !['=', '!=', '<>', '<', '>', '<=', '>='].includes(opTok.v)) {
          throw sqlError(1064, 'expected a comparison');
        }
        p.eat();
        terms.push({ col, op: opTok.v === '<>' ? '!=' : opTok.v, value: parseLiteral(p) });
      }
    }
    if (p.word('or')) throw sqlError(1235, 'OR is not supported');
  } while (p.takeWord('and'));
  return terms;
}

function parseOrderLimit(p) {
  let order = null;
  if (p.takeWord('order')) {
    p.expectWord('by');
    let col = parseIdent(p);
    if (p.takeOp('.')) col = parseIdent(p);
    const desc = p.takeWord('desc');
    if (!desc) p.takeWord('asc');
    order = { col, desc };
  }
  let limit = null;
  let offset = 0;
  if (p.takeWord('limit')) {
    const a = p.peek();
    if (!a || a.t !== 'num' || a.v < 0) throw sqlError(1064, 'bad LIMIT');
    p.eat();
    if (p.takeOp(',')) {
      const b = p.peek();
      if (!b || b.t !== 'num' || b.v < 0) throw sqlError(1064, 'bad LIMIT');
      p.eat();
      offset = a.v;
      limit = b.v;
    } else {
      limit = a.v;
      if (p.takeWord('offset')) {
        const o = p.peek();
        if (!o || o.t !== 'num' || o.v < 0) throw sqlError(1064, 'bad OFFSET');
        p.eat();
        offset = o.v;
      }
    }
  }
  return { order, limit, offset };
}

function parseSelectList(p) {
  const cols = [];
  do {
    if (p.takeOp('*')) cols.push({ star: true });
    else if (p.peek() && p.peek().t === 'sys') cols.push({ sys: p.eat().v });
    else if (p.peek() && (p.peek().t === 'str' || p.peek().t === 'num' || (p.peek().t === 'word' && ['null', 'true', 'false'].includes(p.peek().v.toLowerCase())))) {
      cols.push({ literal: parseLiteral(p) });
    } else if (p.peek() && p.peek().t === 'word' && p.tokens[p.i + 1] && p.tokens[p.i + 1].t === 'op' && p.tokens[p.i + 1].v === '(') {
      const name = foldName(p.eat().v);
      p.expectOp('(');
      if (!p.takeOp(')')) {
        do { parseLiteral(p); } while (p.takeOp(','));
        p.expectOp(')');
      }
      cols.push({ fn: name });
    } else {
      const name = parseIdent(p);
      if (p.takeOp('(')) {
        if (!p.takeOp(')')) {
          do { parseLiteral(p); } while (p.takeOp(','));
          p.expectOp(')');
        }
        cols.push({ fn: name });
      } else if (p.takeOp('.')) {
        if (p.takeOp('*')) cols.push({ star: true });
        else cols.push({ col: parseIdent(p) });
      } else cols.push({ col: name });
    }
    if (p.takeWord('as')) cols[cols.length - 1].as = parseIdent(p);
    else if (p.peek() && p.peek().t === 'word' && !RESERVED.has(p.peek().v.toLowerCase())) {
      cols[cols.length - 1].as = parseIdent(p);
    }
  } while (p.takeOp(','));
  return cols;
}

function parseStatement(tokens) {
  const p = parser(tokens);
  const first = p.peek();
  if (!first || first.t !== 'word') throw sqlError(1064, 'expected a statement');
  const kind = first.v.toLowerCase();

  if (kind === 'set') {
    p.eat();
    if (p.takeWord('names')) {
      parseSetValue(p);
      if (p.takeWord('collate')) parseSetValue(p);
      p.done();
      return { kind: 'set', assigns: [] };
    }
    const assigns = [];
    do {
      p.takeWord('session') || p.takeWord('global') || p.takeWord('local');
      if (p.peek() && p.peek().t === 'sys') {
        const name = p.eat().v;
        p.takeOp('=');
        assigns.push({ name, value: parseSetValue(p) });
      } else {
        const name = parseIdent(p);
        if (!(p.peek() && p.peek().t === 'op' && p.peek().v === '=')) assigns.push({ name, value: parseSetValue(p) });
        else { p.expectOp('='); assigns.push({ name, value: parseSetValue(p) }); }
      }
    } while (p.takeOp(','));
    p.done();
    return { kind: 'set', assigns };
  }

  if (kind === 'use') {
    p.eat();
    const name = parseIdent(p);
    p.done();
    return { kind: 'use', name };
  }

  if (kind === 'begin' || (kind === 'start' && p.tokens[1] && String(p.tokens[1].v).toLowerCase() === 'transaction')) {
    if (kind === 'start') { p.eat(); p.expectWord('transaction'); } else p.eat();
    p.done();
    return { kind: 'begin' };
  }
  if (kind === 'commit' || kind === 'rollback') {
    p.eat();
    p.done();
    return { kind };
  }

  if (kind === 'show') {
    p.eat();
    const full = p.takeWord('full');
    if (p.takeWord('databases') || p.takeWord('schemas')) {
      let like = null;
      if (p.takeWord('like')) like = String(parseLiteral(p));
      p.done();
      return { kind: 'show-databases', like };
    }
    if (p.takeWord('table')) {
      p.expectWord('status');
      let schema = null;
      if (p.takeWord('from') || p.takeWord('in')) schema = parseIdent(p);
      let like = null;
      if (p.takeWord('like')) like = String(parseLiteral(p));
      p.done();
      return { kind: 'show-table-status', schema, like };
    }
    if (p.takeWord('collation')) { p.done(); return { kind: 'show-collation' }; }
    if (p.takeWord('charset') || p.word('character')) {
      p.takeWord('character');
      p.takeWord('set');
      p.done();
      return { kind: 'show-charset' };
    }
    if (p.takeWord('tables')) {
      let schema = null;
      if (p.takeWord('from') || p.takeWord('in')) schema = parseIdent(p);
      let like = null;
      if (p.takeWord('like')) like = String(parseLiteral(p));
      p.done();
      return { kind: 'show-tables', schema, like, full };
    }
    if (p.takeWord('columns') || p.takeWord('fields')) {
      p.expectWord('from');
      const name = parseQualified(p);
      if (p.takeWord('from') || p.takeWord('in')) name.schema = parseIdent(p);
      p.done();
      return { kind: 'show-columns', ...name, full };
    }
    if (p.takeWord('create')) {
      p.expectWord('table');
      const name = parseQualified(p);
      p.done();
      return { kind: 'show-create', ...name };
    }
    if (p.takeWord('variables') || p.takeWord('status')) {
      const which = p.tokens[p.i - 1].v.toLowerCase();
      let like = null;
      if (p.takeWord('like')) like = String(parseLiteral(p));
      p.done();
      return { kind: which === 'status' ? 'show-status' : 'show-variables', like };
    }
    if (p.takeWord('warnings')) { p.done(); return { kind: 'show-warnings' }; }
    throw sqlError(1064, 'unsupported SHOW');
  }

  if (kind === 'describe' || kind === 'desc') {
    p.eat();
    const name = parseQualified(p);
    p.done();
    return { kind: 'show-columns', ...name, full: false };
  }

  if (kind === 'create') {
    p.eat();
    if (p.takeWord('database') || p.takeWord('schema')) {
      let ifNotExists = false;
      if (p.takeWord('if')) { p.expectWord('not'); p.expectWord('exists'); ifNotExists = true; }
      const name = parseIdent(p);
      p.done();
      return { kind: 'create-database', name, ifNotExists };
    }
    p.expectWord('table');
    let ifNotExists = false;
    if (p.takeWord('if')) { p.expectWord('not'); p.expectWord('exists'); ifNotExists = true; }
    const name = parseIdent(p);
    p.expectOp('(');
    const columns = [];
    let tablePk = null;
    while (!p.takeOp(')')) {
      if (p.word('primary')) {
        p.expectWord('primary');
        p.expectWord('key');
        p.expectOp('(');
        tablePk = parseIdent(p);
        p.expectOp(')');
      } else {
        const col = { name: parseIdent(p), type: parseType(p), primary: false };
        parseColumnRest(p, col);
        columns.push(col);
      }
      if (!p.op(')')) p.expectOp(',');
    }
    p.done();
    return { kind: 'create-table', name, ifNotExists, columns, tablePk };
  }

  if (kind === 'drop') {
    p.eat();
    if (p.takeWord('database') || p.takeWord('schema')) {
      const ifExists = p.takeWord('if') && (p.expectWord('exists'), true);
      const name = parseIdent(p);
      p.done();
      return { kind: 'drop-database', name, ifExists };
    }
    p.expectWord('table');
    const ifExists = p.takeWord('if') && (p.expectWord('exists'), true);
    const name = parseIdent(p);
    p.done();
    return { kind: 'drop-table', name, ifExists };
  }

  if (kind === 'insert' || kind === 'replace') {
    const replace = kind === 'replace';
    p.eat();
    if (!replace) p.takeWord('ignore');
    p.expectWord('into');
    const name = parseQualified(p);
    let cols = null;
    if (p.takeOp('(')) {
      cols = [];
      do { cols.push(parseIdent(p)); } while (p.takeOp(','));
      p.expectOp(')');
    }
    if (p.takeWord('set')) {
      const set = [];
      do {
        const col = parseIdent(p);
        p.expectOp('=');
        set.push({ col, value: parseLiteral(p) });
      } while (p.takeOp(','));
      p.done();
      return { kind: 'insert', replace, ...name, set };
    }
    p.expectWord('values');
    const tuples = [];
    do {
      p.expectOp('(');
      const vals = [];
      if (!p.op(')')) do { vals.push(parseLiteral(p)); } while (p.takeOp(','));
      p.expectOp(')');
      tuples.push(vals);
    } while (p.takeOp(','));
    if (p.word('on')) throw sqlError(1235, 'ON DUPLICATE KEY UPDATE is not supported; use REPLACE');
    p.done();
    return { kind: 'insert', replace, ...name, cols, tuples };
  }

  if (kind === 'update') {
    p.eat();
    const name = parseQualified(p);
    p.expectWord('set');
    const set = [];
    do {
      let col = parseIdent(p);
      if (p.takeOp('.')) col = parseIdent(p);
      p.expectOp('=');
      set.push({ col, value: parseLiteral(p) });
    } while (p.takeOp(','));
    const where = parseWhere(p);
    const { order, limit, offset } = parseOrderLimit(p);
    p.done();
    return { kind: 'update', ...name, set, where, order, limit, offset };
  }

  if (kind === 'delete') {
    p.eat();
    p.expectWord('from');
    const name = parseQualified(p);
    const where = parseWhere(p);
    const { order, limit, offset } = parseOrderLimit(p);
    p.done();
    return { kind: 'delete', ...name, where, order, limit, offset };
  }

  if (kind === 'select') {
    p.eat();
    const cols = parseSelectList(p);
    let from = null;
    if (p.takeWord('from')) from = parseQualified(p);
    if (p.word('join') || p.word('left') || p.word('right') || p.word('inner') || p.word('cross') || p.word('straight_join')) {
      throw sqlError(1235, 'JOIN is not supported');
    }
    const where = parseWhere(p);
    if (p.word('group')) throw sqlError(1235, 'GROUP BY is not supported');
    const { order, limit, offset } = parseOrderLimit(p);
    p.done();
    return { kind: 'select', cols, from, where, order, limit, offset };
  }

  throw sqlError(1064, `unsupported statement ${first.v}`);
}

function ok(affectedRows = 0) {
  return { kind: 'ok', affectedRows, insertId: 0 };
}
function result(columns, rows) {
  return { kind: 'rows', columns, rows };
}
function col(name, type, primary = false) {
  return { name, type, primary };
}

function mapStoreError(e) {
  if (!e || !e.code) return e;
  if (e.code === 'exists' && e.message === 'row already exists') return sqlError(1062, e.message, '23000');
  if (e.code === 'exists') return sqlError(1050, e.message, '42S01');
  if (e.code === 'not_found') return sqlError(1146, e.message, '42S02');
  if (e.code === 'bad_row' && /too large/.test(e.message)) return sqlError(1406, e.message, '22001');
  if (e.code === 'quota') return sqlError(1114, e.message, 'HY000');
  return sqlError(1105, e.message, 'HY000');
}

async function storeCall(fn) {
  try { return await fn(); } catch (e) { throw e.errno ? e : mapStoreError(e); }
}

function requireDb(session) {
  if (!session.database) throw sqlError(1046, 'no database selected', '3D000');
  return session.database;
}

const VIRTUAL = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

async function useDatabase(dataStore, session, name) {
  if (name === 'information_schema') { session.database = name; return ok(); }
  if (VIRTUAL.has(name)) throw sqlError(1044, `access denied for database ${name}`, '42000');
  const db = await storeCall(() => dataStore.getDatabase(session.ownerId, name));
  if (!db) throw sqlError(1049, `unknown database ${name}`, '42000');
  session.database = name;
  return ok();
}

function dirty(session) {
  if (!session.overlay) return false;
  for (const rows of session.overlay.values()) if (rows.size) return true;
  return false;
}

async function commitSession(dataStore, session) {
  const overlay = session.overlay;
  session.overlay = null;
  session.explicitTx = false;
  if (!overlay || ![...overlay.values()].some((m) => m.size)) return ok();
  const db = requireDb(session);
  await storeCall(() => dataStore.transact(session.ownerId, db, async (tx) => {
    for (const [table, rows] of overlay) {
      for (const [pk, row] of rows) {
        if (row == null) await tx.deleteRow(table, pk);
        else await tx.putRow(table, pk, row.values);
      }
    }
  }));
  return ok();
}

function rollbackSession(session) {
  session.overlay = null;
  session.explicitTx = false;
  return ok();
}

function inTx(session) {
  return !!session.overlay;
}

function ensureTx(session) {
  if (!session.autocommit || session.explicitTx) {
    if (!session.overlay) session.overlay = new Map();
    return true;
  }
  return false;
}

function overlayTable(session, table) {
  if (!session.overlay.has(table)) session.overlay.set(table, new Map());
  return session.overlay.get(table);
}

async function loadSchema(dataStore, session, name) {
  const db = requireDb(session);
  const table = await storeCall(() => dataStore.getTable(session.ownerId, db, name));
  if (!table) throw sqlError(1146, `table ${name} does not exist`, '42S02');
  return table;
}

async function readRow(dataStore, session, table, pk) {
  if (session.overlay && session.overlay.has(table) && session.overlay.get(table).has(pk)) {
    return session.overlay.get(table).get(pk);
  }
  return storeCall(() => dataStore.getRow(session.ownerId, session.database, table, pk));
}

async function scanTable(dataStore, session, table) {
  const rows = await storeCall(() => dataStore.listAll(session.ownerId, session.database, table));
  const map = new Map(rows.map((r) => [r.pk, r]));
  const over = session.overlay && session.overlay.get(table);
  if (over) {
    for (const [pk, row] of over) {
      if (row == null) map.delete(pk);
      else map.set(pk, row);
    }
  }
  return [...map.values()].sort((a, b) => cmpPk(a.pk, b.pk));
}

function coerce(column, value) {
  if (value == null) return null;
  if (column.type === 'string') {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    throw sqlError(1366, `${column.name} must be a string`, '22000');
  }
  if (column.type === 'int') {
    const n = typeof value === 'number' ? value : (typeof value === 'boolean' ? (value ? 1 : 0) : (/^-?\d+$/.test(String(value)) ? Number(value) : NaN));
    if (!Number.isSafeInteger(n)) throw sqlError(1366, `${column.name} must be an integer`, '22000');
    return n;
  }
  if (column.type === 'bool') {
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
    throw sqlError(1366, `${column.name} must be true or false`, '22000');
  }
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { throw sqlError(1366, `${column.name} must be JSON`, '22000'); }
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  throw sqlError(1366, `${column.name} must be JSON`, '22000');
}

function valuesFrom(columns, cols, vals) {
  const names = cols || columns.map((c) => c.name);
  if (names.length !== vals.length) throw sqlError(1136, 'column count does not match value count', '21S01');
  const out = {};
  for (const c of columns) out[c.name] = null;
  for (let i = 0; i < names.length; i++) {
    const column = columns.find((c) => c.name === names[i]);
    if (!column) throw sqlError(1054, `unknown column ${names[i]}`, '42S22');
    out[column.name] = coerce(column, vals[i]);
  }
  return out;
}

function primaryOf(columns) {
  return columns.find((c) => c.primary);
}

async function writeRow(dataStore, session, table, values, { replace }) {
  const pkCol = primaryOf(table.columns);
  const pk = values[pkCol.name];
  if (typeof pk !== 'string' || pk.length === 0) throw sqlError(1364, `primary key ${pkCol.name} is required`, 'HY000');
  const row = { pk, values: { ...values, [pkCol.name]: pk } };
  if (inTx(session) || ensureTx(session)) {
    const cur = await readRow(dataStore, session, table.name, pk);
    if (cur && !replace) throw sqlError(1062, `duplicate primary key ${pk}`, '23000');
    overlayTable(session, table.name).set(pk, row);
    return;
  }
  await storeCall(() => dataStore.transact(session.ownerId, session.database, async (tx) => {
    if (replace) await tx.putRow(table.name, pk, row.values);
    else await tx.insertRow(table.name, pk, row.values);
  }));
}

function likeToRegExp(pattern) {
  let src = '^';
  for (const ch of pattern) {
    if (ch === '%') src += '.*';
    else if (ch === '_') src += '.';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(src + '$', 'i');
}

function cmpTyped(column, left, op, rawRight) {
  let right;
  try { right = coerce(column, rawRight); } catch { return op === '!='; }
  if (left == null || right == null) return false;
  let n = 0;
  if (column.type === 'int' || column.type === 'bool') {
    const a = left === true ? 1 : left === false ? 0 : left;
    const b = right === true ? 1 : right === false ? 0 : right;
    n = a === b ? 0 : a < b ? -1 : 1;
  } else if (column.type === 'string') n = cmpPk(String(left), String(right));
  else n = cmpPk(JSON.stringify(left), JSON.stringify(right));
  if (op === '=') return n === 0;
  if (op === '!=') return n !== 0;
  if (op === '<') return n < 0;
  if (op === '>') return n > 0;
  if (op === '<=') return n <= 0;
  if (op === '>=') return n >= 0;
  return false;
}

function rowMatches(columns, row, where) {
  if (!where) return true;
  for (const term of where) {
    if (Object.prototype.hasOwnProperty.call(term, 'constant')) {
      if (term.constant === 0 || term.constant === false || term.constant == null) return false;
      continue;
    }
    if (term.constantCmp) {
      if (!cmpTyped({ name: '_', type: typeof term.left === 'number' ? 'int' : 'string' }, term.left, term.op, term.right)) return false;
      continue;
    }
    const column = columns.find((c) => c.name.toLowerCase() === term.col.toLowerCase());
    if (!column) throw sqlError(1054, `unknown column ${term.col}`, '42S22');
    const value = row.values[column.name];
    if (term.op === 'is') { if (value != null) return false; continue; }
    if (term.op === 'is not') { if (value == null) return false; continue; }
    if (!cmpTyped(column, value, term.op, term.value)) return false;
  }
  return true;
}

function sortRows(columns, rows, order) {
  if (!order) return rows;
  const column = columns.find((c) => c.name.toLowerCase() === order.col.toLowerCase());
  if (!column) throw sqlError(1054, `unknown column ${order.col}`, '42S22');
  const signed = order.desc ? -1 : 1;
  return [...rows].sort((a, b) => signed * (cmpTyped(column, a.values[column.name], '<', b.values[column.name]) ? -1 : cmpTyped(column, a.values[column.name], '>', b.values[column.name]) ? 1 : 0));
}

function sliceLimit(rows, limit, offset) {
  const start = offset || 0;
  if (limit == null) return rows.slice(start);
  return rows.slice(start, start + limit);
}

function project(columns, rows, selectCols) {
  if (!selectCols || selectCols.some((c) => c.star)) {
    return { columns, rows: rows.map((r) => columns.map((c) => cell(c, r.values[c.name]))) };
  }
  const outCols = selectCols.map((spec, i) => {
    if (spec.literal !== undefined) return col(spec.as || `_${i}`, typeof spec.literal === 'number' ? 'int' : 'string');
    if (spec.fn || spec.sys) return col(spec.as || (spec.fn || spec.sys), 'string');
    const column = columns.find((c) => c.name.toLowerCase() === spec.col.toLowerCase());
    if (!column) throw sqlError(1054, `unknown column ${spec.col}`, '42S22');
    return { ...column, name: spec.as || column.name };
  });
  const outRows = rows.map((r) => selectCols.map((spec) => {
    if (spec.literal !== undefined) return spec.literal;
    if (spec.fn || spec.sys) return null;
    const column = columns.find((c) => c.name.toLowerCase() === spec.col.toLowerCase());
    return cell(column, r.values[column.name]);
  }));
  return { columns: outCols, rows: outRows };
}

function cell(column, value) {
  if (value == null) return null;
  if (column.type === 'bool') return value ? 1 : 0;
  if (column.type === 'json') return JSON.stringify(value);
  return value;
}

function variables(session) {
  return [
    ['version', SERVER_VERSION],
    ['version_comment', 'Funx'],
    ['version_compile_os', 'linux'],
    ['character_set_server', 'utf8mb4'],
    ['character_set_client', 'utf8mb4'],
    ['character_set_connection', 'utf8mb4'],
    ['character_set_results', 'utf8mb4'],
    ['collation_server', 'utf8mb4_general_ci'],
    ['max_allowed_packet', '16777216'],
    ['autocommit', session.autocommit ? '1' : '0'],
    ['transaction_isolation', 'READ-COMMITTED'],
    ['tx_isolation', 'READ-COMMITTED'],
    ['sql_mode', 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'],
    ['system_time_zone', '+00:00'],
    ['time_zone', '+00:00'],
    ['lower_case_table_names', '1'],
  ];
}

function sysValue(session, name) {
  const key = name.split('.').pop();
  const hit = variables(session).find((v) => v[0] === key);
  if (key === 'version_comment') return 'Funx';
  return hit ? hit[1] : null;
}

function fnValue(session, name) {
  const n = name.toLowerCase();
  if (n === 'database' || n === 'schema') return session.database;
  if (n === 'user' || n === 'current_user' || n === 'session_user') return `${session.username}@%`;
  if (n === 'version') return SERVER_VERSION;
  if (n === 'connection_id') return session.connectionId || 0;
  throw sqlError(1235, `function ${name} is not supported`);
}

async function infoRows(dataStore, session, tableName) {
  const name = tableName.toLowerCase();
  const dbs = await storeCall(() => dataStore.listDatabases(session.ownerId));
  if (name === 'schemata') {
    return {
      columns: [col('SCHEMA_NAME', 'string'), col('CATALOG_NAME', 'string'), col('DEFAULT_CHARACTER_SET_NAME', 'string')],
      records: dbs.map((d) => ({ values: { SCHEMA_NAME: d.name, CATALOG_NAME: 'def', DEFAULT_CHARACTER_SET_NAME: 'utf8mb4' } })),
    };
  }
  const owned = [];
  for (const d of dbs) {
    const tables = await storeCall(() => dataStore.listTables(session.ownerId, d.name));
    for (const t of tables) owned.push({ db: d.name, table: t });
  }
  if (name === 'tables') {
    return {
      columns: [col('TABLE_SCHEMA', 'string'), col('TABLE_NAME', 'string'), col('TABLE_TYPE', 'string'), col('ENGINE', 'string')],
      records: owned.map((t) => ({ values: { TABLE_SCHEMA: t.db, TABLE_NAME: t.table.name, TABLE_TYPE: 'BASE TABLE', ENGINE: 'Funx' } })),
    };
  }
  if (name === 'columns') {
    const records = [];
    for (const t of owned) {
      t.table.columns.forEach((c, i) => {
        records.push({ values: {
          TABLE_SCHEMA: t.db,
          TABLE_NAME: t.table.name,
          COLUMN_NAME: c.name,
          ORDINAL_POSITION: i + 1,
          DATA_TYPE: c.type === 'bool' ? 'tinyint' : c.type === 'int' ? 'bigint' : c.type,
          COLUMN_TYPE: c.type === 'string' ? 'varchar(255)' : c.type === 'int' ? 'bigint' : c.type === 'bool' ? 'tinyint(1)' : 'json',
          COLUMN_KEY: c.primary ? 'PRI' : '',
          IS_NULLABLE: c.primary ? 'NO' : 'YES',
        } });
      });
    }
    return {
      columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'DATA_TYPE', 'COLUMN_TYPE', 'COLUMN_KEY', 'IS_NULLABLE']
        .map((n) => col(n, n === 'ORDINAL_POSITION' ? 'int' : 'string')),
      records,
    };
  }
  if (name === 'statistics') {
    return { columns: [col('TABLE_SCHEMA', 'string'), col('TABLE_NAME', 'string'), col('INDEX_NAME', 'string')], records: [] };
  }
  throw sqlError(1146, `table information_schema.${tableName} does not exist`, '42S02');
}

function selectVirtual(columns, records, stmt) {
  let rows = records.filter((r) => rowMatches(columns, r, stmt.where));
  rows = sortRows(columns, rows, stmt.order);
  rows = sliceLimit(rows, stmt.limit, stmt.offset);
  if (!stmt.cols || stmt.cols.some((c) => c.star && !c.fn && !c.sys && c.literal === undefined && !c.col)) {
    const projected = project(columns, rows, stmt.cols && stmt.cols.some((c) => c.star) ? null : stmt.cols);
    return result(projected.columns, projected.rows);
  }
  const projected = project(columns, rows, stmt.cols.map((spec) => {
    if (spec.fn) return { ...spec, literal: fnValue({ database: null, username: '' }, spec.fn) };
    return spec;
  }));
  return result(projected.columns, projected.rows);
}

async function runSelect(dataStore, session, stmt) {
  if (!stmt.from) {
    const columns = [];
    const values = [];
    for (const spec of stmt.cols) {
      if (spec.star) throw sqlError(1064, 'SELECT * needs a table');
      if (spec.fn) { columns.push(col(spec.as || `${spec.fn}()`, 'string')); values.push(fnValue(session, spec.fn)); }
      else if (spec.sys) { columns.push(col(spec.as || `@@${spec.sys}`, 'string')); values.push(sysValue(session, spec.sys)); }
      else if (spec.literal !== undefined) {
        columns.push(col(spec.as || 'value', typeof spec.literal === 'number' ? 'int' : 'string'));
        values.push(spec.literal);
      } else throw sqlError(1054, `unknown column ${spec.col}`, '42S22');
    }
    const rows = sliceLimit([{ values: {} }], stmt.limit, stmt.offset);
    return result(columns, rows.length ? [values] : []);
  }
  const schema = stmt.from.schema || session.database;
  if (schema === 'information_schema') {
    const info = await infoRows(dataStore, session, stmt.from.name);
    let rows = info.records.filter((r) => rowMatches(info.columns, r, stmt.where));
    rows = sortRows(info.columns, rows, stmt.order);
    rows = sliceLimit(rows, stmt.limit, stmt.offset);
    const projected = project(info.columns, rows, stmt.cols);
    // Fill function/sys cells that project left null.
    projected.rows = projected.rows.map((row) => row.map((value, i) => {
      const spec = stmt.cols[i];
      if (!spec || spec.star) return value;
      if (spec.fn) return fnValue(session, spec.fn);
      if (spec.sys) return sysValue(session, spec.sys);
      return value;
    }));
    if (stmt.cols.some((c) => c.star)) return result(projected.columns, rows.map((r) => info.columns.map((c) => cell(c, r.values[c.name]))));
    return result(projected.columns, projected.rows);
  }
  if (!schema) throw sqlError(1046, 'no database selected', '3D000');
  if (schema !== session.database) {
    const saved = session.database;
    session.database = schema;
    try { return await runSelect(dataStore, session, { ...stmt, from: { schema: null, name: stmt.from.name } }); }
    finally { session.database = saved; }
  }
  const table = await loadSchema(dataStore, session, stmt.from.name);
  let rows = (await scanTable(dataStore, session, table.name)).filter((r) => rowMatches(table.columns, r, stmt.where));
  rows = sortRows(table.columns, rows, stmt.order);
  rows = sliceLimit(rows, stmt.limit, stmt.offset);
  if (stmt.cols.some((c) => c.star)) {
    return result(table.columns, rows.map((r) => table.columns.map((c) => cell(c, r.values[c.name]))));
  }
  const projected = project(table.columns, rows, stmt.cols);
  projected.rows = projected.rows.map((row) => row.map((value, i) => {
    const spec = stmt.cols[i];
    if (spec.fn) return fnValue(session, spec.fn);
    if (spec.sys) return sysValue(session, spec.sys);
    return value;
  }));
  return result(projected.columns, projected.rows);
}

function columnTypeSql(c) {
  if (c.type === 'string') return 'varchar(255)';
  if (c.type === 'int') return 'bigint';
  if (c.type === 'bool') return 'tinyint(1)';
  return 'json';
}

async function run(dataStore, session, stmt) {
  if (stmt.kind === 'set') {
    for (const a of stmt.assigns) {
      const key = String(a.name).split('.').pop();
      if (key === 'autocommit') {
        const on = a.value === 1 || a.value === true || a.value === '1' || a.value === 'on';
        if (on && dirty(session)) await commitSession(dataStore, session);
        session.autocommit = !!on;
        if (on) { session.overlay = null; session.explicitTx = false; }
      }
    }
    return ok();
  }
  if (stmt.kind === 'begin') {
    if (dirty(session)) await commitSession(dataStore, session);
    session.overlay = new Map();
    session.explicitTx = true;
    return ok();
  }
  if (stmt.kind === 'commit') return commitSession(dataStore, session);
  if (stmt.kind === 'rollback') return rollbackSession(session);
  if (stmt.kind === 'use') {
    if (dirty(session)) throw sqlError(1046, 'commit or rollback before changing database', '3D000');
    session.overlay = null;
    return useDatabase(dataStore, session, stmt.name);
  }
  if (stmt.kind === 'create-database' || stmt.kind === 'drop-database' || stmt.kind === 'create-table' || stmt.kind === 'drop-table') {
    if (dirty(session)) await commitSession(dataStore, session);
    else { session.overlay = null; session.explicitTx = false; }
  }

  if (stmt.kind === 'create-database') {
    if (VIRTUAL.has(stmt.name)) throw sqlError(1044, `access denied for database ${stmt.name}`, '42000');
    try {
      await storeCall(() => dataStore.createDatabase({ ownerId: session.ownerId, name: stmt.name }));
    } catch (e) {
      if (stmt.ifNotExists && e.errno === 1050) return ok();
      if (e.errno === 1050) throw sqlError(1007, `database ${stmt.name} already exists`, 'HY000');
      throw e;
    }
    return ok();
  }
  if (stmt.kind === 'drop-database') {
    if (stmt.name === session.database) session.database = null;
    try {
      await storeCall(() => dataStore.deleteDatabase(session.ownerId, stmt.name));
    } catch (e) {
      if (stmt.ifExists && (e.errno === 1146 || e.errno === 1049 || e.code === 'not_found')) return ok();
      if (e.errno === 1146) throw sqlError(1008, `database ${stmt.name} does not exist`, 'HY000');
      throw e;
    }
    return ok();
  }
  if (stmt.kind === 'show-databases') {
    const dbs = await storeCall(() => dataStore.listDatabases(session.ownerId));
    const re = stmt.like ? likeToRegExp(stmt.like) : null;
    const names = dbs.map((d) => d.name).concat(['information_schema']).filter((n) => !re || re.test(n)).sort();
    return result([col('Database', 'string')], names.map((n) => [n]));
  }
  if (stmt.kind === 'show-collation') {
    return result(
      ['Collation', 'Charset', 'Id', 'Default', 'Compiled', 'Sortlen'].map((n) => col(n, n === 'Id' || n === 'Sortlen' ? 'int' : 'string')),
      [['utf8mb4_general_ci', 'utf8mb4', 45, 'Yes', 'Yes', 1]],
    );
  }
  if (stmt.kind === 'show-charset') {
    return result(
      ['Charset', 'Description', 'Default collation', 'Maxlen'].map((n, i) => col(n, i === 3 ? 'int' : 'string')),
      [['utf8mb4', 'UTF-8 Unicode', 'utf8mb4_general_ci', 4]],
    );
  }
  if (stmt.kind === 'show-table-status') {
    const db = stmt.schema || requireDb(session);
    const headers = ['Name', 'Engine', 'Version', 'Row_format', 'Rows', 'Avg_row_length', 'Data_length', 'Max_data_length', 'Index_length', 'Data_free', 'Auto_increment', 'Create_time', 'Update_time', 'Check_time', 'Collation', 'Checksum', 'Create_options', 'Comment'];
    const line = (n) => [n, 'Funx', null, 'Dynamic', null, null, null, null, null, null, null, null, null, null, 'utf8mb4_general_ci', null, '', ''];
    if (db === 'information_schema') {
      return result(headers.map((n) => col(n, 'string')), ['schemata', 'tables', 'columns'].map(line));
    }
    const saved = session.database;
    session.database = db;
    let tables;
    try { tables = await storeCall(() => dataStore.listTables(session.ownerId, db)); }
    finally { session.database = saved; }
    const re = stmt.like ? likeToRegExp(stmt.like) : null;
    const names = tables.map((t) => t.name).filter((n) => !re || re.test(n));
    return result(headers.map((n) => col(n, 'string')), names.map(line));
  }
  if (stmt.kind === 'show-variables' || stmt.kind === 'show-status') {
    const re = stmt.like ? likeToRegExp(stmt.like) : null;
    const list = stmt.kind === 'show-status' ? [] : variables(session).filter((v) => !re || re.test(v[0]));
    return result([col('Variable_name', 'string'), col('Value', 'string')], list.map((v) => v));
  }
  if (stmt.kind === 'show-warnings') return result([col('Level', 'string'), col('Code', 'int'), col('Message', 'string')], []);

  if (stmt.kind === 'show-tables') {
    const db = stmt.schema || requireDb(session);
    if (db === 'information_schema') {
      return result([col(`Tables_in_${db}`, 'string')], [['schemata'], ['tables'], ['columns']]);
    }
    const saved = session.database;
    session.database = db;
    let tables;
    try { tables = await storeCall(() => dataStore.listTables(session.ownerId, db)); }
    finally { session.database = saved; }
    const re = stmt.like ? likeToRegExp(stmt.like) : null;
    const names = tables.map((t) => t.name).filter((n) => !re || re.test(n));
    if (stmt.full) return result([col(`Tables_in_${db}`, 'string'), col('Table_type', 'string')], names.map((n) => [n, 'BASE TABLE']));
    return result([col(`Tables_in_${db}`, 'string')], names.map((n) => [n]));
  }

  if (stmt.kind === 'show-columns' || stmt.kind === 'show-create') {
    const saved = session.database;
    if (stmt.schema) session.database = stmt.schema;
    try {
      const table = await loadSchema(dataStore, session, stmt.name);
      if (stmt.kind === 'show-create') {
        const body = table.columns.map((c) => `  \`${c.name}\` ${columnTypeSql(c)}${c.primary ? ' NOT NULL PRIMARY KEY' : ''}`).join(',\n');
        return result([col('Table', 'string'), col('Create Table', 'string')], [[table.name, `CREATE TABLE \`${table.name}\` (\n${body}\n)`]]);
      }
      const rows = table.columns.map((c) => stmt.full
        ? [c.name, columnTypeSql(c), 'utf8mb4_general_ci', c.primary ? 'NO' : 'YES', c.primary ? 'PRI' : '', null, '', '']
        : [c.name, columnTypeSql(c), c.primary ? 'NO' : 'YES', c.primary ? 'PRI' : '', null, '']);
      const columns = stmt.full
        ? ['Field', 'Type', 'Collation', 'Null', 'Key', 'Default', 'Extra', 'Comment'].map((n) => col(n, 'string'))
        : ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'].map((n) => col(n, 'string'));
      return result(columns, rows);
    } finally { session.database = saved; }
  }

  if (stmt.kind === 'create-table') {
    const db = requireDb(session);
    if (stmt.tablePk) {
      const hit = stmt.columns.find((c) => c.name === stmt.tablePk);
      if (!hit) throw sqlError(1072, `primary key ${stmt.tablePk} is not a column`, '42000');
      hit.primary = true;
    }
    const prim = stmt.columns.filter((c) => c.primary);
    if (prim.length !== 1) throw sqlError(1064, 'a table needs exactly one primary key');
    if (prim[0].type !== 'string') throw sqlError(1235, 'the primary key must be a string (VARCHAR, CHAR, or TEXT)');
    try {
      await storeCall(() => dataStore.createTable(session.ownerId, db, {
        name: stmt.name,
        columns: stmt.columns.map((c) => ({ name: c.name, type: c.type, primary: c.primary })),
      }));
    } catch (e) {
      if (stmt.ifNotExists && e.errno === 1050) return ok();
      throw e;
    }
    return ok();
  }
  if (stmt.kind === 'drop-table') {
    const db = requireDb(session);
    try { await storeCall(() => dataStore.deleteTable(session.ownerId, db, stmt.name)); }
    catch (e) {
      if (stmt.ifExists && e.errno === 1146) return ok();
      throw e;
    }
    return ok();
  }

  if (stmt.kind === 'insert') {
    if (stmt.schema && stmt.schema !== session.database) throw sqlError(1049, `unknown database ${stmt.schema}`, '42000');
    const table = await loadSchema(dataStore, session, stmt.name);
    const tuples = stmt.set
      ? [stmt.set.map((s) => s.value)]
      : stmt.tuples;
    const cols = stmt.set ? stmt.set.map((s) => s.col) : stmt.cols;
    let n = 0;
    for (const vals of tuples) {
      const values = valuesFrom(table.columns, cols, vals);
      await writeRow(dataStore, session, table, values, { replace: stmt.replace });
      n++;
    }
    return ok(n);
  }

  if (stmt.kind === 'update' || stmt.kind === 'delete') {
    if (stmt.schema && stmt.schema !== session.database) throw sqlError(1049, `unknown database ${stmt.schema}`, '42000');
    const table = await loadSchema(dataStore, session, stmt.name);
    let rows = (await scanTable(dataStore, session, table.name)).filter((r) => rowMatches(table.columns, r, stmt.where));
    rows = sortRows(table.columns, rows, stmt.order);
    rows = sliceLimit(rows, stmt.limit, stmt.offset);
    const tx = ensureTx(session);
    const apply = async (fn) => {
      if (tx) { await fn({ putRow: async (t, pk, values) => { overlayTable(session, t).set(pk, { pk, values }); }, deleteRow: async (t, pk) => { overlayTable(session, t).set(pk, null); } }); return; }
      await storeCall(() => dataStore.transact(session.ownerId, session.database, fn));
    };
    await apply(async (txc) => {
      for (const row of rows) {
        if (stmt.kind === 'delete') { await txc.deleteRow(table.name, row.pk); continue; }
        const values = { ...row.values };
        for (const set of stmt.set) {
          const column = table.columns.find((c) => c.name === set.col);
          if (!column) throw sqlError(1054, `unknown column ${set.col}`, '42S22');
          if (column.primary) throw sqlError(1235, 'changing the primary key is not supported');
          values[column.name] = coerce(column, set.value);
        }
        await txc.putRow(table.name, row.pk, values);
      }
    });
    return ok(rows.length);
  }

  if (stmt.kind === 'select') return runSelect(dataStore, session, stmt);
  throw sqlError(1064, 'unsupported statement');
}

async function forEachStatement(dataStore, session, sql, onResult) {
  const parts = splitStatements(String(sql));
  if (!parts.length) throw sqlError(1064, 'empty statement');
  for (let i = 0; i < parts.length; i++) {
    const result = await run(dataStore, session, parseStatement(parts[i]));
    await onResult(result, i < parts.length - 1);
  }
}

async function executeSql(dataStore, session, sql) {
  const out = [];
  await forEachStatement(dataStore, session, sql, async (result) => { out.push(result); });
  return out;
}

function newSession({ ownerId, username, database = null }) {
  return { ownerId, username, database, autocommit: true, explicitTx: false, overlay: null };
}

module.exports = { executeSql, forEachStatement, newSession, sqlError, SERVER_VERSION, splitStatements };
