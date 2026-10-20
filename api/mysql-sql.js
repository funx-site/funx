'use strict';
// SQL inside a database the account created.
// The database name is the project name. It is unique for that account and may
// match another account's project. CREATE DATABASE and DROP DATABASE are refused.
// Table statements run in the selected database. Rows stay in funx_udata.

const { cmpPk } = require('./data-store');

const SERVER_VERSION = '5.7.40-funx';
const SQL_MAX_BYTES = 4 * 1024 * 1024;
const AGG = new Set(['count', 'sum', 'min', 'max', 'avg']);
const RESERVED = new Set(`from where and or order group limit offset set values into table database
select insert update delete create drop show use primary key not null as by asc desc like join left
right inner on if exists replace start commit rollback begin transaction describe desc columns
databases tables variables status full schema character charset collate comment default unique index
constraint references check auto_increment ignore replace into distinct between in is cross outer
using having union all alter truncate rename column`.split(/\s+/));

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
    const dotNum = c === '.' && /[0-9]/.test(s[i + 1] || '');
    const negNum = c === '-' && (/[0-9]/.test(s[i + 1] || '') || (s[i + 1] === '.' && /[0-9]/.test(s[i + 2] || '')));
    if (dotNum || negNum || /[0-9]/.test(c)) {
      const m = /^-?(?:\d+\.\d+|\d+\.|\.\d+|\d+)/.exec(s.slice(i));
      if (!m) throw sqlError(1064, 'bad number');
      const raw = m[0];
      const n = Number(raw);
      if (!Number.isFinite(n)) throw sqlError(1064, 'bad number');
      push('num', n);
      i += raw.length;
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

function parseExpr(p) { return parseOr(p); }

function parseOr(p) {
  let left = parseAnd(p);
  while (p.takeWord('or')) left = { op: 'or', args: [left, parseAnd(p)] };
  return left;
}

function parseAnd(p) {
  let left = parseNot(p);
  while (p.takeWord('and')) left = { op: 'and', args: [left, parseNot(p)] };
  return left;
}

function parseNot(p) {
  if (p.takeWord('not')) return { op: 'not', args: [parseNot(p)] };
  return parsePred(p);
}

function parsePred(p) {
  if (p.takeWord('exists')) throw sqlError(1235, 'subqueries are not supported');
  const left = parseAdd(p);
  if (p.takeWord('is')) {
    const not = p.takeWord('not');
    p.expectWord('null');
    return { op: 'is', not, args: [left] };
  }
  if (p.takeWord('not')) {
    if (p.takeWord('like')) return { op: 'not', args: [{ op: 'like', args: [left, parseAdd(p)] }] };
    if (p.takeWord('in')) return { op: 'not', args: [{ op: 'in', args: [left, ...parseList(p)] }] };
    throw sqlError(1064, 'expected LIKE or IN');
  }
  if (p.takeWord('in')) return { op: 'in', args: [left, ...parseList(p)] };
  if (p.takeWord('like')) return { op: 'like', args: [left, parseAdd(p)] };
  if (p.takeWord('between')) {
    const a = parseAdd(p);
    p.expectWord('and');
    return { op: 'between', args: [left, a, parseAdd(p)] };
  }
  const opTok = p.peek();
  if (opTok && opTok.t === 'op' && ['=', '!=', '<>', '<', '>', '<=', '>='].includes(opTok.v)) {
    p.eat();
    return { op: 'cmp', cmp: opTok.v === '<>' ? '!=' : opTok.v, args: [left, parseAdd(p)] };
  }
  return left;
}

function parseList(p) {
  p.expectOp('(');
  if (p.word('select')) throw sqlError(1235, 'subqueries are not supported');
  const list = [];
  if (!p.op(')')) {
    do { list.push(parseExpr(p)); } while (p.takeOp(','));
  }
  p.expectOp(')');
  return list;
}

function parseAdd(p) {
  let left = parseMul(p);
  while (p.peek() && p.peek().t === 'op' && (p.peek().v === '+' || p.peek().v === '-')) {
    const op = p.eat().v;
    left = { op, args: [left, parseMul(p)] };
  }
  return left;
}

function parseMul(p) {
  let left = parseUnary(p);
  while (p.peek() && p.peek().t === 'op' && (p.peek().v === '*' || p.peek().v === '/')) {
    const op = p.eat().v;
    left = { op, args: [left, parseUnary(p)] };
  }
  return left;
}

function parseUnary(p) {
  if (p.takeOp('-')) return { op: 'neg', args: [parseUnary(p)] };
  if (p.takeOp('+')) return parseUnary(p);
  return parsePrimary(p);
}

function parsePrimary(p) {
  if (p.takeOp('(')) {
    if (p.word('select')) throw sqlError(1235, 'subqueries are not supported');
    const e = parseExpr(p);
    p.expectOp(')');
    return e;
  }
  if (p.takeOp('?')) return { param: true };
  const t = p.peek();
  if (!t) throw sqlError(1064, 'expected an expression');
  if (t.t === 'str' || t.t === 'num') { p.eat(); return { lit: t.v }; }
  if (t.t === 'sys') { p.eat(); return { sys: t.v }; }
  if (t.t === 'word' || t.t === 'id') {
    const lower = t.t === 'word' ? t.v.toLowerCase() : null;
    if (lower === 'null') { p.eat(); return { lit: null }; }
    if (lower === 'true') { p.eat(); return { lit: true }; }
    if (lower === 'false') { p.eat(); return { lit: false }; }
    if (lower === 'default') { p.eat(); return { def: true }; }
    const next = p.tokens[p.i + 1];
    if (t.t === 'word' && next && next.t === 'op' && next.v === '(') {
      const name = foldName(p.eat().v);
      p.expectOp('(');
      const args = [];
      let star = false;
      p.takeWord('distinct');
      if (!p.takeOp(')')) {
        if (p.takeOp('*')) star = true;
        else {
          do { args.push(parseExpr(p)); } while (p.takeOp(','));
        }
        p.expectOp(')');
      }
      return { fn: name, args, star };
    }
    const name = parseIdent(p, t.t === 'id');
    if (p.takeOp('.')) {
      if (p.takeOp('*')) return { star: true, table: name };
      const col = parseIdent(p, true);
      return { col, table: name };
    }
    return { col: name };
  }
  throw sqlError(1064, `expected an expression near ${t.v}`);
}

function parseType(p) {
  const t = p.peek();
  if (!t || t.t !== 'word') throw sqlError(1064, 'expected a column type');
  p.eat();
  const n = t.v.toLowerCase();
  let mysqlType = n;
  if (p.takeOp('(')) {
    const num = p.peek();
    if (!num || num.t !== 'num') throw sqlError(1064, 'expected a length');
    mysqlType += `(${num.v}`;
    p.eat();
    if (p.takeOp(',')) {
      if (!p.peek() || p.peek().t !== 'num') throw sqlError(1064, 'expected a length');
      mysqlType += `,${p.peek().v}`;
      p.eat();
    }
    mysqlType += ')';
    p.expectOp(')');
  }
  if (n === 'double' || n === 'float' || n === 'real') p.takeWord('precision');
  const len = /^\w+\((\d+)/.exec(mysqlType);
  const length = len ? Number(len[1]) : null;
  let type = null;
  if (['varchar', 'char', 'text', 'tinytext', 'mediumtext', 'longtext'].includes(n)) type = 'string';
  else if ((n === 'tinyint' && length === 1) || n === 'bool' || n === 'boolean') type = 'bool';
  else if (['int', 'integer', 'bigint', 'smallint', 'mediumint', 'tinyint'].includes(n)) type = 'int';
  else if (['float', 'double', 'real'].includes(n)) type = 'float';
  else if (n === 'decimal' || n === 'numeric') type = 'decimal';
  else if (['datetime', 'timestamp', 'date', 'time'].includes(n)) type = 'datetime';
  else if (n === 'json') type = 'json';
  else if (['blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary'].includes(n)) type = 'blob';
  if (!type) throw sqlError(1235, `column type ${t.v} is not supported`);
  return { type, mysqlType };
}

function skipUntilComma(p) {
  let depth = 0;
  while (p.peek()) {
    if (p.op('(')) { depth++; p.eat(); continue; }
    if (p.op(')')) {
      if (depth === 0) return;
      depth--;
      p.eat();
      continue;
    }
    if (depth === 0 && p.op(',')) return;
    p.eat();
  }
}

function parseTimeFunc(p) {
  const w = p.peek();
  if (!w || w.t !== 'word') return false;
  const n = w.v.toLowerCase();
  if (n !== 'current_timestamp' && n !== 'now' && n !== 'current_date' && n !== 'curdate') return false;
  p.eat();
  if (p.takeOp('(')) p.expectOp(')');
  return true;
}

function parseColumnRest(p, col) {
  while (p.peek() && !p.op(',') && !p.op(')')) {
    if (p.takeWord('primary')) { p.expectWord('key'); col.primary = true; col.nullable = false; continue; }
    if (p.takeWord('not')) { p.expectWord('null'); col.nullable = false; continue; }
    if (p.takeWord('null')) { if (!col.primary) col.nullable = true; continue; }
    if (p.takeWord('default')) {
      if (parseTimeFunc(p)) col.default = 'current_timestamp';
      else if (p.takeWord('null')) col.default = null;
      else col.default = parseLiteral(p);
      continue;
    }
    if (p.takeWord('on')) {
      p.expectWord('update');
      parseTimeFunc(p);
      continue;
    }
    if (p.takeWord('comment')) { p.takeOp('='); parseLiteral(p); continue; }
    if (p.takeWord('collate')) { parseIdent(p, true); continue; }
    if (p.takeWord('character')) { p.expectWord('set'); parseIdent(p, true); continue; }
    if (p.takeWord('charset')) { parseIdent(p, true); continue; }
    if (p.takeWord('auto_increment')) { col.autoIncrement = true; col.nullable = false; continue; }
    if (p.takeWord('unsigned')) { col.unsigned = true; continue; }
    if (p.takeWord('zerofill')) continue;
    if (p.takeWord('unique')) { col.unique = true; p.takeWord('key'); continue; }
    if (p.word('first') || p.word('after')) return;
    if (p.takeWord('references')) { skipUntilComma(p); continue; }
    if (p.takeWord('check')) { skipUntilComma(p); continue; }
    const w = p.peek();
    throw sqlError(1064, `unexpected ${w ? w.v : 'end'} in a column`);
  }
}

function parseIndexCols(p) {
  p.expectOp('(');
  const columns = [];
  do {
    columns.push(parseIdent(p));
    p.takeWord('asc');
    p.takeWord('desc');
  } while (p.takeOp(','));
  p.expectOp(')');
  return columns;
}

function parseTableOptions(p) {
  while (p.peek()) {
    if (p.takeWord('engine') || p.takeWord('type')) { p.takeOp('='); parseIdent(p, true); continue; }
    if (p.takeWord('default')) {
      if (p.takeWord('character')) p.expectWord('set');
      else if (!p.takeWord('charset') && !p.takeWord('collate')) throw sqlError(1064, 'expected a table option');
      p.takeOp('=');
      parseIdent(p, true);
      continue;
    }
    if (p.takeWord('character')) { p.expectWord('set'); p.takeOp('='); parseIdent(p, true); continue; }
    if (p.takeWord('charset') || p.takeWord('collate')) { p.takeOp('='); parseIdent(p, true); continue; }
    if (p.takeWord('comment')) { p.takeOp('='); parseLiteral(p); continue; }
    if (p.takeWord('auto_increment') || p.takeWord('avg_row_length') || p.takeWord('key_block_size') || p.takeWord('max_rows') || p.takeWord('min_rows')) {
      p.takeOp('=');
      if (p.peek() && (p.peek().t === 'num' || p.peek().t === 'str')) p.eat();
      continue;
    }
    if (p.takeWord('row_format') || p.takeWord('pack_keys') || p.takeWord('stats_persistent') || p.takeWord('compression')) {
      p.takeOp('=');
      if (p.peek()) p.eat();
      continue;
    }
    throw sqlError(1064, `unexpected ${p.peek().v}`);
  }
}

function takeAlias(p) {
  if (p.takeWord('as')) return parseIdent(p, true);
  const t = p.peek();
  if (!t) return null;
  if (t.t === 'id') return parseIdent(p, true);
  if (t.t === 'word' && !RESERVED.has(t.v.toLowerCase())) return parseIdent(p);
  return null;
}

function parseTableRef(p) {
  const q = parseQualified(p);
  const alias = takeAlias(p) || q.name;
  return { schema: q.schema, name: q.name, alias };
}

function parseSelectList(p) {
  const cols = [];
  do {
    let expr;
    if (p.takeOp('*')) expr = { star: true };
    else expr = parseExpr(p);
    const as = takeAlias(p);
    if (as) expr = { ...expr, as };
    cols.push(expr);
  } while (p.takeOp(','));
  return cols;
}

function parseOrderLimit(p) {
  let order = null;
  if (p.takeWord('order')) {
    p.expectWord('by');
    order = [];
    do {
      const expr = parseExpr(p);
      const desc = p.takeWord('desc');
      if (!desc) p.takeWord('asc');
      order.push({ expr, desc });
    } while (p.takeOp(','));
  }
  let limit = null;
  let offset = { lit: 0 };
  if (p.takeWord('limit')) {
    const a = parseLimitNum(p);
    if (p.takeOp(',')) {
      offset = a;
      limit = parseLimitNum(p);
    } else {
      limit = a;
      if (p.takeWord('offset')) offset = parseLimitNum(p);
    }
  }
  return { order, limit, offset };
}

function parseLimitNum(p) {
  if (p.takeOp('?')) return { param: true };
  const a = p.peek();
  if (!a || a.t !== 'num' || a.v < 0) throw sqlError(1064, 'bad LIMIT');
  p.eat();
  return { lit: a.v };
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
    if (p.takeWord('index') || p.takeWord('indexes') || p.takeWord('keys')) {
      p.expectWord('from');
      const name = parseQualified(p);
      if (p.takeWord('from') || p.takeWord('in')) name.schema = parseIdent(p);
      p.done();
      return { kind: 'show-index', ...name };
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
    if (p.takeWord('warnings') || p.takeWord('errors')) { p.done(); return { kind: 'show-warnings' }; }
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
      while (p.peek()) {
        if (p.takeWord('default') || p.takeWord('character') || p.takeWord('charset') || p.takeWord('collate')) {
          p.takeWord('character'); p.takeWord('set'); p.takeWord('charset'); p.takeWord('collate');
          p.takeOp('=');
          if (p.peek()) p.eat();
          continue;
        }
        break;
      }
      p.done();
      return { kind: 'create-database', name, ifNotExists };
    }
    const uniqueIndex = p.takeWord('unique');
    if (uniqueIndex || p.word('index')) {
      p.expectWord('index');
      const name = parseIdent(p);
      p.expectWord('on');
      const table = parseIdent(p);
      const columns = parseIndexCols(p);
      p.done();
      return { kind: 'create-index', unique: uniqueIndex, name, table, columns };
    }
    if (p.word('view') || p.word('procedure') || p.word('function') || p.word('trigger')) {
      throw sqlError(1235, `CREATE ${p.peek().v} is not supported`);
    }
    p.expectWord('table');
    let ifNotExists = false;
    if (p.takeWord('if')) { p.expectWord('not'); p.expectWord('exists'); ifNotExists = true; }
    const name = parseIdent(p);
    p.expectOp('(');
    const columns = [];
    const indexes = [];
    let tablePk = null;
    while (p.peek() && !p.op(')')) {
      if (p.takeWord('constraint')) {
        if (!p.word('primary') && !p.word('unique') && !p.word('foreign') && !p.word('check') && !p.op('(')) parseIdent(p);
      }
      if (p.word('primary')) {
        p.expectWord('primary');
        p.expectWord('key');
        const cols = parseIndexCols(p);
        if (cols.length !== 1) throw sqlError(1235, 'a composite primary key is not supported');
        tablePk = cols[0];
      } else if (p.takeWord('unique')) {
        indexes.push(namedIndex(p, true));
      } else if (p.word('key') || p.word('index')) {
        indexes.push(namedIndex(p, false));
      } else if (p.takeWord('foreign') || p.takeWord('check')) {
        skipUntilComma(p);
      } else {
        const colName = parseIdent(p);
        const typed = parseType(p);
        const col = {
          name: colName, type: typed.type, mysqlType: typed.mysqlType, primary: false,
          nullable: true, autoIncrement: false, default: null, unsigned: false, unique: false,
        };
        parseColumnRest(p, col);
        columns.push(col);
      }
      if (!p.op(')')) p.expectOp(',');
    }
    p.expectOp(')');
    parseTableOptions(p);
    return { kind: 'create-table', name, ifNotExists, columns, indexes, tablePk };
  }

  if (kind === 'drop') {
    p.eat();
    if (p.takeWord('index')) {
      const name = parseIdent(p);
      p.expectWord('on');
      const table = parseIdent(p);
      p.done();
      return { kind: 'drop-index', name, table };
    }
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

  if (kind === 'alter') {
    p.eat();
    p.expectWord('table');
    const name = parseIdent(p);
    const actions = [];
    do {
      const action = parseAlterAction(p);
      if (action) actions.push(action);
    } while (p.takeOp(','));
    p.done();
    if (!actions.length) throw sqlError(1064, 'expected a table change');
    return { kind: 'alter-table', name, actions };
  }

  if (kind === 'truncate') {
    p.eat();
    p.takeWord('table');
    const name = parseIdent(p);
    p.done();
    return { kind: 'truncate', name };
  }

  if (kind === 'rename') {
    p.eat();
    p.expectWord('table');
    const from = parseIdent(p);
    p.expectWord('to');
    const to = parseIdent(p);
    p.done();
    return { kind: 'rename-table', from, to };
  }

  if (kind === 'insert' || kind === 'replace') {
    const replace = kind === 'replace';
    p.eat();
    p.takeWord('low_priority') || p.takeWord('delayed') || p.takeWord('high_priority');
    const ignore = !replace && p.takeWord('ignore');
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
        set.push({ col, expr: parseExpr(p) });
      } while (p.takeOp(','));
      const onDup = parseOnDup(p);
      p.done();
      return { kind: 'insert', replace, ignore, ...name, set, onDup };
    }
    if (p.takeWord('select')) throw sqlError(1235, 'INSERT ... SELECT is not supported');
    p.expectWord('values');
    const tuples = [];
    do {
      p.expectOp('(');
      const vals = [];
      if (!p.op(')')) do { vals.push(parseExpr(p)); } while (p.takeOp(','));
      p.expectOp(')');
      tuples.push(vals);
    } while (p.takeOp(','));
    const onDup = parseOnDup(p);
    p.done();
    return { kind: 'insert', replace, ignore, ...name, cols, tuples, onDup };
  }

  if (kind === 'update') {
    p.eat();
    p.takeWord('low_priority');
    const name = parseQualified(p);
    p.expectWord('set');
    const set = [];
    do {
      let col = parseIdent(p);
      if (p.takeOp('.')) col = parseIdent(p);
      p.expectOp('=');
      set.push({ col, expr: parseExpr(p) });
    } while (p.takeOp(','));
    const where = p.takeWord('where') ? parseExpr(p) : null;
    const { order, limit, offset } = parseOrderLimit(p);
    p.done();
    return { kind: 'update', ...name, set, where, order, limit, offset };
  }

  if (kind === 'delete') {
    p.eat();
    p.takeWord('low_priority') || p.takeWord('quick') || p.takeWord('ignore');
    p.expectWord('from');
    const name = parseQualified(p);
    const where = p.takeWord('where') ? parseExpr(p) : null;
    const { order, limit, offset } = parseOrderLimit(p);
    p.done();
    return { kind: 'delete', ...name, where, order, limit, offset };
  }

  if (kind === 'select') {
    p.eat();
    const distinct = p.takeWord('distinct');
    p.takeWord('all');
    const cols = parseSelectList(p);
    let from = null;
    const joins = [];
    if (p.takeWord('from')) {
      from = parseTableRef(p);
      for (;;) {
        let how = null;
        if (p.takeOp(',')) how = 'cross';
        else if (p.takeWord('cross')) { p.takeWord('join'); how = 'cross'; }
        else if (p.takeWord('inner')) { p.expectWord('join'); how = 'inner'; }
        else if (p.takeWord('join') || p.takeWord('straight_join')) how = 'inner';
        else if (p.takeWord('left')) { p.takeWord('outer'); p.expectWord('join'); how = 'left'; }
        else if (p.takeWord('right')) { p.takeWord('outer'); p.expectWord('join'); how = 'right'; }
        else break;
        const table = parseTableRef(p);
        let on = null;
        if (how !== 'cross') {
          p.expectWord('on');
          on = parseExpr(p);
        }
        joins.push({ how, table, on });
      }
    }
    const where = p.takeWord('where') ? parseExpr(p) : null;
    let group = null;
    if (p.takeWord('group')) {
      p.expectWord('by');
      group = [];
      do { group.push(parseExpr(p)); } while (p.takeOp(','));
    }
    if (p.word('having')) throw sqlError(1235, 'HAVING is not supported');
    if (p.word('union')) throw sqlError(1235, 'UNION is not supported');
    const { order, limit, offset } = parseOrderLimit(p);
    p.done();
    return { kind: 'select', cols, from, joins, where, group, distinct, order, limit, offset };
  }

  throw sqlError(1064, `unsupported statement ${first.v}`);
}

