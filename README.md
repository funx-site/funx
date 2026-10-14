# Funx v1 (MVP)

Write a worker the Cloudflare Workers way, deploy it, get a public URL:

```js
export default {
  async fetch(request, env, ctx) {
    return Response.json({ path: new URL(request.url).pathname, hi: env.GREETING });
  },
};
```

```bash
funx dev ./examples/worker            # http://localhost:8787, reloads on save, .dev.vars for local secrets
funx deploy ./examples/worker --name hello
# https://hello.funx.run
```

Three ways in: CLI (operators, STS credentials), `funx-api` (HTTP API, email accounts, ES256 tokens),
and the web console (`console/`, static, published at `https://funx.demox.site`).

Whitelist only (admin + test accounts). Tencent Cloud ap-hongkong, existing main account, every
resource tagged `codename=funx`. Not pushed anywhere; nothing has been deployed yet.

## How a request flows

```
browser ──https──> hello.funx.run  (DNSPod * CNAME -> SCF HK custom-domain gateway, LE wildcard cert)
        ──> funx-router (SCF Web function, NO role, NO VPC)
              * Host -> name; 404 for unknown/reserved/malformed, 403 if disabled (kill switch)
              * strips hop-by-hop, x-scf-*, x-funx-* from the client; adds x-funx-route-key
              * fetch -> https://<appid>-<id>.ap-hongkong.tencentscf.com  (secret function URL)
        ──> funx-u-hello (SCF Web function, NO role, NO VPC)
              funx_entry.js shim: 403 unless x-funx-route-key matches FUNX_ROUTE_KEY,
              then calls the user's handler(event)
        <── router strips x-scf-*/x-funx-*/hop-by-hop, removes Domain= from Set-Cookie, size/time limits
```

- One SCF function per site. The function URL is public but useless without the per-function
  random key, which lives only in that function's env and in the router's map.
- The function URL is never printed by the CLI or logged by the router.
- Router log line: `{"n":"<name>","s":<status>,"ms":<ms>}`. No paths, queries, headers or bodies.
- Limits: request 1 MB, response 6 MB, upstream timeout 12 s (user function timeout 10 s, 128 MB).

## Writing a worker

Same contract as Cloudflare Workers:

| Workers | Funx |
| --- | --- |
| `export default { fetch(request, env, ctx) }` | yes (ESM `.mjs`/`.js` or CommonJS `module.exports = { fetch }`) |
| `addEventListener('fetch', e => e.respondWith(...))` | yes (vars/secrets also as globals, like Workers) |
| `Request`, `Response`, `Headers`, `URL`, streams, `crypto.subtle`, `Response.json` | Node 18 globals (+ `crypto`/`Response.json` filled in) |
| `env.VAR`, `env.SECRET` | function vars/secrets (`funx var set`, `funx secret put`, API, console) |
| `ctx.waitUntil(p)` | awaited before the response completes, max 5 s (SCF may freeze after the response) |
| `ctx.passThroughOnException()` | no-op (no origin behind a worker); exceptions → 500 |
| `wrangler.toml` `main = "src/index.js"` | honoured for the entry |
| `.dev.vars` | `funx dev` reads it; never packaged |
| KV, D1, R2, Durable Objects, Cron, `request.cf` | not yet |
| global edge, ~ms cold start | **no**: one region (Hong Kong), SCF container cold start ~0.3-2 s |

Several `Set-Cookie` headers, binary request/response bodies and any status code pass through.
Request ≤ 1 MB (router), response ≤ 6 MB. Entry: `funx.json` (written by the packager) > `package.json`
`main` > `wrangler.toml` `main` > `index.mjs`/`index.js`/`worker.js`/`src/index.js`. An ES-module `.js`
entry is packaged with `"type": "module"` (Node 18 does not detect module syntax by itself).

The v1 `handler(event)` form still works:

```js
exports.handler = async (event) => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: event.path }),
});
```

`event`: `method`, `path`, `query`, `headers` (no `x-scf-*`/`x-funx-*`; `host` is `<name>.funx.run`),
`body` (utf-8 string), `bodyBase64`. Return `{statusCode, headers, body, isBase64Encoded}`, or a string
(text/plain), or any object (JSON). `node_modules` in the directory is shipped as is (zip ≤ 6 MB).
`.env*`, `*.pem`, `*.key`, `.git` are never packaged.

## Layout

```
cli/        funx CLI: dev | deploy | list | delete | disable | enable | secret | var | rotate-key | set-origin
            | router-deploy | cert-rotate | keygen | jwt-keygen | user-hash | api-build | runtime-build.
            ops.js is the shared library. Install: cli/README.md (future npm name @funx-site/cli, not published).
skills/     agent skills: worker-cli (user workers), platform-ops-cli (platform functions vs CI)
AGENTS.md   agent guide: CLI first for workers; GitHub CI for platform functions once wired
router/     funx-router web function (no dependencies)
shim/       funx_entry.cjs (Workers runtime) + scf_bootstrap, added to every user package
api/        funx-api web function: app.js (routes), jwt.js (ES256/JWKS), users.js (scrypt, stores), server.js (SCF entry)
console/    web console, plain static files (index.html, app.css, js/, vendor/codemirror.js)
lib/        name rules, header hygiene, router map format, vars/secrets bindings (shared)
docs/API.md funx-api reference
examples/hello/ (v1 handler), examples/worker/ (Workers style)
infra/      FRONTING.md (why SCF custom domains), tccli/ examples, deploy-router.sh
test/       node:test, SCF API faked in memory (no cloud calls)
```

## Develop

```bash
npm install
npm test                      # 86 tests, no network, SCF faked in memory
node cli/funx.js --help       # or: npm link && funx --help. See cli/README.md
node cli/funx.js dev examples/worker
node cli/funx.js api-build    # dist/funx-api.zip (build only)
```

Console: open `console/index.html` through any static server (e.g. `python3 -m http.server -d console`).
With `apiBase: ''` in `console/config.js` (or `?mock=1`) it runs on mock data kept in the browser and the
tester runs the editor code in a Web Worker. To rebuild the editor bundle or the screenshots:
`cd console/build && npm install && npm run build && node screens.mjs && cd .. && python3 build/diff.py` (the last step diffs the first-paint view against CodeMirror).
