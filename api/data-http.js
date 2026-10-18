'use strict';
// HTTP for logical databases. Mounted only when funx-api was given a data store.
// Accounts see their own rows. A missing name and someone else's name are both 404.

const { dataError } = require('./data-store');

const STATUS = {
  bad_name: 400,
  bad_schema: 400,
  bad_row: 400,
  bad_query: 400,
  exists: 409,
  quota: 409,
  not_found: 404,
  node_unmounted: 503,
};

function asHttp(HttpError, e) {
  const status = e && STATUS[e.code];
  return status ? new HttpError(status, e.code, e.message) : null;
}

async function handleDatabases({ dataStore, user, method, parts, body, query, HttpError }) {
  try {
    return await dispatch({ dataStore, user, method, parts, body, query, HttpError });
  } catch (e) {
    const http = asHttp(HttpError, e);
    if (http) throw http;
    throw e;
  }
}

async function dispatch({ dataStore, user, method, parts, body, query, HttpError }) {
  const ownerId = user.id;
  if (!parts.length) {
    if (method === 'GET') return [200, { databases: await dataStore.listDatabases(ownerId) }];
    if (method === 'POST') return [201, await dataStore.createDatabase({ ownerId, name: body.name })];
    throw new HttpError(405, 'method_not_allowed');
  }

  const name = parts[0];
  if (parts.length === 1) {
    if (method === 'GET') {
      const db = await dataStore.getDatabase(ownerId, name);
      if (!db) throw dataError('not_found', `no database named ${name}`);
      return [200, db];
    }
    if (method === 'DELETE') return [200, await dataStore.deleteDatabase(ownerId, name)];
    throw new HttpError(405, 'method_not_allowed');
  }

  if (parts[1] !== 'tables') throw new HttpError(404, 'not_found');
  if (parts.length === 2) {
    if (method === 'GET') return [200, { tables: await dataStore.listTables(ownerId, name) }];
    if (method === 'POST') return [201, await dataStore.createTable(ownerId, name, { name: body.name, columns: body.columns })];
    throw new HttpError(405, 'method_not_allowed');
  }

  const table = parts[2];
  if (parts.length === 3) {
    if (method === 'GET') {
      const t = await dataStore.getTable(ownerId, name, table);
      if (!t) throw dataError('not_found', `no table named ${table}`);
      return [200, t];
    }
    if (method === 'DELETE') return [200, await dataStore.deleteTable(ownerId, name, table)];
    throw new HttpError(405, 'method_not_allowed');
  }

  if (parts[3] !== 'rows') throw new HttpError(404, 'not_found');
  if (parts.length === 4) {
    if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
    return [200, await dataStore.listRows(ownerId, name, table, {
      limit: query.has('limit') ? query.get('limit') : null,
      after: query.has('after') ? query.get('after') : null,
    })];
  }
  if (parts.length !== 5) throw new HttpError(404, 'not_found');

  const pk = parts[4];
  if (method === 'GET') {
    const row = await dataStore.getRow(ownerId, name, table, pk);
    if (!row) throw dataError('not_found', 'no such row');
    return [200, row];
  }
  if (method === 'PUT') {
    const out = await dataStore.putRow(ownerId, name, table, pk, body);
    return [out.created ? 201 : 200, { created: out.created, ...out.row }];
  }
  if (method === 'DELETE') {
    if (!(await dataStore.deleteRow(ownerId, name, table, pk))) throw dataError('not_found', 'no such row');
    return [200, { deleted: pk }];
  }
  throw new HttpError(405, 'method_not_allowed');
}

module.exports = { handleDatabases };
