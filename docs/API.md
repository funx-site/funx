# funx-api (v1)

SCF Web function `funx-api`, ap-hongkong, tag `codename=funx`, runs with role `<api-role>`.
JSON in, JSON out. Auth: `Authorization: Bearer <Funx token>`. **No cookies are ever set or read.**
CORS: only `FUNX_CONSOLE_ORIGINS` (default `https://funx.demox.site`, `http://localhost[:port]`); no credentials mode.

## Accounts and tokens

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/v1/auth/register` | `{email, password}` (≥10 chars) | 201 `{token, expires_at, user}`; 403 `signup_closed` unless `FUNX_SIGNUP=open` |
| POST | `/v1/auth/login` | `{email, password}` | 200 `{token, expires_at, user}`; 401 `bad_login`; 429 after 8 misses / 10 min |
| GET | `/v1/me` | | `{user}` |
| GET | `/.well-known/jwks.json` | | public keys (`kid`, ES256) |

- Passwords: scrypt (N=16384, r=8, p=1, 16-byte salt), stored as `scrypt$N$r$p$salt$hash`. Unknown emails
  are checked against a dummy hash so timing does not reveal which emails exist.
- Tokens: ES256 JWT, header `kid`, claims `iss=funx aud=funx-api sub email role iat exp jti`, 12 h.
  Only Funx-signed tokens are accepted (no other issuer). Rotation: put the new private JWK first in
  `FUNX_JWT_KEYS`, keep the old one (private or public part) after it until 12 h have passed.
- Refresh tokens: not yet. Planned as random strings stored hashed in the user store (needs a DB).
- User store is pluggable (`api/users.js`): `MemoryUserStore` (tests), `EnvUserStore` (read-only list in
  `FUNX_USERS`, what can run before a database exists). Production stores accounts in the platform logical
  database ([DATA.md](DATA.md)), in the same `funx_udata` rows as every other database.

## Workers

`:name` = 3-32 of `a-z 0-9 -`; reserved: api auth www admin app console status mail. Users see only workers
whose `funx-owner` tag is their user id; `role=admin` sees all.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/v1/workers` | | `[{name, url, status, disabled, routed, last_deploy}]` (`last_deploy` is SCF ModTime, UTC+8) |
| POST | `/v1/workers` | `{name, code?}` | create; starter worker if no code; 409 if taken |
| GET | `/v1/workers/:name` | | `{name, url, status, disabled, owner, runtime, modTime, vars, secrets[names]}` |
| DELETE | `/v1/workers/:name` | | router entry, domain, function |
| GET | `/v1/workers/:name/code` | | `{entry, code, files}` (downloads the package via GetFunctionAddress) |
| PUT | `/v1/workers/:name/code` | `{code}` | update code (= deploy) |
| POST | `/v1/workers/:name/deploy` | `{code}` or `{files: {path: base64}}` | create or update |
| POST | `/v1/workers/:name/disable` / `enable` | | kill switch (router 403 + function URL closed) |
| GET/PUT | `/v1/workers/:name/vars` | `{vars: {K: "v"}}` | plain variables (values returned) |
| DELETE | `/v1/workers/:name/vars/:K` | | |
| GET | `/v1/workers/:name/secrets` | | names only |
| PUT/DELETE | `/v1/workers/:name/secrets/:K` | `{value}` | value is never returned |
| GET | `/v1/workers/:name/logs` | | 501 `logs_unavailable` until the role can read logs |
| POST | `/v1/workers/:name/invoke` | `{method, path, headers, body}` | server-side request to `https://<name>.funx.run<path>` only; `{status, headers, body, bodyEncoding, ms, size}` |

Deploy responses carry `domain: "pending"` while funx-api may not create SCF custom domains
(`FUNX_MANAGE_DOMAINS` unset); an operator then runs the custom-domain step.

Errors: `{error, message}`. Cloud permission errors become 502 `platform_permission` (code only logged).
Writes are serialized inside one instance (router map is read-modify-write); set the function's
reserved concurrency to 1 until the map moves out of the router env.

## Databases

Not a worker binding. An account's rows live in one physical table, shared by every account, and the account reaches them over MySQL or over HTTP. See [DATA.md](DATA.md) for the node model (how a later physical database is added without moving existing ones).

### MySQL