function parseAlterColumn(p) {
  const name = parseIdent(p);
  const typed = parseType(p);
  const col = {
    name, type: typed.type, mysqlType: typed.mysqlType, primary: false,
    nullable: true, autoIncrement: false, default: null, unsigned: false, unique: false,
  };
  parseColumnRest(p, col);
  let place = null;
  if (p.takeWord('first')) place = { first: true };
  else if (p.takeWord('after')) place = { after: parseIdent(p) };
  return { col, place };
}

function parseAlterAction(p) {
  if (p.takeWord('algorithm') || p.takeWord('lock')) {
    p.takeOp('=');
    if (p.peek()) p.eat();
    return null;
  }
  if (p.takeWord('add')) {
    if (p.takeWord('constraint')) {
      if (!p.word('primary') && !p.word('unique') && !p.word('foreign') && !p.word('check')) parseIdent(p);
    }
    if (p.takeWord('column') || (!p.word('unique') && !p.word('index') && !p.word('key') && !p.word('primary') && !p.word('fulltext') && !p.word('spatial') && !p.word('foreign') && !p.word('check'))) {
      return { op: 'add-column', ...parseAlterColumn(p) };
    }
    if (p.takeWord('unique')) return { op: 'add-index', index: namedIndex(p, true) };
    if (p.word('fulltext') || p.word('spatial')) throw sqlError(1235, 'this index type is not supported');
    if (p.word('index') || p.word('key')) return { op: 'add-index', index: namedIndex(p, false) };
    if (p.takeWord('primary')) {
      p.expectWord('key');
      parseIndexCols(p);
      throw sqlError(1235, 'changing the primary key is not supported');
    }
    if (p.takeWord('foreign') || p.takeWord('check')) { skipUntilComma(p); return null; }
    throw sqlError(1064, 'expected a column or index');
  }
  if (p.takeWord('drop')) {
    if (p.takeWord('index') || p.takeWord('key')) return { op: 'drop-index', name: parseIdent(p) };
    if (p.takeWord('primary')) {
      p.expectWord('key');
      throw sqlError(1235, 'dropping the primary key is not supported');
    }
    if (p.takeWord('foreign') || p.takeWord('check')) { parseIdent(p); return null; }
    p.takeWord('column');
    const name = parseIdent(p);
    p.takeWord('restrict') || p.takeWord('cascade');
    return { op: 'drop-column', name };
  }
  if (p.takeWord('rename')) {
    if (p.takeWord('column')) {
      const from = parseIdent(p);
      p.expectWord('to');
      return { op: 'rename-column', from, to: parseIdent(p) };
    }
    if (p.takeWord('to') || p.takeWord('as')) return { op: 'rename-table', name: parseIdent(p) };
    throw sqlError(1064, 'expected TO');
  }
  if (p.takeWord('modify')) {
    p.takeWord('column');
    return { op: 'modify-column', ...parseAlterColumn(p) };
  }
  if (p.takeWord('change')) {
    p.takeWord('column');
    const from = parseIdent(p);
    return { op: 'change-column', from, ...parseAlterColumn(p) };
  }
  throw sqlError(1064, 'unsupported ALTER TABLE');
}

