'use strict';
// MySQL text protocol in front of one account's logical rows.
// A client connects with host, port, user and password, then sends SQL.
// The bytes land in funx_udata. This does not open a physical database per account.
//
// SCF Web functions only accept HTTP on :9000, so this listener is separate.
// It starts when FUNX_MYSQL_PORT is set, on a process that can accept TCP.

const net = require('net');
const crypto = require('crypto');
const { verifyMysqlUser } = require('./mysql-auth');
const { forEachStatement, newSession, sqlError, SERVER_VERSION, splitStatements } = require('./mysql-sql');

const MAX_PACKET = 0xffffff;
const CAPS = 0x00000001 // LONG_PASSWORD
  | 0x00000002 // FOUND_ROWS
  | 0x00000004 // LONG_FLAG
  | 0x00000008 // CONNECT_WITH_DB
  | 0x00000200 // PROTOCOL_41
  | 0x00002000 // TRANSACTIONS
  | 0x00008000 // SECURE_CONNECTION
  | 0x00010000 // MULTI_STATEMENTS
  | 0x00020000 // MULTI_RESULTS
  | 0x00040000 // PS_MULTI_RESULTS
  | 0x00080000 // PLUGIN_AUTH
  | 0x00100000 // CONNECT_ATTRS
  | 0x00200000 // PLUGIN_AUTH_LENENC_CLIENT_DATA
  | 0x00800000; // SESSION_TRACK
const MULTI_STATEMENTS = 0x00010000;
const DEPRECATE_EOF = 0x01000000;
const CONNECT_WITH_DB = 0x00000008;
const SECURE_CONNECTION = 0x00008000;
const PLUGIN_AUTH_LENENC = 0x00200000;
const PROTOCOL_41 = 0x00000200;

const COM_QUIT = 0x01;
const COM_INIT_DB = 0x02;
const COM_QUERY = 0x03;
const COM_PING = 0x0e;
const COM_STMT_PREPARE = 0x16;
const COM_STMT_EXECUTE = 0x17;
const COM_STMT_CLOSE = 0x19;
const COM_STMT_RESET = 0x1a;
const COM_SET_OPTION = 0x1b;
const COM_STMT_FETCH = 0x1c;
const COM_RESET = 0x1f;

let nextConn = 1;

function scramble20() {
  const b = crypto.randomBytes(20);
  for (let i = 0; i < b.length; i++) if (b[i] === 0) b[i] = 1;
  return b;
}