`FUNX_MYSQL_PORT` starts a MySQL listener on the API process. `FUNX_MYSQL_HOST` is the host in the connection string. The password is shown only when it is rotated.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/v1/mysql` | | `{host, port, user, password_set, database, databases, uri}` — `database` is `db`; `uri` has no password |
| POST | `/v1/mysql` | `{}` | rotates the password; the password is in this response only |

404 when the listener is not configured, or when the caller is the platform owner. The MySQL user is the account id when that id is 1–32 characters of letters, digits and `_`. Otherwise it is `f` plus 31 hex characters of the id's SHA-256.

A client uses the MySQL protocol and `mysql_native_password` (the `mysql` CLI, a GUI, or an application connection string). Prepared statements (`COM_STMT_PREPARE` / `COM_STMT_EXECUTE`) return binary rows. If the client asks for TLS, the server completes the handshake with `FUNX_MYSQL_TLS_CERT` and `FUNX_MYSQL_TLS_KEY`, or with a self-signed certificate generated at startup. A client that verifies certificates against a public CA will refuse that certificate. Example, after `POST /v1/mysql`:

```
mysql -h <host> -P <port> -u <user> -p db
```

The session is already in `db`. `CREATE DATABASE`, `DROP DATABASE`, and `USE` of another name answer with an error. `SHOW DATABASES` returns `db`.

What works inside that database: `CREATE`/`DROP`/`ALTER`/`RENAME`/`TRUNCATE TABLE` (including `ENGINE`, charset, `AUTO_INCREMENT`, `DEFAULT`, `NOT NULL`, `UNIQUE`, `ADD`/`DROP COLUMN`, and secondary `KEY`s), `CREATE`/`DROP INDEX`, `INSERT`, `REPLACE`, `ON DUPLICATE KEY UPDATE`, `UPDATE`, `DELETE`, and `SELECT` with `JOIN`, `WHERE` (`AND`, `OR`, `NOT`, `IN`, `LIKE`, `BETWEEN`), `GROUP BY` (`COUNT`, `SUM`, `MIN`, `MAX`, `AVG`), `ORDER BY`, and `LIMIT`. Primary keys may be `VARCHAR` or an integer. Column types on this path: `VARCHAR`/`TEXT`, `INT`/`BIGINT` (safe integer), `BOOL`, `DOUBLE`, `DECIMAL`, `DATETIME`/`TIMESTAMP`, `JSON`, and `BLOB`. `SHOW TABLES`/`COLUMNS`/`INDEX`/`CREATE TABLE`/`VARIABLES`/`TABLE STATUS`, `DESCRIBE`, and `information_schema` for this database's tables, columns, and statistics. `SET NAMES` and `SET autocommit` are accepted. A row written over MySQL may be up to 4 MB. Autocommit is on until the session turns it off; `BEGIN` keeps the change in the session until `COMMIT` or `ROLLBACK`. `UNIQUE` is checked again at `COMMIT`.

What answers with an error: anything above the database (creating, dropping, or switching databases), stored procedures, triggers, views, subqueries, `UNION`, window functions, and a composite primary key. Changing a column's storage type is refused. The HTTP API does not grow with this surface: it still allows only a string primary key and `string`, `int`, `bool`, `json`, and it still caps a row at 32 KB. HTTP does not create or delete the database.

### HTTP

`:name` and `:table` are 1-64 chars of `a-z`, `0-9` or `_`, starting with a letter. One primary column, type `string`. Other columns: `string`, `int` (safe integer), `bool`, `json`. A write replaces the whole row; omitted columns become null. Rows are capped at 32 KB. List order is the raw bytes of the primary key.

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET | `/v1/databases` | | `{databases: [{name, owner, node_id, ddl_version, created_at}]}` — the one database, `db` |
| GET | `/v1/databases/db` | | that database. Any other name is 404 |
| DELETE | `/v1/databases/:name` | | 405. The database is not dropped |
| GET | `/v1/databases/db/tables` | | `{tables: [{name, columns, created_at}]}` |
| POST | `/v1/databases/db/tables` | `{name, columns: [{name, type, primary?}]}` | exactly one `primary: true` column; unknown column properties are rejected |
| GET | `/v1/databases/db/tables/:table` | | |
| DELETE | `/v1/databases/db/tables/:table` | | |
| GET | `/v1/databases/db/tables/:table/rows` | | `?limit=` (1-100, default 50) `&after=<pk>`; `{rows, next}` |
| PUT | `/v1/databases/db/tables/:table/rows/:pk` | `{column: value}` | 201 on insert, 200 on replace; `{created, pk, values, updated_at}` |
| GET | `/v1/databases/db/tables/:table/rows/:pk` | | |
| DELETE | `/v1/databases/db/tables/:table/rows/:pk` | | |

`node_id` is which physical database holds the rows. It is chosen when the account's database is created and stays there. `:pk` is one URL path segment (`encodeURIComponent`). `POST /v1/databases` is not accepted.
