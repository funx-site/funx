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
  `FUNX_USERS`, what can run before a database exists).

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
