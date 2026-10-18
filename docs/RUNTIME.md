# Funx shared runtime (v2): code in MySQL, one runtime function, one V8 isolate per worker

Status: design + local implementation (2026-10-10). Nothing of this is deployed yet except the isolated-vm
load test function `funx-ivm-test` (HK). Binding requirements from 云架构 + Chief are marked **[R1]..[R7]**.

## Why

v1 created one SCF function per worker (`funx-u-<name>`) behind `funx-router`. Every deploy was an SCF API
call with its own permission surface (tags, PassRole, triggers that can't be closed, log delivery per function).
v2 removes per-worker cloud resources: a deploy is a row in MySQL, and one runtime function serves every
`<name>.funx.run`.

## Components

```
browser / CLI ──Bearer JWT──> funx-api (GZ, VPC, MySQL)  ── stores code, vars, encrypted secrets
                                   ▲
                                   │ HTTPS, runtime token only      (GET /v1/runtime/workers/<name>)
                                   │
visitor ──https://<name>.funx.run──> funx-runtime (HK, *.funx.run custom domain)
                                      └ one isolated-vm isolate per worker (64 MB, CPU + wall limits)
```

### funx-api (GZ) — the only place with secrets
* Tables (created on cold start, `CREATE TABLE IF NOT EXISTS`):
  * `funx_workers(name PK, owner_id, disabled, current_version, created_at, updated_at)`
  * `funx_worker_versions(name, version CHAR(64) = sha256 of the canonical bundle, entry, bundle MEDIUMTEXT JSON
    {path: source}, size, created_at, created_by)`; PK (name, version). Deploying the same bundle twice reuses the
    version. Old versions are kept (rollback = point `current_version` back), pruned to the last 10.
  * `funx_worker_bindings(name, kind 'var'|'secret', bkey, value TEXT NULL, ciphertext BLOB NULL)`; PK (name, bkey).
* Secrets are encrypted with AES-256-GCM, key `FUNX_SECRETS_KEY` (32 random bytes, base64) held **only in
  funx-api's env** **[R1]**; AAD = `funx-secret:v1:<worker>:<KEY>` so a ciphertext can't be moved to another worker
  or key. The API never returns secret values to users (names only), as before.
* Kill switch = `funx_workers.disabled` flag. `disable` takes effect at the runtime within the cache TTL (≤ 5 s).
* Runtime endpoint **[R2]**: `GET /v1/runtime/workers/<name>` (optional `?have=<version>` -> `{unchanged: true, disabled}`
    without code or env when the version is current).
  * Accepts only `Authorization: Bearer <runtime token>`. funx-api stores only its SHA-256
    (`FUNX_RUNTIME_TOKEN_SHA256`) and compares with `timingSafeEqual`. Anything JWT-shaped is rejected before
    any lookup, so a user token (even an admin's) never works here; a missing/wrong token is 401 for every
    name (no existence oracle). No CORS headers on this route, so browsers can't use it.
  * Returns `{ name, version, disabled, entry, bundle, env }`, where `env` = that worker's vars + **decrypted
    secrets of that worker only**. Nothing of other workers, no keys.
  * Throttled per instance; every call logged as `{rt: name, s: status}` (no values).

### funx-runtime (HK) — no role, no secrets of its own
* SCF Web function, Nodejs18.15, **no Role, no VPC** **[R1]**, tag `codename=funx`, behind the `*.funx.run`
  custom domain (replaces `funx-router` + all `funx-u-*`). Single concurrency per instance (SCF default; we
  do **not** enable multi-concurrency) **[R4]**: one request at a time per instance, so one worker's slowness
  can't stall another's request in the same process, only queue behind it on that instance.
* Env holds exactly one value: `FUNX_RUNTIME_TOKEN` (the code-fetch token) **[R1]**. funx-api URL and
  `baseDomain` are build-time constants in `runtime/config.json` (not secret). The token is read once and
  deleted from `process.env`.
* Request flow: Host -> worker name (`lib/names.parseHost`) -> config cache -> isolate cache -> `fetch(req, env, ctx)`.
  * Config cache: per name `{version, disabled, env, fetchedAt}`; revalidated with `?have=` after 5 s;
    negative (404) cached 5 s. If funx-api is unreachable a cached config may serve up to 60 s (stale), then 503.
  * Isolate cache: key = `name@version`. **One isolate per worker, never shared** between workers **[R6]**;
    a new version gets a fresh isolate. LRU eviction by count (≤ 16) and by total heap (≤ 512 MB of the 1 GB
    function, measured with `getHeapStatistics`); an isolate that hit its memory limit is disposed and rebuilt.
* Limits per request **[R6]**: isolate heap 64 MB; CPU 50 ms per request (isolate `cpuTime`), wall 30 s;
  50 subrequests; request body 1 MB; response body 10 MB; console output 4 KB/line, 50 lines.

### Inside the isolate (the whole API surface) **[R7]**
Workers module syntax: `export default { async fetch(request, env, ctx) { ... } }`, ES modules with relative
imports between the uploaded files (`.js`, `.mjs`; `.json` imported as its default export). Exposed globals:
`Request`, `Response`, `Headers`, `URL`, `URLSearchParams`, `fetch`, `crypto.getRandomValues`,
`crypto.randomUUID`, `TextEncoder`, `TextDecoder`, `atob`, `btoa`, `console`, `setTimeout`/`clearTimeout`
(bounded by the wall limit), `structuredClone` (JSON-only). `env` = vars + secrets as strings. `ctx.waitUntil(p)`
is awaited before the instance answers the next request (bounded by the wall limit);
`ctx.passThroughOnException()` is a no-op. **Not** available: Node APIs, `require`, `process`, `Buffer`, fs,
timers beyond the wall limit, streaming bodies (bodies are buffered), WebSocket, Cache API, KV/D1/R2/DO.
Logical databases ([docs/DATA.md](DATA.md)) are rows in funx-api, not a binding inside the isolate.
The same worker code runs unchanged on Cloudflare Workers / workerd, so swapping the runtime to workerd later
changes only `funx-runtime`, not funx-api, the CLI or the console.

Host bridges are `ivm.Reference`s to small host functions: URL parsing (pure), random bytes, console, sleep,
and `fetch`. Data crosses only as copies (strings / ArrayBuffers); no host object is ever handed to the isolate.

### Worker `fetch()` egress **[R3]**
* Only `http:`/`https:`; default ports or 80/443/8080/8443.
* DNS is resolved by the runtime first (`dns.lookup`, all addresses); the connection is then pinned to the
  checked address (custom `lookup`), so DNS rebinding between check and connect doesn't work.
* Blocked: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`,
  `198.18/15`, `224/4`, `240/4`, `::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, IPv4-mapped/compatible IPv6
  (`::ffff:a.b.c.d` is checked as `a.b.c.d`), NAT64 `64:ff9b::/96`, and funx-api's own host (by name and by its
  resolved addresses). IP literals are checked the same way.
* Redirects are followed manually (≤ 5), each hop re-validated and re-resolved. Timeout 15 s per hop.
* Request headers `host`, `x-funx-*` and hop-by-hop headers are dropped; responses capped at 10 MB.

### Deploy / CLI / console
`POST /v1/workers/<name>/deploy` (unchanged path) stores the bundle and moves `current_version`; no SCF calls.
`funx dev` keeps the local Node shim (fast reload); running it under the real sandbox is a follow-up.
Console and CLI UX are unchanged; the console's URL/test/deploy flows hit the same endpoints. In v2 the old
operator commands that call SCF per worker (`funx deploy/disable/...` with STS) are replaced by the same
endpoints on funx-api; logs stay "not available yet" (501) until a runtime log view exists.

### Build / deploy (not done yet)
* `funx runtime-secrets <dir>`: new runtime token + its sha256 + a secrets key, written to 600 files, nothing printed.
* `funx runtime-build --api https://<funx-api> dist/funx-runtime.zip`: runtime + vendored isolated-vm (checked
  against `SHA256SUMS`) + `config.json`. ~0.4 MB zipped, no npm dependencies.
* funx-api env adds `FUNX_SECRETS_KEY`, `FUNX_RUNTIME_TOKEN_SHA256` (presence of the key switches funx-api to v2).
* funx-runtime: Web function, HK, no role, no VPC, env `FUNX_RUNTIME_TOKEN` only, tag codename=funx, log topic
  `funx-scf`, then the `*.funx.run` custom domain moves from funx-router to funx-runtime.

## Risks (and what limits them)

1. **Shared process.** All workers that land on one runtime instance share one Node process. A V8 or
   isolated-vm bug that escapes an isolate reaches the process: it could read other workers' cached code and
   env (including their decrypted secrets) and the runtime token (gone from `process.env`, but still in
   memory). It cannot reach the DB, the secrets key or any cloud API: the runtime has no role, no VPC and no
   key. Mitigations: keep Node 18 patched to the latest SCF image; cache only the worker configs the instance
   actually served; short-lived instances; rotate the runtime token on any suspicion (1 env change on 2
   functions).
2. **isolated-vm is not a complete security boundary and is in maintenance mode.** Its README says so:
   it is a good isolation primitive, but running hostile code safely needs more (process separation,
   seccomp). It also tracks Node releases slowly. We treat it as "good enough for invited users in the demo",
   **not** for anonymous public sign-up. The exit is workerd (designed for multi-tenant, process-level
   hardening); the Workers-compatible API keeps that swap local to `funx-runtime` **[R7]**.
3. **Noisy neighbour.** One worker can burn its 50 ms CPU and 64 MB per request and saturate the instance it
   runs on; with single concurrency the next request waits for a new instance. Limits: CPU/wall timeouts,
   heap limit, isolate disposal on breach, subrequest cap, a per-worker in-memory request counter
   (later: a per-worker rate limit and a "disable on abuse" flag), SCF reserved concurrency on funx-runtime to
   cap the total cost.
4. **Native module on SCF.** isolated-vm is a native addon. The npm prebuilt for Node 18 needs glibc 2.30;
   the SCF Nodejs18.15 image has glibc 2.28 (measured in `funx-ivm-test`), so we build it ourselves in a
   Debian buster (glibc 2.28) chroot and ship `vendor/isolated-vm/` inside the runtime package
   (see `infra/runtime/build-ivm.sh`).
5. **Secrets in transit and in runtime memory.** Decrypted values travel funx-api -> runtime over HTTPS
   (function URL, TLS) and live in the runtime's memory for the cache TTL. They are never logged; SCF still
   logs response bodies of the runtime if a worker echoes them (log topic `funx-scf`, 1-day retention).
6. **funx-api availability.** The runtime depends on funx-api (GZ) for cold caches. Stale-while-error up to
   60 s; after that 503. funx-api reserved concurrency 1 (+ pool max 2) means cold caches across many runtime
   instances queue on funx-api; acceptable at demo scale, revisit before opening up.
7. **Runtime token theft** gives read access to every worker's code + decrypted env via the runtime endpoint.
   It lives only in funx-runtime's env (readable by whoever has scf:GetFunction on funx-runtime) and
   is rotated by changing the hash in funx-api + the value in funx-runtime.
