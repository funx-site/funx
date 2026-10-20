# Logical databases

An account is given one database, named `db`. That does not create a MySQL database, a user, or a machine. Funx keeps a fixed set of physical databases (one today) and stores every user row in a single table. The account does not create, drop, or switch databases. Table statements run inside `db`.

This is not `env.DB` and not a D1 binding. Worker code does not receive a database handle. An account connects the way it would connect to any other cloud MySQL: host, port, user, password, and the database name `db`. Those statements read and write the same `funx_udata` rows as the HTTP API. The database is one catalog row. It does not create a physical database.

The MySQL listener is a TCP port on the API process (`FUNX_MYSQL_PORT`, bound on `0.0.0.0`). The host printed in connection strings is `FUNX_MYSQL_HOST` (default `127.0.0.1`). SCF Web functions only accept HTTP on `:9000`, so that HTTP port is not the MySQL port. Turn the listener on where the process can accept TCP. The wire protocol is MySQL with `mysql_native_password`, including prepared statements. TLS is offered when the client asks; set `FUNX_MYSQL_TLS_CERT` and `FUNX_MYSQL_TLS_KEY`, or the process generates a self-signed certificate. See [API.md](API.md) for the SQL that works and the parts that answer with an error.

## Tables

Catalog and rows for node 0 live in the existing `funx` database, created on first use with `CREATE TABLE IF NOT EXISTS`.

| Table | Role |
| --- | --- |
| `funx_data_nodes` | Physical databases. Seeded row: `(0, '<FUNX_DB_NAME>', 'active')`. |
| `funx_udb` | One logical database. `owner_id` is the account id (`VARCHAR(64)`). `node_id` is where its rows live. `ddl_version` increments when a table is created or dropped. |
| `funx_utbl` | One logical table. `columns_json` is the schema. Names are unique per logical database. |
| `funx_udata` | **All user rows**, on the node that owns them. Primary key `(udb_id, utbl_id, pk)`. |

`funx_udata.pk` is a non-empty string of at most 255 characters. A string primary key is stored as itself, so `ORDER BY pk` and `pk > ?` use that index and HTTP cursors stay stable. An integer primary key is stored as a sortable encoding of the number; the value a client sees is still the integer. A hidden row whose primary key is a single NUL byte holds auto-increment and unique-index metadata for tables that need it. Other column values live in `doc`. The HTTP API accepts only a string primary key. The MySQL path also accepts integer keys, `DOUBLE`, `DECIMAL`, `DATETIME`, and `BLOB`.

A point read is:

```sql
SELECT doc FROM funx_udata WHERE udb_id = ? AND utbl_id = ? AND pk = ?
```

A list is the same prefix, `ORDER BY pk LIMIT ?`. The client never sends `udb_id`. The API resolves the caller's name to an id, then reads only that id.

## Nodes

`node_id` is written once, on `funx_udb`, and is not updated when another physical database appears.

* An account's later databases copy `node_id` from its earliest one, including when that node is `closed`.
* An account with no database yet is placed by SHA-256 of `owner_id` onto the nodes whose `status` is `active`.
* `closed` still serves the databases already placed there. It is left out of placement for new accounts.
* The process only talks to pools it has mounted. A catalog row with no pool fails the call (`node_unmounted`) instead of writing the catalog and losing the rows.

Node 0 is the pool `funx-api` already uses. `MysqlDataStore` runs `funx_udata`'s DDL on every other mounted pool. Catalog tables stay on the catalog pool, so listing databases does not scan every physical database.

Adding a physical database later, without moving anything already stored:

1. Create one empty schema. This stays a fixed operator step, not something registration does.
2. Construct `MysqlDataStore` with that pool in `nodes`, for example `nodes: { 1: pool1 }`. Startup creates `funx_udata` there.
3. Insert `(1, '<schema>', 'active')` into `funx_data_nodes`.

Existing logical databases keep their `node_id` and stay on the old pool. New accounts land on the updated active set. Moving a logical database later means copying its `funx_udata` prefix to the destination pool, then updating `node_id`. That move is not implemented.

## Limits

32 is the catalog ceiling per account. The account-facing API gives each account one database, `db`, and does not accept a second. 64 tables per database, 128 columns per table, 100 rows per list call. The HTTP API caps a row at 32 KB and accepts only `name`, `type`, and `primary` on a column. The MySQL path caps a row at 4 MB and stores defaults, nullability, auto-increment, and indexes in `columns_json`. Non-unique indexes are metadata for `SHOW INDEX`; a `UNIQUE` index is enforced. `ALTER TABLE`, `TRUNCATE`, `RENAME TABLE`, and `CREATE`/`DROP INDEX` change that schema. They do not create another database.

## Platform database

Funx's own accounts, setup tokens, workers, versions and bindings are rows in this same table. They live in one logical database: owner `funx`, name `platform`. There is no `funx_users` table and no `funx_workers` table.

| Logical table | Primary key | Holds |
| --- | --- | --- |
| `users` | account id | email, password hash, role |
| `user_emails` | normalized email | account id, so login is a point read |
| `setup_tokens` | token sha256 | expiry and the time it was used |
| `workers` | worker name | owner, disabled, current version |
| `worker_versions` | `<name>@<version>` | the bundle |
| `worker_bindings` | `<name>@<KEY>` | a var, or a sealed secret |
| `mysql_accounts` | MySQL user name | the account id and the `mysql_native_password` hash |

`GET /v1/mysql` returns the host, port, user and the database name `db`. `POST /v1/mysql` rotates the password and returns it once. The platform owner `funx` has no MySQL login. `CREATE DATABASE`, `DROP DATABASE`, and `USE` of any other name are refused.

A worker name is `a-z`, `0-9` and `-`, so it never contains `@`. A prefix scan of `<name>@` stays on that worker's range of the clustered index.

`/v1/databases` answers 404 when the caller id is `funx`, so this database is not one an account can open or delete.

Public row writes stay at 32 KB. A worker version is written with a 4 MB ceiling, because source can be 1 MB and JSON quoting needs room. That ceiling is not on the public API.