function namedIndex(p, unique) {
  p.takeWord('key') || p.takeWord('index');
  let name = null;
  if (!p.op('(')) name = parseIdent(p);
  const columns = parseIndexCols(p);
  return { name: name || `${unique ? 'uq' : 'ix'}_${columns.join('_')}`, unique, columns };
}

function parseOnDup(p) {
  if (!p.takeWord('on')) return null;
  p.expectWord('duplicate');
  p.expectWord('key');
  p.expectWord('update');
  const updates = [];
  do {
    let col = parseIdent(p);
    if (p.takeOp('.')) col = parseIdent(p);
    p.expectOp('=');
    updates.push({ col, expr: parseExpr(p) });
  } while (p.takeOp(','));
  return updates;
}

function ok(affectedRows = 0, insertId = 0) {
  return { kind: 'ok', affectedRows, insertId: insertId || 0 };
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
  if (e.code === 'bad_row') return sqlError(1366, e.message, '22000');
  if (e.code === 'bad_schema' || e.code === 'bad_name') return sqlError(1064, e.message, '42000');
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

async function resolveOwned(dataStore, session, name) {
  if (name === 'information_schema') return name;
  if (VIRTUAL.has(name)) throw sqlError(1044, `access denied for database ${name}`, '42000');
  const db = await storeCall(() => dataStore.getDatabase(session.ownerId, name));
  if (!db) throw sqlError(1049, `unknown database ${name}`, '42000');
  return name;
}

async function useDatabase(dataStore, session, name) {
  if (name === 'information_schema' || VIRTUAL.has(name)) throw sqlError(1044, `access denied for database ${name}`, '42000');
  await resolveOwned(dataStore, session, name);
  session.database = name;
  return ok();
}

function dirty(session) {
  if (!session.overlay) return false;
  for (const rows of session.overlay.values()) if (rows.size) return true;
  return false;
}

function needsMeta(table) {
  return table.columns.some((c) => c.autoIncrement) || (table.indexes || []).some((ix) => ix.unique);
}

async function commitSession(dataStore, session) {
  const overlay = session.overlay;
  session.overlay = null;
  session.explicitTx = false;
  if (!overlay || ![...overlay.values()].some((m) => m.size)) return ok();
  const db = requireDb(session);
  await storeCall(() => dataStore.transact(session.ownerId, db, async (tx) => {
    for (const [tableName, rows] of overlay) {
      const table = await dataStore.getTable(session.ownerId, db, tableName);
      if (!table) throw sqlError(1146, `table ${tableName} does not exist`, '42S02');
      if (needsMeta(table)) await tx.lockMeta(tableName);
      const existing = await tx.listAll(tableName);
      const merged = new Map(existing.map((r) => [r.pk, r]));
      for (const [pk, row] of rows) {
        if (row == null) merged.delete(pk);
        else merged.set(pk, row);
      }
      assertUnique(table, [...merged.values()]);
      for (const [pk, row] of rows) {
        if (row == null) await tx.deleteRow(tableName, pk);
        else await tx.putRow(tableName, pk, row.values, { maxBytes: SQL_MAX_BYTES });
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

function comparePk(columns, a, b) {
  const pk = columns.find((c) => c.primary);
  if (pk && (pk.type === 'int' || pk.type === 'float' || pk.type === 'bool')) {
    const av = Number(a.values[pk.name]);
    const bv = Number(b.values[pk.name]);
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
  }
  return cmpPk(String(a.pk), String(b.pk));
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
  const schema = await loadSchema(dataStore, session, table);
  return [...map.values()].sort((a, b) => comparePk(schema.columns, a, b));
}

function coerce(column, value) {
  if (value == null) return null;
  if (column.type === 'string') {
    if (typeof value === 'object') throw sqlError(1366, `${column.name} must be a string`, '22000');
    return String(value);
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
  if (column.type === 'float') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) throw sqlError(1366, `${column.name} must be a number`, '22000');
    return n;
  }
  if (column.type === 'decimal') {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return value;
    throw sqlError(1366, `${column.name} must be a decimal`, '22000');
  }
  if (column.type === 'datetime') {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 19).replace('T', ' ');
    if (typeof value === 'string' && value.length > 0 && value.length < 64) return value;
    throw sqlError(1366, `${column.name} must be a date or time`, '22000');
  }
  if (column.type === 'blob') {
    if (Buffer.isBuffer(value)) return value.toString('base64');
    if (typeof value === 'string') return value;
    throw sqlError(1366, `${column.name} must be bytes`, '22000');
  }
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { throw sqlError(1366, `${column.name} must be JSON`, '22000'); }
  }
  if (typeof value === 'number' || typeof value === 'boolean' || (value && typeof value === 'object')) {
    try { return JSON.parse(JSON.stringify(value)); } catch { throw sqlError(1366, `${column.name} must be JSON`, '22000'); }
  }
  throw sqlError(1366, `${column.name} must be JSON`, '22000');
}

function primaryOf(columns) {
  return columns.find((c) => c.primary);
}

function rowKey(col, logical) {
  if (logical == null) return '';
  if (col && col.type === 'bool') return (logical === true || logical === 1 || logical === '1') ? '1' : '0';
  return String(logical);
}

function sameValue(a, b) {
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return (a === true || a === 1) === (b === true || b === 1);
  return String(a) === String(b);
}

function findConflict(table, rows, values, selfPk) {
  const pkCol = primaryOf(table.columns);
  const pk = rowKey(pkCol, values[pkCol.name]);
  for (const r of rows) {
    if (selfPk != null && r.pk === selfPk) continue;
    if (r.pk === pk) return r;
  }
  for (const ix of table.indexes || []) {
    if (!ix.unique) continue;
    if (ix.columns.some((c) => values[c] == null)) continue;
    for (const r of rows) {
      if (selfPk != null && r.pk === selfPk) continue;
      if (ix.columns.every((c) => sameValue(r.values[c], values[c]))) return r;
    }
  }
  return null;
}

function assertUnique(table, rows) {
  const seenPk = new Set();
  for (const r of rows) {
    if (seenPk.has(r.pk)) throw sqlError(1062, `duplicate primary key ${r.pk}`, '23000');
    seenPk.add(r.pk);
  }
  for (const ix of table.indexes || []) {
    if (!ix.unique) continue;
    const seen = new Set();
    for (const r of rows) {
      if (ix.columns.some((c) => r.values[c] == null)) continue;
      const key = ix.columns.map((c) => String(r.values[c])).join('\0');
      if (seen.has(key)) throw sqlError(1062, `duplicate key ${ix.name}`, '23000');
      seen.add(key);
    }
  }
}

function nowStamp() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

async function allocAuto(dataStore, session, table) {
  return storeCall(() => dataStore.transact(session.ownerId, session.database, async (tx) => {
    const meta = await tx.lockMeta(table.name);
    const id = Number(meta.ai || 1);
    if (!Number.isSafeInteger(id)) throw sqlError(1114, 'auto-increment is exhausted', 'HY000');
    await tx.setMeta(table.name, { ...meta, ai: id + 1 });
    return id;
  }));
}

async function materialize(dataStore, session, table, raw) {
  const values = {};
  for (const c of table.columns) {
    const present = Object.prototype.hasOwnProperty.call(raw, c.name);
    let v = present ? raw[c.name] : undefined;
    if (!present || v === undefined || (v === null && c.autoIncrement)) {
      if (c.autoIncrement) v = await allocAuto(dataStore, session, table);
      else if (c.default === 'current_timestamp') v = c.type === 'datetime' && String(c.mysqlType || '').startsWith('date') ? nowStamp().slice(0, 10) : nowStamp();
      else if (c.default != null) v = coerce(c, c.default);
      else if (c.nullable === false) throw sqlError(1364, `field ${c.name} has no default value`, 'HY000');
      else v = null;
    } else v = coerce(c, v);
    values[c.name] = v;
  }
  const pkCol = primaryOf(table.columns);
  if (values[pkCol.name] == null || values[pkCol.name] === '') throw sqlError(1364, `primary key ${pkCol.name} is required`, 'HY000');
  return values;
}

function likeToRegExp(pattern) {
  let src = '^';
  for (const ch of String(pattern)) {
    if (ch === '%') src += '.*';
    else if (ch === '_') src += '.';
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(src + '$', 'i');
}

function truthy(v) {
  return !(v == null || v === false || v === 0 || v === '');
}

function cmpValues(left, right, op) {
  if (left == null || right == null) return false;
  let n = 0;
  const numeric = typeof left === 'number' || typeof right === 'number' || typeof left === 'boolean' || typeof right === 'boolean';
  if (numeric) {
    const a = left === true ? 1 : left === false ? 0 : Number(left);
    const b = right === true ? 1 : right === false ? 0 : Number(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) n = cmpPk(String(left), String(right));
    else n = a === b ? 0 : a < b ? -1 : 1;
  } else n = cmpPk(String(left), String(right));
  if (op === '=') return n === 0;
  if (op === '!=') return n !== 0;
  if (op === '<') return n < 0;
  if (op === '>') return n > 0;
  if (op === '<=') return n <= 0;
  if (op === '>=') return n >= 0;
  return false;
}

function findColumn(row, name, table) {
  const want = String(name).toLowerCase();
  if (table) {
    const key = Object.keys(row.parts).find((k) => k.toLowerCase() === String(table).toLowerCase());
    const part = key ? row.parts[key] : null;
    if (!part) throw sqlError(1054, `unknown column ${table}.${name}`, '42S22');
    const column = part.columns.find((c) => c.name.toLowerCase() === want);
    if (!column) throw sqlError(1054, `unknown column ${table}.${name}`, '42S22');
    return { column, value: part.values ? part.values[column.name] : null };
  }
  const hits = [];
  for (const part of Object.values(row.parts)) {
    const column = part.columns.find((c) => c.name.toLowerCase() === want);
    if (column) hits.push({ column, value: part.values ? part.values[column.name] : null });
  }
  if (!hits.length) throw sqlError(1054, `unknown column ${name}`, '42S22');
  if (hits.length > 1) throw sqlError(1052, `column ${name} is ambiguous`, '23000');
  return hits[0];
}

function evalFn(expr, ctx) {
  const n = expr.fn;
  const arg = (i) => evalExpr(expr.args[i], ctx);
  if (AGG.has(n)) {
    if (!ctx.group) throw sqlError(1111, 'invalid use of group function', 'HY000');
    return evalAgg(expr, ctx.group, ctx);
  }
  if (n === 'database' || n === 'schema') return ctx.session.database;
  if (n === 'user' || n === 'current_user' || n === 'session_user') return `${ctx.session.username}@%`;
  if (n === 'version') return SERVER_VERSION;
  if (n === 'connection_id') return ctx.session.connectionId || 0;
  if (n === 'now' || n === 'current_timestamp' || n === 'utc_timestamp' || n === 'localtime' || n === 'localtimestamp') return nowStamp();
  if (n === 'curdate' || n === 'current_date') return nowStamp().slice(0, 10);
  if (n === 'ifnull' || n === 'nullif') {
    const a = arg(0);
    const b = arg(1);
    if (n === 'nullif') return cmpValues(a, b, '=') ? null : a;
    return a == null ? b : a;
  }
  if (n === 'coalesce') {
    for (const a of expr.args) {
      const v = evalExpr(a, ctx);
      if (v != null) return v;
    }
    return null;
  }
  if (n === 'concat' || n === 'concat_ws') {
    const skip = n === 'concat_ws' ? 1 : 0;
    const sep = n === 'concat_ws' ? (arg(0) == null ? '' : String(arg(0))) : '';
    const parts = [];
    for (let i = skip; i < expr.args.length; i++) {
      const v = evalExpr(expr.args[i], ctx);
      if (v == null) {
        if (n === 'concat') return null;
        continue;
      }
      parts.push(String(v));
    }
    return n === 'concat_ws' ? parts.join(sep) : parts.join('');
  }
  if (n === 'lower' || n === 'lcase') { const v = arg(0); return v == null ? null : String(v).toLowerCase(); }
  if (n === 'upper' || n === 'ucase') { const v = arg(0); return v == null ? null : String(v).toUpperCase(); }
  if (n === 'length' || n === 'char_length' || n === 'character_length') {
    const v = arg(0);
    return v == null ? null : String(v).length;
  }
  if (n === 'if') return truthy(arg(0)) ? arg(1) : arg(2);
  if (n === 'values') {
    const name = expr.args[0] && expr.args[0].col;
    if (!name || !ctx.insertValues) throw sqlError(1064, 'VALUES() is only valid in ON DUPLICATE KEY UPDATE');
    const key = Object.keys(ctx.insertValues).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? ctx.insertValues[key] : null;
  }
  throw sqlError(1235, `function ${n} is not supported`);
}

function evalAgg(expr, rows, ctx) {
  if (expr.fn === 'count' && expr.star) return rows.length;
  const vals = [];
  for (const row of rows) {
    const v = evalExpr(expr.args[0], { ...ctx, row, group: null });
    if (v != null) vals.push(v);
  }
  if (expr.fn === 'count') return vals.length;
  if (!vals.length) return null;
  if (expr.fn === 'sum') return vals.reduce((a, b) => a + Number(b), 0);
  if (expr.fn === 'avg') return vals.reduce((a, b) => a + Number(b), 0) / vals.length;
  let best = vals[0];
  for (const v of vals.slice(1)) {
    const less = cmpValues(v, best, '<');
    if (expr.fn === 'min' ? less : cmpValues(v, best, '>')) best = v;
  }
  return best;
}

function evalExpr(expr, ctx) {
  if (expr == null) return null;
  if (Object.prototype.hasOwnProperty.call(expr, 'lit')) return expr.lit;
  if (expr.param) throw sqlError(1064, 'not enough parameters');
  if (expr.def) return undefined;
  if (expr.sys) return sysValue(ctx.session, expr.sys);
  if (expr.col) {
    if (!ctx.row) return null;
    return findColumn(ctx.row, expr.col, expr.table).value;
  }
  if (expr.fn) return evalFn(expr, ctx);
  if (expr.op === 'neg') {
    const v = evalExpr(expr.args[0], ctx);
    return v == null ? null : -Number(v);
  }
  if (expr.op === '+' || expr.op === '-' || expr.op === '*' || expr.op === '/') {
    const a = evalExpr(expr.args[0], ctx);
    const b = evalExpr(expr.args[1], ctx);
    if (a == null || b == null) return null;
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (expr.op === '+') return x + y;
    if (expr.op === '-') return x - y;
    if (expr.op === '*') return x * y;
    return y === 0 ? null : x / y;
  }
  if (expr.op === 'and') return truthy(evalExpr(expr.args[0], ctx)) && truthy(evalExpr(expr.args[1], ctx));
  if (expr.op === 'or') return truthy(evalExpr(expr.args[0], ctx)) || truthy(evalExpr(expr.args[1], ctx));
  if (expr.op === 'not') return !truthy(evalExpr(expr.args[0], ctx));
  if (expr.op === 'is') {
    const v = evalExpr(expr.args[0], ctx);
    return expr.not ? v != null : v == null;
  }
  if (expr.op === 'like') {
    const left = evalExpr(expr.args[0], ctx);
    const right = evalExpr(expr.args[1], ctx);
    if (left == null || right == null) return false;
    return likeToRegExp(right).test(String(left));
  }
  if (expr.op === 'in') {
    const left = evalExpr(expr.args[0], ctx);
    if (left == null) return false;
    return expr.args.slice(1).some((a) => cmpValues(left, evalExpr(a, ctx), '='));
  }
  if (expr.op === 'between') {
    const v = evalExpr(expr.args[0], ctx);
    return cmpValues(v, evalExpr(expr.args[1], ctx), '>=') && cmpValues(v, evalExpr(expr.args[2], ctx), '<=');
  }
  if (expr.op === 'cmp') return cmpValues(evalExpr(expr.args[0], ctx), evalExpr(expr.args[1], ctx), expr.cmp);
  throw sqlError(1064, 'bad expression');
}

function bindParams(expr, session) {
  if (!expr || typeof expr !== 'object') return expr;
  if (expr.param) {
    if (!session.params || session._paramI >= session.params.length) throw sqlError(1064, 'not enough parameters');
    return { lit: session.params[session._paramI++], as: expr.as };
  }
  const out = { ...expr };
  if (expr.args) out.args = expr.args.map((a) => bindParams(a, session));
  return out;
}

function bindNum(expr, session) {
  if (!expr) return null;
  const bound = bindParams(expr, session);
  return bound.lit;
}

function bindStmt(stmt, session) {
  session._paramI = 0;
  const out = { ...stmt };
  if (stmt.cols) out.cols = stmt.cols.map((c) => bindParams(c, session));
  if (stmt.where) out.where = bindParams(stmt.where, session);
  if (stmt.group) out.group = stmt.group.map((g) => bindParams(g, session));
  if (stmt.order) out.order = stmt.order.map((o) => ({ ...o, expr: bindParams(o.expr, session) }));
  if (stmt.limit) out.limit = bindNum(stmt.limit, session);
  if (stmt.offset) out.offset = bindNum(stmt.offset, session);
  if (stmt.joins) out.joins = stmt.joins.map((j) => ({ ...j, on: j.on ? bindParams(j.on, session) : null }));
  if (stmt.set) out.set = stmt.set.map((s) => ({ ...s, expr: s.expr ? bindParams(s.expr, session) : s.expr }));
  if (stmt.tuples) out.tuples = stmt.tuples.map((t) => t.map((e) => bindParams(e, session)));
  if (stmt.onDup) out.onDup = stmt.onDup.map((s) => ({ ...s, expr: bindParams(s.expr, session) }));
  return out;
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

function columnTypeSql(c) {
  if (typeof c.mysqlType === 'string' && c.mysqlType !== c.type) return c.mysqlType;
  if (c.type === 'string') return 'varchar(255)';
  if (c.type === 'int') return 'bigint';
  if (c.type === 'bool') return 'tinyint(1)';
  if (c.type === 'float') return 'double';
  if (c.type === 'decimal') return 'decimal(65,30)';
  if (c.type === 'datetime') return 'datetime';
  if (c.type === 'blob') return 'blob';
  return 'json';
}

function dataTypeName(c) {
  const sql = columnTypeSql(c);
  return sql.replace(/\(.*$/, '');
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
    for (const table of tables) owned.push({ db: d.name, table });
  }
  if (name === 'tables') {
    return {
      columns: [col('TABLE_SCHEMA', 'string'), col('TABLE_NAME', 'string'), col('TABLE_TYPE', 'string'), col('ENGINE', 'string')],
      records: owned.map((t) => ({ values: { TABLE_SCHEMA: t.db, TABLE_NAME: t.table.name, TABLE_TYPE: 'BASE TABLE', ENGINE: 'InnoDB' } })),
    };
  }
  if (name === 'columns') {
    const records = [];
    for (const t of owned) {
      const unique = new Set();
      for (const ix of t.table.indexes || []) if (ix.unique) for (const c of ix.columns) unique.add(c);
      t.table.columns.forEach((c, i) => {
        records.push({ values: {
          TABLE_SCHEMA: t.db,
          TABLE_NAME: t.table.name,
          COLUMN_NAME: c.name,
          ORDINAL_POSITION: i + 1,
          DATA_TYPE: dataTypeName(c),
          COLUMN_TYPE: columnTypeSql(c),
          COLUMN_KEY: c.primary ? 'PRI' : (unique.has(c.name) ? 'UNI' : ''),
          IS_NULLABLE: c.nullable === false || c.primary ? 'NO' : 'YES',
          COLUMN_DEFAULT: c.default == null ? null : String(c.default),
          EXTRA: c.autoIncrement ? 'auto_increment' : '',
        } });
      });
    }
    return {
      columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'DATA_TYPE', 'COLUMN_TYPE', 'COLUMN_KEY', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'EXTRA']
        .map((n) => col(n, n === 'ORDINAL_POSITION' ? 'int' : 'string')),
      records,
    };
  }
  if (name === 'statistics') {
    const records = [];
    for (const t of owned) {
      const pk = t.table.columns.find((c) => c.primary);
      if (pk) {
        records.push({ values: { TABLE_SCHEMA: t.db, TABLE_NAME: t.table.name, INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, SEQ_IN_INDEX: 1, COLUMN_NAME: pk.name } });
      }
      for (const ix of t.table.indexes || []) {
        ix.columns.forEach((c, i) => {
          records.push({ values: {
            TABLE_SCHEMA: t.db, TABLE_NAME: t.table.name, INDEX_NAME: ix.name, NON_UNIQUE: ix.unique ? 0 : 1, SEQ_IN_INDEX: i + 1, COLUMN_NAME: c,
          } });
        });
      }
    }
    return {
      columns: ['TABLE_SCHEMA', 'TABLE_NAME', 'INDEX_NAME', 'NON_UNIQUE', 'SEQ_IN_INDEX', 'COLUMN_NAME']
        .map((n) => col(n, n === 'NON_UNIQUE' || n === 'SEQ_IN_INDEX' ? 'int' : 'string')),
      records,
    };
  }
  throw sqlError(1146, `table information_schema.${tableName} does not exist`, '42S02');
}

function wrapRows(alias, columns, rows) {
  return rows.map((r) => ({
    pk: r.pk,
    values: r.values,
    parts: { [alias]: { values: r.values, columns } },
  }));
}

function nullPart(columns) {
  const values = {};
  for (const c of columns) values[c.name] = null;
  return { values, columns };
}

function joinAll(base, joins, ctx) {
  let rows = base;
  for (const join of joins) {
    const next = [];
    const rightRows = join.rows;
    if (join.how === 'right') {
      for (const rr of rightRows) {
        let matched = false;
        for (const left of rows) {
          const merged = { parts: { ...left.parts, [join.alias]: { values: rr.values, columns: join.columns } } };
          if (!join.on || truthy(evalExpr(join.on, { ...ctx, row: merged }))) {
            matched = true;
            next.push(merged);
          }
        }
        if (!matched) {
          const parts = {};
          for (const [name, part] of Object.entries(rows[0] ? rows[0].parts : {})) parts[name] = nullPart(part.columns);
          if (!rows[0] && join.leftColumns) {
            for (const [name, columns] of Object.entries(join.leftColumns)) parts[name] = nullPart(columns);
          }
          parts[join.alias] = { values: rr.values, columns: join.columns };
          next.push({ parts });
        }
      }
    } else {
      for (const left of rows) {
        let matched = false;
        for (const rr of rightRows) {
          const merged = { parts: { ...left.parts, [join.alias]: { values: rr.values, columns: join.columns } } };
          const ok = join.how === 'cross' || !join.on || truthy(evalExpr(join.on, { ...ctx, row: merged }));
          if (ok) { matched = true; next.push(merged); }
        }
        if (!matched && join.how === 'left') {
          next.push({ parts: { ...left.parts, [join.alias]: nullPart(join.columns) } });
        }
      }
    }
    rows = next;
  }
  return rows;
}

function exprName(expr, i, sample) {
  if (expr.as) return expr.as;
  if (expr.col && sample) {
    try { return findColumn(sample, expr.col, expr.table).column.name; } catch { return expr.col; }
  }
  if (expr.col) return expr.col;
  if (expr.fn) return `${expr.fn}()`;
  if (expr.sys) return `@@${expr.sys}`;
  if (expr.lit != null) return String(expr.lit);
  return `_${i}`;
}

function exprType(expr, sample) {
  if (expr.fn === 'count') return 'int';
  if (expr.fn === 'sum') return 'int';
  if (expr.fn === 'avg') return 'float';
  if (expr.fn === 'now' || expr.fn === 'current_timestamp') return 'datetime';
  if (expr.col && sample) {
    try { return findColumn(sample, expr.col, expr.table).column.type; } catch { return 'string'; }
  }
  if (expr.fn === 'min' || expr.fn === 'max') return expr.args[0] ? exprType(expr.args[0], sample) : 'string';
  if (Object.prototype.hasOwnProperty.call(expr, 'lit')) {
    if (typeof expr.lit === 'number') return Number.isInteger(expr.lit) ? 'int' : 'float';
    if (typeof expr.lit === 'boolean') return 'bool';
  }
  return 'string';
}

function wireValue(type, value) {
  if (value == null) return null;
  if (type === 'bool') return value ? 1 : 0;
  if (type === 'json') return typeof value === 'string' ? value : JSON.stringify(value);
  if (type === 'int' && typeof value === 'number') return value;
  return value;
}

function hasAgg(expr) {
  if (!expr || typeof expr !== 'object') return false;
  if (expr.fn && AGG.has(expr.fn)) return true;
  return (expr.args || []).some(hasAgg);
}

function expandStars(cols, sample) {
  const out = [];
  for (const spec of cols) {
    if (!spec.star || spec.fn) { out.push(spec); continue; }
    if (!sample) throw sqlError(1064, 'SELECT * needs a table');
    const entries = spec.table
      ? [[spec.table, sample.parts[spec.table]]].filter((e) => e[1])
      : Object.entries(sample.parts);
    if (spec.table && !sample.parts[spec.table]) throw sqlError(1054, `unknown table ${spec.table}`, '42S22');
    for (const [, part] of entries) {
      for (const c of part.columns) out.push({ col: c.name, table: Object.keys(sample.parts).find((k) => sample.parts[k] === part), as: null, _type: c.type });
    }
  }
  return out;
}

function project(cols, rows, ctx, sampleRow) {
  const sample = sampleRow || rows[0] || null;
  const specs = expandStars(cols, sample);
  if (specs.some((s) => s.star && !s.fn)) throw sqlError(1054, 'unknown column', '42S22');
  const aggregated = specs.some(hasAgg) || ctx.groupBy;
  let groups;
  if (aggregated) {
    const map = new Map();
    const source = rows;
    if (ctx.groupBy) {
      for (const row of source) {
        const key = JSON.stringify(ctx.groupBy.map((g) => evalExpr(g, { ...ctx, row })));
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
      }
    } else map.set('*', source);
    groups = [...map.values()];
    if (!ctx.groupBy && groups.length === 1 && groups[0].length === 0) groups = [[]];
  } else groups = rows.map((r) => [r]);
  const columns = specs.map((spec, i) => col(exprName(spec, i, (groups.find((g) => g[0]) || [])[0] || sample), spec._type || exprType(spec, (groups.find((g) => g[0]) || [])[0] || sample)));
  const out = groups.map((group) => {
    const row = group[0] || null;
    return specs.map((spec, i) => wireValue(columns[i].type, evalExpr(spec, { ...ctx, row, group })));
  });
  return { columns, rows: out };
}

async function loadRef(dataStore, session, ref) {
  const schema = ref.schema || session.database;
  if (schema === 'information_schema') {
    const info = await infoRows(dataStore, session, ref.name);
    return { alias: ref.alias, columns: info.columns, rows: info.records.map((r) => ({ pk: '', values: r.values })) };
  }
  if (!schema) throw sqlError(1046, 'no database selected', '3D000');
  if (VIRTUAL.has(schema)) throw sqlError(1044, `access denied for database ${schema}`, '42000');
  const saved = session.database;
  if (schema !== saved) {
    await resolveOwned(dataStore, session, schema);
    session.database = schema;
  }
  try {
    const table = await loadSchema(dataStore, session, ref.name);
    const rows = await scanTable(dataStore, session, table.name);
    return { alias: ref.alias, table, columns: table.columns, rows };
  } finally { session.database = saved; }
}

async function runSelect(dataStore, session, stmt) {
  const ctx = { session, row: null, group: null, groupBy: stmt.group };
  if (!stmt.from) {
    if (stmt.cols.some((c) => c.star || c.col)) throw sqlError(1054, 'unknown column', '42S22');
    const projected = project(stmt.cols, [{ parts: {} }], ctx);
    return result(projected.columns, sliceRows(projected.rows, stmt));
  }
  const baseRef = await loadRef(dataStore, session, stmt.from);
  let rows = wrapRows(baseRef.alias, baseRef.columns, baseRef.rows);
  const joins = [];
  const leftColumns = { [baseRef.alias]: baseRef.columns };
  for (const join of stmt.joins || []) {
    const ref = await loadRef(dataStore, session, join.table);
    joins.push({ how: join.how, on: join.on, alias: ref.alias, columns: ref.columns, rows: ref.rows, leftColumns: { ...leftColumns } });
    leftColumns[ref.alias] = ref.columns;
  }
  if (joins.length) rows = joinAll(rows, joins, ctx);
  if (stmt.where) rows = rows.filter((row) => truthy(evalExpr(stmt.where, { ...ctx, row })));
  const layout = rows[0] || {
    parts: Object.fromEntries(Object.entries(leftColumns).map(([alias, columns]) => [alias, { columns, values: null }])),
  };
  if (!stmt.group && canSortSource(stmt.order, layout)) {
    rows = [...rows].sort((a, b) => compareOrder(stmt.order, a, b, ctx));
  }
  const projected = project(stmt.cols, rows, ctx, layout);
  let outRows = projected.rows;
  if (stmt.distinct) {
    const seen = new Set();
    outRows = outRows.filter((r) => {
      const key = JSON.stringify(r);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (stmt.order && !(!stmt.group && canSortSource(stmt.order, layout))) {
    outRows = [...outRows].sort((a, b) => {
      for (const o of stmt.order) {
        const av = orderValue(o, a, projected.columns, stmt.cols);
        const bv = orderValue(o, b, projected.columns, stmt.cols);
        if (cmpValues(av, bv, '<')) return o.desc ? 1 : -1;
        if (cmpValues(av, bv, '>')) return o.desc ? -1 : 1;
      }
      return 0;
    });
  }
  return result(projected.columns, sliceRows(outRows, stmt));
}

function sliceRows(rows, stmt) {
  const start = stmt.offset || 0;
  if (stmt.limit == null) return rows.slice(start);
  return rows.slice(start, start + stmt.limit);
}

function canSortSource(order, sample) {
  if (!order || !sample) return false;
  return order.every((o) => {
    if (!o.expr || !o.expr.col) return false;
    try { findColumn(sample, o.expr.col, o.expr.table); return true; } catch { return false; }
  });
}

function compareOrder(order, a, b, ctx) {
  for (const o of order) {
    const av = evalExpr(o.expr, { ...ctx, row: a, group: null });
    const bv = evalExpr(o.expr, { ...ctx, row: b, group: null });
    if (cmpValues(av, bv, '<')) return o.desc ? 1 : -1;
    if (cmpValues(av, bv, '>')) return o.desc ? -1 : 1;
  }
  return 0;
}

function orderValue(order, row, columns, selectCols) {
  const expr = order.expr;
  if (expr && expr.col && !expr.table) {
    const idx = columns.findIndex((c) => c.name.toLowerCase() === expr.col.toLowerCase());
    if (idx >= 0) return row[idx];
    const alias = (selectCols || []).find((c) => c.as && c.as.toLowerCase() === expr.col.toLowerCase());
    if (alias) {
      const i = columns.findIndex((c) => c.name.toLowerCase() === alias.as.toLowerCase());
      if (i >= 0) return row[i];
    }
  }
  if (expr && Object.prototype.hasOwnProperty.call(expr, 'lit') && typeof expr.lit === 'number') {
    const i = expr.lit - 1;
    if (i >= 0 && i < row.length) return row[i];
  }
  return null;
}

async function readVisible(dataStore, session, table) {
  return scanTable(dataStore, session, table.name);
}

async function applyWrites(dataStore, session, table, fn) {
  if (ensureTx(session)) {
    const rows = await readVisible(dataStore, session, table);
    return fn({
      rows,
      async put(pk, values) { overlayTable(session, table.name).set(pk, { pk, values }); },
      async del(pk) { overlayTable(session, table.name).set(pk, null); },
    });
  }
  return storeCall(() => dataStore.transact(session.ownerId, session.database, async (tx) => {
    if (needsMeta(table)) await tx.lockMeta(table.name);
    const rows = await tx.listAll(table.name);
    return fn({
      rows,
      async put(pk, values) { await tx.putRow(table.name, pk, values, { maxBytes: SQL_MAX_BYTES }); },
      async del(pk) { await tx.deleteRow(table.name, pk); },
    });
  }));
}

async function insertOne(dataStore, session, table, raw, stmt) {
  const values = await materialize(dataStore, session, table, raw);
  const pkCol = primaryOf(table.columns);
  const pk = rowKey(pkCol, values[pkCol.name]);
  const outcome = await applyWrites(dataStore, session, table, async (tx) => {
    let conflicts = [];
    let rest = tx.rows;
    const seen = new Set();
    for (;;) {
      const hit = findConflict(table, rest, values, null);
      if (!hit || seen.has(hit.pk)) break;
      seen.add(hit.pk);
      conflicts.push(hit);
      rest = rest.filter((r) => r.pk !== hit.pk);
    }
    if (conflicts.length && stmt.ignore && !stmt.replace && !stmt.onDup) return { affected: 0, insertId: 0 };
    if (conflicts.length && !stmt.replace && !stmt.onDup) throw sqlError(1062, 'duplicate entry', '23000');
    if (stmt.onDup && conflicts.length) {
      const hit = conflicts[0];
      const updated = { ...hit.values };
      const row = { parts: { [table.name]: { values: hit.values, columns: table.columns } }, values: hit.values };
      for (const set of stmt.onDup) {
        const column = table.columns.find((c) => c.name === set.col);
        if (!column) throw sqlError(1054, `unknown column ${set.col}`, '42S22');
        if (column.primary) throw sqlError(1235, 'changing the primary key is not supported');
        const v = evalExpr(set.expr, { session, row, insertValues: values, group: null });
        updated[column.name] = v === undefined ? updated[column.name] : coerce(column, v);
      }
      updated[pkCol.name] = hit.values[pkCol.name];
      await tx.put(hit.pk, updated);
      return { affected: 2, insertId: pkCol.type === 'int' ? Number(hit.values[pkCol.name]) : 0 };
    }
    for (const hit of conflicts) await tx.del(hit.pk);
    await tx.put(pk, values);
    return { affected: 1, insertId: pkCol.type === 'int' ? Number(values[pkCol.name]) : 0 };
  });
  return outcome;
}

function columnExtra(c) {
  return c.autoIncrement ? 'auto_increment' : '';
}

function copyColumns(table) {
  return table.columns.map((c) => ({
    name: c.name,
    type: c.type,
    primary: c.primary === true,
    nullable: c.nullable !== false,
    autoIncrement: c.autoIncrement === true,
    default: c.default == null ? null : c.default,
    mysqlType: c.mysqlType || c.type,
    unsigned: c.unsigned === true,
  }));
}

function copyIndexes(table) {
  return (table.indexes || []).map((ix) => ({ name: ix.name, unique: ix.unique === true, columns: ix.columns.slice() }));
}

function placeColumn(columns, col, place) {
  if (!place) { columns.push(col); return; }
  if (place.first) { columns.unshift(col); return; }
  const at = columns.findIndex((c) => c.name === place.after);
  if (at < 0) throw sqlError(1054, `unknown column ${place.after}`, '42S22');
  columns.splice(at + 1, 0, col);
}

async function uniqueHolds(dataStore, session, tableName, index) {
  if (!index.unique) return;
  const rows = await storeCall(() => dataStore.listAll(session.ownerId, session.database, tableName));
  const seen = new Set();
  for (const row of rows) {
    if (index.columns.some((c) => row.values[c] == null)) continue;
    const key = JSON.stringify(index.columns.map((c) => row.values[c]));
    if (seen.has(key)) throw sqlError(1062, 'duplicate entry', '23000');
    seen.add(key);
  }
}

async function saveSchema(dataStore, session, tableName, columns, indexes) {
  await storeCall(() => dataStore.updateTable(session.ownerId, session.database, tableName, {
    mysql: true,
    name: tableName,
    columns,
    indexes,
  }));
}

async function rewriteRows(dataStore, session, tableName, mutator) {
  await storeCall(() => dataStore.transact(session.ownerId, session.database, async (tx) => {
    const rows = await tx.listAll(tableName);
    for (const row of rows) {
      await tx.putRow(tableName, row.pk, mutator(row.values), { maxBytes: SQL_MAX_BYTES });
    }
  }));
}

async function applyAlter(dataStore, session, stmt) {
  const table = await loadSchema(dataStore, session, stmt.name);
  const columns = copyColumns(table);
  let indexes = copyIndexes(table);
  const added = [];
  const dropped = [];
  const renamed = [];
  let renameTo = null;
  for (const action of stmt.actions) {
    if (action.op === 'add-column') {
      if (columns.some((c) => c.name === action.col.name)) throw sqlError(1060, `duplicate column ${action.col.name}`, '42S21');
      if (action.col.primary) throw sqlError(1235, 'changing the primary key is not supported');
      if (action.col.autoIncrement && columns.some((c) => c.autoIncrement)) throw sqlError(1075, 'there can be only one auto column', '42000');
      const rows = await storeCall(() => dataStore.listAll(session.ownerId, session.database, stmt.name));
      if (rows.length && action.col.nullable === false && action.col.default == null && !action.col.autoIncrement) {
        throw sqlError(1364, `field ${action.col.name} doesn't have a default value`, 'HY000');
      }
      if (rows.length && action.col.autoIncrement) throw sqlError(1235, 'adding AUTO_INCREMENT to a table with rows is not supported');
      placeColumn(columns, action.col, action.place);
      if (action.col.unique) indexes.push({ name: action.col.name, unique: true, columns: [action.col.name] });
      added.push(action.col);
    } else if (action.op === 'drop-column') {
      const hit = columns.find((c) => c.name === action.name);
      if (!hit) throw sqlError(1091, `can't DROP ${action.name}; check that column exists`, '42000');
      if (hit.primary) throw sqlError(1235, 'dropping the primary key is not supported');
      columns.splice(columns.indexOf(hit), 1);
      indexes = indexes.map((ix) => ({ ...ix, columns: ix.columns.filter((c) => c !== action.name) })).filter((ix) => ix.columns.length);
      dropped.push(action.name);
    } else if (action.op === 'add-index') {
      if (indexes.some((ix) => ix.name === action.index.name)) throw sqlError(1061, `duplicate key name ${action.index.name}`, '42000');
      for (const c of action.index.columns) if (!columns.some((col) => col.name === c)) throw sqlError(1072, `key column ${c} doesn't exist`, '42000');
      await uniqueHolds(dataStore, session, stmt.name, action.index);
      indexes.push(action.index);
    } else if (action.op === 'drop-index') {
      if (!indexes.some((ix) => ix.name === action.name)) throw sqlError(1091, `can't DROP ${action.name}; check that key exists`, '42000');
      indexes = indexes.filter((ix) => ix.name !== action.name);
    } else if (action.op === 'rename-column' || action.op === 'modify-column' || action.op === 'change-column') {
      const from = action.op === 'modify-column' ? action.col.name : action.from;
      const hit = columns.find((c) => c.name === from);
      if (!hit) throw sqlError(1054, `unknown column ${from}`, '42S22');
      const next = action.op === 'rename-column' ? { name: action.to } : action.col;
      if (action.op !== 'rename-column' && (hit.type !== next.type || hit.primary !== next.primary)) {
        throw sqlError(1235, 'changing a column type is not supported');
      }
      if (next.name !== hit.name && columns.some((c) => c.name === next.name)) throw sqlError(1060, `duplicate column ${next.name}`, '42S21');
      const old = hit.name;
      if (action.op === 'rename-column') hit.name = next.name;
      else {
        hit.name = next.name;
        hit.nullable = next.nullable !== false;
        hit.default = next.default == null ? null : next.default;
        hit.mysqlType = next.mysqlType || hit.mysqlType;
        hit.unsigned = next.unsigned === true;
        hit.autoIncrement = next.autoIncrement === true;
      }
      for (const ix of indexes) ix.columns = ix.columns.map((c) => (c === old ? hit.name : c));
      if (old !== hit.name) renamed.push({ from: old, to: hit.name });
    } else if (action.op === 'rename-table') {
      renameTo = action.name;
    }
  }
  await saveSchema(dataStore, session, stmt.name, columns, indexes);
  const fill = added.filter((c) => c.default != null);
  if (dropped.length || renamed.length || fill.length) {
    await rewriteRows(dataStore, session, stmt.name, (values) => {
      const next = { ...values };
      for (const name of dropped) delete next[name];
      for (const r of renamed) {
        next[r.to] = next[r.from];
        if (r.to !== r.from) delete next[r.from];
      }
      for (const c of fill) next[c.name] = c.default === 'current_timestamp' ? nowStamp() : coerce(c, c.default);
      return next;
    });
  }
  if (renameTo && renameTo !== stmt.name) {
    await storeCall(() => dataStore.renameTable(session.ownerId, session.database, stmt.name, renameTo));
  }
  return ok();
}

async function run(dataStore, session, stmtIn) {
  const stmt = (stmtIn.kind === 'select' || stmtIn.kind === 'insert' || stmtIn.kind === 'update' || stmtIn.kind === 'delete')
    ? bindStmt(stmtIn, session) : stmtIn;
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
  if (stmt.kind === 'create-database' || stmt.kind === 'drop-database') {
    throw sqlError(1044, 'access denied', '42000');
  }
  if (stmt.kind === 'create-table' || stmt.kind === 'drop-table' || stmt.kind === 'alter-table' || stmt.kind === 'truncate' || stmt.kind === 'rename-table' || stmt.kind === 'create-index' || stmt.kind === 'drop-index') {
    if (dirty(session)) await commitSession(dataStore, session);
    else { session.overlay = null; session.explicitTx = false; }
  }

  if (stmt.kind === 'show-databases') {
    const dbs = await storeCall(() => dataStore.listDatabases(session.ownerId));
    const re = stmt.like ? likeToRegExp(stmt.like) : null;
    const names = dbs.map((d) => d.name).filter((n) => !re || re.test(n)).sort();
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
    const db = stmt.schema ? await resolveOwned(dataStore, session, stmt.schema) : requireDb(session);
    const headers = ['Name', 'Engine', 'Version', 'Row_format', 'Rows', 'Avg_row_length', 'Data_length', 'Max_data_length', 'Index_length', 'Data_free', 'Auto_increment', 'Create_time', 'Update_time', 'Check_time', 'Collation', 'Checksum', 'Create_options', 'Comment'];
    const line = (n) => [n, 'InnoDB', null, 'Dynamic', null, null, null, null, null, null, null, null, null, null, 'utf8mb4_general_ci', null, '', ''];
    if (db === 'information_schema') {
      return result(headers.map((n) => col(n, 'string')), ['schemata', 'tables', 'columns', 'statistics'].map(line));
    }
    const tables = await storeCall(() => dataStore.listTables(session.ownerId, db));
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
    const db = stmt.schema ? await resolveOwned(dataStore, session, stmt.schema) : requireDb(session);
    if (db === 'information_schema') {
      return result([col(`Tables_in_${db}`, 'string')], [['schemata'], ['tables'], ['columns'], ['statistics']]);
    }
    const tables = await storeCall(() => dataStore.listTables(session.ownerId, db));
    const re = stmt.like ? likeToRegExp(stmt.like) : null;
    const names = tables.map((t) => t.name).filter((n) => !re || re.test(n));
    if (stmt.full) return result([col(`Tables_in_${db}`, 'string'), col('Table_type', 'string')], names.map((n) => [n, 'BASE TABLE']));
    return result([col(`Tables_in_${db}`, 'string')], names.map((n) => [n]));
  }

  if (stmt.kind === 'show-index') {
    const db = stmt.schema ? await resolveOwned(dataStore, session, stmt.schema) : requireDb(session);
    if (db === 'information_schema') throw sqlError(1044, 'access denied for database information_schema', '42000');
    const saved = session.database;
    session.database = db;
    try {
    const table = await loadSchema(dataStore, session, stmt.name);
      const headers = ['Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name', 'Collation', 'Cardinality', 'Sub_part', 'Packed', 'Null', 'Index_type', 'Comment', 'Index_comment'];
      const lines = [];
      const pk = table.columns.find((c) => c.primary);
      const push = (key, unique, column, seq) => lines.push([table.name, unique ? 0 : 1, key, seq, column, 'A', null, null, null, '', 'BTREE', '', '']);
      if (pk) push('PRIMARY', true, pk.name, 1);
      for (const ix of table.indexes || []) ix.columns.forEach((c, i) => push(ix.name, ix.unique, c, i + 1));
      return result(headers.map((n, i) => col(n, i === 1 || i === 3 ? 'int' : 'string')), lines);
    } finally { session.database = saved; }
  }

  if (stmt.kind === 'show-columns' || stmt.kind === 'show-create') {
    const db = stmt.schema ? await resolveOwned(dataStore, session, stmt.schema) : requireDb(session);
    if (db === 'information_schema') throw sqlError(1044, 'access denied for database information_schema', '42000');
    const saved = session.database;
    session.database = db;
    try {
    const table = await loadSchema(dataStore, session, stmt.name);
      if (stmt.kind === 'show-create') {
        const body = table.columns.map((c) => {
          const bits = [`  \`${c.name}\` ${columnTypeSql(c)}`];
          if (c.unsigned) bits.push('unsigned');
          if (c.nullable === false || c.primary) bits.push('NOT NULL');
          if (c.autoIncrement) bits.push('AUTO_INCREMENT');
          if (c.default === 'current_timestamp') bits.push('DEFAULT CURRENT_TIMESTAMP');
          else if (c.default != null) bits.push(`DEFAULT ${typeof c.default === 'number' ? c.default : `'${c.default}'`}`);
          if (c.primary) bits.push('PRIMARY KEY');
          return bits.join(' ');
        });
        for (const ix of table.indexes || []) {
          body.push(`  ${ix.unique ? 'UNIQUE KEY' : 'KEY'} \`${ix.name}\` (${ix.columns.map((c) => `\`${c}\``).join(', ')})`);
        }
        return result([col('Table', 'string'), col('Create Table', 'string')], [[table.name, `CREATE TABLE \`${table.name}\` (\n${body.join(',\n')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`]]);
      }
      const rows = table.columns.map((c) => stmt.full
        ? [c.name, columnTypeSql(c), 'utf8mb4_general_ci', c.nullable === false || c.primary ? 'NO' : 'YES', c.primary ? 'PRI' : '', c.default == null ? null : String(c.default), columnExtra(c), '']
        : [c.name, columnTypeSql(c), c.nullable === false || c.primary ? 'NO' : 'YES', c.primary ? 'PRI' : '', c.default == null ? null : String(c.default), columnExtra(c)]);
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
      hit.nullable = false;
    }
    const prim = stmt.columns.filter((c) => c.primary);
    if (prim.length !== 1) throw sqlError(1064, 'a table needs exactly one primary key');
    const indexes = stmt.indexes.slice();
    for (const c of stmt.columns) {
      if (c.unique) indexes.push({ name: c.name, unique: true, columns: [c.name] });
    }
    try {
      await storeCall(() => dataStore.createTable(session.ownerId, db, {
        mysql: true,
        name: stmt.name,
        columns: stmt.columns.map((c) => ({
          name: c.name,
          type: c.type,
          primary: c.primary,
          nullable: c.nullable !== false,
          autoIncrement: c.autoIncrement === true,
          default: c.default === undefined ? null : c.default,
          mysqlType: c.mysqlType,
          unsigned: c.unsigned === true,
        })),
        indexes,
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

  if (stmt.kind === 'alter-table') return applyAlter(dataStore, session, stmt);

  if (stmt.kind === 'create-index' || stmt.kind === 'drop-index') {
    const table = await loadSchema(dataStore, session, stmt.table);
    const columns = copyColumns(table);
    let indexes = copyIndexes(table);
    if (stmt.kind === 'create-index') {
      if (indexes.some((ix) => ix.name === stmt.name)) throw sqlError(1061, `duplicate key name ${stmt.name}`, '42000');
      for (const c of stmt.columns) if (!columns.some((col) => col.name === c)) throw sqlError(1072, `key column ${c} doesn't exist`, '42000');
      const index = { name: stmt.name, unique: stmt.unique === true, columns: stmt.columns };
      await uniqueHolds(dataStore, session, stmt.table, index);
      indexes.push(index);
    } else {
      if (!indexes.some((ix) => ix.name === stmt.name)) throw sqlError(1091, `can't DROP ${stmt.name}; check that key exists`, '42000');
      indexes = indexes.filter((ix) => ix.name !== stmt.name);
    }
    await saveSchema(dataStore, session, stmt.table, columns, indexes);
    return ok();
  }

  if (stmt.kind === 'truncate') {
    const table = await loadSchema(dataStore, session, stmt.name);
    await storeCall(() => dataStore.transact(session.ownerId, session.database, async (tx) => {
      const rows = await tx.listAll(stmt.name);
      for (const row of rows) await tx.deleteRow(stmt.name, row.pk);
      if (table.columns.some((c) => c.autoIncrement)) await tx.setMeta(stmt.name, { ai: 1 });
    }));
    return ok();
  }

  if (stmt.kind === 'rename-table') {
    await storeCall(() => dataStore.renameTable(session.ownerId, requireDb(session), stmt.from, stmt.to));
    return ok();
  }

  if (stmt.kind === 'insert') {
    if (stmt.schema && stmt.schema !== session.database) throw sqlError(1049, `unknown database ${stmt.schema}`, '42000');
    const table = await loadSchema(dataStore, session, stmt.name);
    const tuples = stmt.set ? [stmt.set.map((s) => s.expr)] : stmt.tuples;
    const cols = stmt.set ? stmt.set.map((s) => s.col) : stmt.cols;
    let affected = 0;
    let insertId = 0;
    for (const vals of tuples) {
      const names = cols || table.columns.map((c) => c.name);
      if (names.length !== vals.length) throw sqlError(1136, 'column count does not match value count', '21S01');
      const raw = {};
      for (let i = 0; i < names.length; i++) {
        const column = table.columns.find((c) => c.name === names[i]);
        if (!column) throw sqlError(1054, `unknown column ${names[i]}`, '42S22');
        const v = evalExpr(vals[i], { session, row: null, group: null });
        if (vals[i] && vals[i].def) continue;
        raw[column.name] = v;
      }
      const one = await insertOne(dataStore, session, table, raw, stmt);
      affected += one.affected;
      if (!insertId && one.insertId) insertId = one.insertId;
    }
    return ok(affected, insertId);
  }

  if (stmt.kind === 'update' || stmt.kind === 'delete') {
    if (stmt.schema && stmt.schema !== session.database) throw sqlError(1049, `unknown database ${stmt.schema}`, '42000');
    const table = await loadSchema(dataStore, session, stmt.name);
    let rows = (await readVisible(dataStore, session, table)).map((r) => ({
      pk: r.pk,
      values: r.values,
      parts: { [table.name]: { values: r.values, columns: table.columns } },
    }));
    if (stmt.where) rows = rows.filter((r) => truthy(evalExpr(stmt.where, { session, row: r, group: null })));
    if (stmt.order) {
      rows = [...rows].sort((a, b) => {
        for (const o of stmt.order) {
          const av = evalExpr(o.expr, { session, row: a, group: null });
          const bv = evalExpr(o.expr, { session, row: b, group: null });
          if (cmpValues(av, bv, '<')) return o.desc ? 1 : -1;
          if (cmpValues(av, bv, '>')) return o.desc ? -1 : 1;
        }
        return 0;
      });
    }
    const start = stmt.offset || 0;
    rows = stmt.limit == null ? rows.slice(start) : rows.slice(start, start + stmt.limit);
    const pkCol = primaryOf(table.columns);
    await applyWrites(dataStore, session, table, async (tx) => {
      for (const row of rows) {
        if (stmt.kind === 'delete') { await tx.del(row.pk); continue; }
        const values = { ...row.values };
        for (const set of stmt.set) {
          const column = table.columns.find((c) => c.name === set.col);
          if (!column) throw sqlError(1054, `unknown column ${set.col}`, '42S22');
          if (column.primary) throw sqlError(1235, 'changing the primary key is not supported');
          values[column.name] = coerce(column, evalExpr(set.expr, { session, row, group: null }));
        }
        values[pkCol.name] = row.values[pkCol.name];
        const clash = findConflict(table, tx.rows, values, row.pk);
        if (clash) throw sqlError(1062, 'duplicate entry', '23000');
        await tx.put(row.pk, values);
        const live = tx.rows.find((r) => r.pk === row.pk);
        if (live) live.values = values;
      }
    });
    return ok(rows.length);
  }

  if (stmt.kind === 'select') return runSelect(dataStore, session, stmt);
  throw sqlError(1064, 'unsupported statement');
}

async function enterAccount(dataStore, session) {
  if (!session.database) return;
  await resolveOwned(dataStore, session, session.database);
}

async function forEachStatement(dataStore, session, sql, onResult) {
  await enterAccount(dataStore, session);
  const parts = splitStatements(String(sql));
  if (!parts.length) throw sqlError(1064, 'empty statement');
  for (let i = 0; i < parts.length; i++) {
    const out = await run(dataStore, session, parseStatement(parts[i]));
    await onResult(out, i < parts.length - 1);
  }
}

async function executeSql(dataStore, session, sql) {
  const out = [];
  await forEachStatement(dataStore, session, sql, async (one) => { out.push(one); });
  return out;
}

function newSession({ ownerId, username, database = null }) {
  return {
    ownerId, username, database, autocommit: true, explicitTx: false, overlay: null,
    params: null, statements: new Map(), nextStmt: 1,
  };
}

module.exports = { executeSql, forEachStatement, newSession, sqlError, SERVER_VERSION, splitStatements, tokenize };