function lenenc(n) {
  if (n < 251) return Buffer.from([n]);
  if (n < 65536) {
    const b = Buffer.alloc(3);
    b[0] = 0xfc;
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n < 16777216) {
    const b = Buffer.alloc(4);
    b[0] = 0xfd;
    b.writeUIntLE(n, 1, 3);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xfe;
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

function lenencStr(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([lenenc(body.length), body]);
}

function readLenenc(buf, offset) {
  const b = buf[offset];
  if (b == null) return [0, offset];
  if (b < 251) return [b, offset + 1];
  if (b === 0xfc) return [buf.readUInt16LE(offset + 1), offset + 3];
  if (b === 0xfd) return [buf.readUIntLE(offset + 1, 3), offset + 4];
  if (b === 0xfe) return [Number(buf.readBigUInt64LE(offset + 1)), offset + 9];
  return [null, offset + 1];
}

function cstr(buf, offset) {
  const end = buf.indexOf(0, offset);
  const stop = end < 0 ? buf.length : end;
  return { text: buf.toString('utf8', offset, stop), next: end < 0 ? buf.length : end + 1 };
}

function quoteIdent(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function clientHost(socket) {
  const raw = String(socket.remoteAddress || 'localhost').replace(/^::ffff:/, '');
  return raw.replace(/[^A-Za-z0-9.:_-]/g, '').slice(0, 64) || 'unknown';
}

function serverStatus(session, more) {
  let s = session.autocommit ? 2 : 0;
  if (session.overlay) s |= 1;
  if (more) s |= 8;
  return s;
}

function handshakePacket(connId, scramble) {
  const version = Buffer.from(SERVER_VERSION, 'utf8');
  const plugin = Buffer.from('mysql_native_password', 'latin1');
  const payload = Buffer.alloc(68 + version.length);
  let o = 0;
  payload[o++] = 10;
  version.copy(payload, o);
  o += version.length;
  payload[o++] = 0;
  payload.writeUInt32LE(connId, o);
  o += 4;
  scramble.copy(payload, o, 0, 8);
  o += 8;
  payload[o++] = 0;
  payload.writeUInt16LE(CAPS & 0xffff, o);
  o += 2;
  payload[o++] = 45;
  payload.writeUInt16LE(2, o);
  o += 2;
  payload.writeUInt16LE((CAPS >>> 16) & 0xffff, o);
  o += 2;
  payload[o++] = 21;
  o += 10;
  scramble.copy(payload, o, 8, 20);
  o += 12;
  payload[o++] = 0;
  plugin.copy(payload, o);
  o += plugin.length;
  payload[o++] = 0;
  return payload.subarray(0, o);
}

function okPacket(session, affected, more) {
  const aff = lenenc(affected || 0);
  const ins = lenenc(0);
  const b = Buffer.alloc(1 + aff.length + ins.length + 4);
  b[0] = 0x00;
  aff.copy(b, 1);
  ins.copy(b, 1 + aff.length);
  const o = 1 + aff.length + ins.length;
  b.writeUInt16LE(serverStatus(session, more), o);
  b.writeUInt16LE(0, o + 2);
  return b;
}

function errPacket(errno, sqlState, message) {
  const msg = Buffer.from(String(message || 'error').slice(0, 512), 'utf8');
  const state = Buffer.from(String(sqlState || 'HY000').padEnd(5, '0').slice(0, 5), 'ascii');
  const b = Buffer.alloc(9 + msg.length);
  b[0] = 0xff;
  b.writeUInt16LE(errno & 0xffff, 1);
  b[3] = 0x23;
  state.copy(b, 4);
  msg.copy(b, 9);
  return b;
}

function eofPacket(status, deprecate) {
  if (deprecate) {
    const b = Buffer.alloc(7);
    b[0] = 0xfe;
    b.writeUInt16LE(status, 3);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt16LE(status, 3);
  return b;
}

function columnPacket(column, schema, table) {
  let type = 0xfd;
  let charset = 45;
  let length = 1020;
  let flags = 0;
  if (column.type === 'int') { type = 0x08; charset = 63; length = 20; flags |= 32768; }
  else if (column.type === 'bool') { type = 0x01; charset = 63; length = 1; flags |= 32768; }
  else if (column.type === 'json') { type = 0xf5; charset = 63; length = 0xffffff; }
  if (column.primary) flags |= 3;
  const fixed = Buffer.alloc(13);
  fixed[0] = 0x0c;
  fixed.writeUInt16LE(charset, 1);
  fixed.writeUInt32LE(length, 3);
  fixed[7] = type;
  fixed.writeUInt16LE(flags, 8);
  fixed[10] = 0;
  return Buffer.concat([
    lenencStr('def'),
    lenencStr(schema || ''),
    lenencStr(table || ''),
    lenencStr(table || ''),
    lenencStr(column.name),
    lenencStr(column.name),
    fixed,
  ]);
}

function textCell(value) {
  if (value == null) return Buffer.from([0xfb]);
  return lenencStr(typeof value === 'string' ? value : String(value));
}

function parseClientHello(payload) {
  if (payload.length < 33 || (payload.readUInt32LE(0) & PROTOCOL_41) === 0) return null;
  const flags = payload.readUInt32LE(0);
  let o = 32;
  const user = cstr(payload, o);
  o = user.next;
  let token;
  if (flags & PLUGIN_AUTH_LENENC) {
    const [len, next] = readLenenc(payload, o);
    const n = len == null ? 0 : len;
    token = payload.subarray(next, next + n);
    o = next + n;
  } else if (flags & SECURE_CONNECTION) {
    const n = payload[o] || 0;
    token = payload.subarray(o + 1, o + 1 + n);
    o += 1 + n;
  } else {
    const raw = cstr(payload, o);
    token = Buffer.from(raw.text, 'utf8');
    o = raw.next;
  }
  let database = '';
  if ((flags & CONNECT_WITH_DB) && o < payload.length) {
    const db = cstr(payload, o);
    database = db.text;
  }
  return { flags, user: user.text, token: Buffer.from(token), database };
}

function createReader(socket) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  let closed = false;
  const wake = () => { if (waiting) { const w = waiting; waiting = null; w(); } };
  socket.on('data', (chunk) => { buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; wake(); });
  socket.on('error', () => { closed = true; wake(); });
  socket.on('end', () => { closed = true; wake(); });
  socket.on('close', () => { closed = true; wake(); });
  async function need(n) {
    while (buf.length < n) {
      if (closed) return false;
      await new Promise((resolve) => { waiting = resolve; });
    }
    return true;
  }
  return {
    async read() {
      const parts = [];
      let seq = 0;
      for (;;) {
        if (!(await need(4))) return null;
        const len = buf[0] | (buf[1] << 8) | (buf[2] << 16);
        seq = buf[3];
        if (!(await need(4 + len))) return null;
        parts.push(Buffer.from(buf.subarray(4, 4 + len)));
        buf = buf.subarray(4 + len);
        if (len < MAX_PACKET) break;
      }
      return { seq, payload: parts.length === 1 ? parts[0] : Buffer.concat(parts) };
    },
  };
}

function writeBuf(socket, data) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(sqlError(1053, 'connection closed', '08S01')); return; }
    socket.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

async function send(socket, seq, payload) {
  let off = 0;
  do {
    const n = Math.min(payload.length - off, MAX_PACKET);
    const frame = Buffer.allocUnsafe(4 + n);
    frame[0] = n & 0xff;
    frame[1] = (n >>> 8) & 0xff;
    frame[2] = (n >>> 16) & 0xff;
    frame[3] = seq & 0xff;
    payload.copy(frame, 4, off, off + n);
    await writeBuf(socket, frame);
    off += n;
    seq = (seq + 1) & 0xff;
  } while (off < payload.length);
  if (payload.length > 0 && payload.length % MAX_PACKET === 0) {
    const frame = Buffer.alloc(4);
    frame[3] = seq & 0xff;
    await writeBuf(socket, frame);
    seq = (seq + 1) & 0xff;
  }
  return seq;
}

async function sendErr(socket, seq, errno, message, sqlState) {
  await send(socket, seq, errPacket(errno, sqlState, message));
}

async function writeResult(socket, seq, session, result, more, flags) {
  const deprecate = (flags & DEPRECATE_EOF) !== 0;
  if (result.kind === 'ok') return send(socket, seq, okPacket(session, result.affectedRows, more));
  const schema = session.database || '';
  seq = await send(socket, seq, lenenc(result.columns.length));
  for (const column of result.columns) seq = await send(socket, seq, columnPacket(column, schema, ''));
  if (!deprecate) seq = await send(socket, seq, eofPacket(serverStatus(session, false), false));
  for (const row of result.rows) seq = await send(socket, seq, Buffer.concat(row.map(textCell)));
  return send(socket, seq, eofPacket(serverStatus(session, more), deprecate));
}

function makeThrottle() {
  const hits = new Map();
  return {
    blocked(key) {
      const h = hits.get(key);
      if (!h) return false;
      if (Date.now() - h.t >= 10 * 60 * 1000) { hits.delete(key); return false; }
      return h.n >= 8;
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || Date.now() - h.t >= 10 * 60 * 1000) hits.set(key, { n: 1, t: Date.now() });
      else h.n += 1;
    },
  };
}

async function commandLoop(socket, reader, dataStore, session, flags) {
  for (;;) {
    const pkt = await reader.read();
    if (!pkt || pkt.payload.length === 0) return;
    const cmd = pkt.payload[0];
    let seq = (pkt.seq + 1) & 0xff;
    if (cmd === COM_QUIT) return;
    if (cmd === COM_PING || cmd === COM_STMT_CLOSE || cmd === COM_STMT_RESET) {
      await send(socket, seq, okPacket(session, 0, false));
      continue;
    }
    if (cmd === COM_SET_OPTION) {
      await send(socket, seq, eofPacket(serverStatus(session, false), false));
      continue;
    }
    if (cmd === COM_RESET) {
      session.database = null;
      session.autocommit = true;
      session.explicitTx = false;
      session.overlay = null;
      await send(socket, seq, okPacket(session, 0, false));
      continue;
    }
    if (cmd === COM_INIT_DB) {
      const name = cstr(pkt.payload, 1).text;
      try {
        await forEachStatement(dataStore, session, `USE ${quoteIdent(name)}`, async () => {});
        await send(socket, seq, okPacket(session, 0, false));
      } catch (e) {
        const err = e && e.errno ? e : sqlError(1105, 'internal error', 'HY000');
        await sendErr(socket, seq, err.errno, err.message, err.sqlState);
      }
      continue;
    }
    if (cmd === COM_QUERY) {
      const sql = pkt.payload.subarray(1).toString('utf8');
      try {
        const parts = splitStatements(sql);
        if (!parts.length) throw sqlError(1064, 'empty statement');
        if (parts.length > 1 && (flags & MULTI_STATEMENTS) === 0) {
          throw sqlError(1064, 'multi-statement queries are disabled for this connection');
        }
        await forEachStatement(dataStore, session, sql, async (result, more) => {
          seq = await writeResult(socket, seq, session, result, more, flags);
        });
      } catch (e) {
        const err = e && e.errno ? e : sqlError(1105, 'internal error', 'HY000');
        await sendErr(socket, seq, err.errno, err.message, err.sqlState);
      }
      continue;
    }
    if (cmd === COM_STMT_PREPARE || cmd === COM_STMT_EXECUTE || cmd === COM_STMT_FETCH) {
      await sendErr(socket, seq, 1295, 'prepared statements are not supported; send the SQL text', 'HY000');
      continue;
    }
    await sendErr(socket, seq, 1047, 'unknown command', '08S01');
  }
}

async function handleSocket(socket, dataStore, throttle) {
  socket.setNoDelay(true);
  socket.setKeepAlive(true, 60000);
  socket.setTimeout(15 * 60 * 1000, () => socket.destroy());
  const reader = createReader(socket);
  const connId = nextConn++;
  const scramble = scramble20();
  try {
    await send(socket, 0, handshakePacket(connId >>> 0, scramble));
    const hello = await reader.read();
    if (!hello) return;
    const seq = (hello.seq + 1) & 0xff;
    if (hello.payload.length <= 32) {
      await sendErr(socket, seq, 2026, 'TLS is not enabled on this port', 'HY000');
      return;
    }
    const client = parseClientHello(hello.payload);
    const host = clientHost(socket);
    if (!client || throttle.blocked(host)) {
      await sendErr(socket, seq, 1045, `Access denied for user '${client ? client.user : ''}'@'${host}' (using password: YES)`, '28000');
      return;
    }
    const auth = await verifyMysqlUser(dataStore, client.user, scramble, client.token);
    if (!auth) {
      throttle.fail(host);
      const using = client.token.length ? 'YES' : 'NO';
      await sendErr(socket, seq, 1045, `Access denied for user '${client.user}'@'${host}' (using password: ${using})`, '28000');
      return;
    }
    const session = newSession({ ownerId: auth.ownerId, username: auth.username });
    session.connectionId = connId;
    if (client.database) {
      try {
        await forEachStatement(dataStore, session, `USE ${quoteIdent(client.database)}`, async () => {});
      } catch (e) {
        const err = e && e.errno ? e : sqlError(1049, `unknown database ${client.database}`, '42000');
        await sendErr(socket, seq, err.errno, err.message, err.sqlState);
        return;
      }
    }
    await send(socket, seq, okPacket(session, 0, false));
    await commandLoop(socket, reader, dataStore, session, client.flags);
  } catch {
    // The client went away, or a write failed. Nothing to send.
  } finally {
    socket.destroy();
  }
}

function startMysqlGateway({ dataStore, port = 0, bindHost = '127.0.0.1' } = {}) {
  if (!dataStore) throw new Error('dataStore is required');
  const throttle = makeThrottle();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handleSocket(socket, dataStore, throttle).catch(() => {});
  });
  return new Promise((resolve, reject) => {
    const fail = (err) => reject(err);
    server.once('error', fail);
    server.listen(port, bindHost, () => {
      server.off('error', fail);
      const addr = server.address();
      resolve({
        port: addr.port,
        host: bindHost,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}

module.exports = { startMysqlGateway };
