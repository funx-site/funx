#!/usr/bin/env node
'use strict';
const path = require('path');
const { loadConfig } = require('./config');
const { checkDeployKey, credsFromEnv, newDeployKey } = require('./auth');
const ops = require('./ops');

const USAGE = `funx - deploy a worker to https://<name>.funx.run (Cloudflare Workers style)

Local (no cloud, no credentials):
  funx dev [dir|file] [--port 8787] [--var K=V ...]   run a worker on localhost, reload on change
                                     (.dev.vars in the directory = local vars/secrets)
  funx keygen                        make a deploy key (prints key once + hash for cli/deploy-keys.json)
  funx jwt-keygen                    make an ES256 signing key for funx-api (FUNX_JWT_KEYS)
  funx user-hash <email> <id> [admin]   read a password from stdin, print a FUNX_USERS entry
  funx api-build [out.zip]           build the funx-api package (does not deploy)
  funx runtime-build --api <url> [out.zip]   build the shared funx-runtime package (v2; does not deploy)
  funx runtime-deploy <zip>                 create/update funx-runtime (HK); set FUNX_RUNTIME_TOKEN via env file
  funx runtime-secrets <dir>         write a new runtime token, its sha256 and a secrets key into <dir> (files 600,
                                     nothing printed): FUNX_RUNTIME_TOKEN (runtime), FUNX_RUNTIME_TOKEN_SHA256 +
                                     FUNX_SECRETS_KEY (funx-api)

Operator (STS credentials + deploy key):

  funx deploy <dir> --name <name> [--no-domain]   create or update a site (--no-domain: skip the custom domain)
  funx list                          list sites
  funx delete <name>                 delete a site (router entry, domain, function)
  funx disable <name>                kill switch: router 403 + lock the origin (random route key)
  funx enable <name>                 undo disable
  funx rotate-key <name>             new router->function key
  funx set-origin <name>             fallback: read the function URL from stdin into the router map
  funx router-deploy                 create or update funx-router
  funx cert-rotate <certId>          switch every site's custom domain to a renewed *.funx.run cert
  funx secret put <name> <KEY>       read a value from stdin, store as a secret (value never printed)
  funx secret list <name>            secret names
  funx secret delete <name> <KEY>
  funx var set <name> <KEY> <value>  plain variable;  funx var delete <name> <KEY>

Env: TENCENTCLOUD_SECRET_ID/SECRET_KEY/SESSION_TOKEN (STS of <deploy-role>), FUNX_DEPLOY_KEY,
     FUNX_CERT_ID, optional FUNX_RUNTIME (Nodejs18.15), FUNX_REGION (ap-hongkong).`;

function arg(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help') { console.log(USAGE); return; }
  if (cmd === 'keygen') {
    const k = newDeployKey();
    console.log(`deploy key (give to the operator once, store in your password manager):\n  ${k.key}\nadd to cli/deploy-keys.json:\n  { "owner": "<who>", "sha256": "${k.sha256}" }`);
    return;
  }
  if (cmd === 'dev') {
    const target = argv[1] && !argv[1].startsWith('--') ? argv[1] : '.';
    const vars = {};
    argv.forEach((a, i) => { if (a === '--var') { const [k, ...v] = String(argv[i + 1] || '').split('='); vars[k] = v.join('='); } });
    const { startDev } = require('./dev');
    const dev = await startDev({ target, port: Number(arg(argv, '--port')) || 8787, vars });
    console.log(`funx dev: ${dev.url}  (Ctrl+C to stop)`);
    await new Promise((r) => process.once('SIGINT', r));
    await dev.close();
    return;
  }
  if (cmd === 'jwt-keygen') {
    const { newKey } = require('../api/jwt');
    console.log('private signing key for FUNX_JWT_KEYS (store it in the password manager, never in git):');
    console.log(JSON.stringify([newKey()]));
    return;
  }
  if (cmd === 'user-hash') {
    const [email, id, role] = argv.slice(1);
    if (!email || !id) throw new Error('usage: echo -n <password> | funx user-hash <email> <id> [admin]');
    const users = require('../api/users');
    const pw = await readStdin();
    const bad = users.validateCredentials(email, pw);
    if (bad) throw new Error(bad);
    console.log(JSON.stringify({ id, email: users.normalizeEmail(email), hash: await users.hashPassword(pw), role: role === 'admin' ? 'admin' : 'user' }));
    return;
  }
  if (cmd === 'runtime-build') {
    const pos = argv.slice(1).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--api');
    const out = path.resolve(pos[0] || 'dist/funx-runtime.zip');
    const { buildRuntimeZip } = require('./runtime-package');
    const buf = buildRuntimeZip(loadConfig(), { apiBase: arg(argv, '--api') });
    require('fs').mkdirSync(path.dirname(out), { recursive: true });
    require('fs').writeFileSync(out, buf);
    console.log(`${out} (${(buf.length / 1048576).toFixed(1)} MB)`);
    return;
  }
  if (cmd === 'runtime-secrets') {
    const dir = argv[1];
    if (!dir) throw new Error('usage: funx runtime-secrets <dir>');
    const fs = require('fs'); const crypto = require('crypto');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const token = `fxrt_${crypto.randomBytes(32).toString('base64url')}`;
    const files = {
      'funx-runtime.env': `FUNX_RUNTIME_TOKEN=${token}\n`,
      'funx-api-runtime.env': `FUNX_RUNTIME_TOKEN_SHA256=${crypto.createHash('sha256').update(token).digest('hex')}\nFUNX_SECRETS_KEY=${require('../api/secretbox').newSecretsKey()}\n`,
    };
    for (const [f, body] of Object.entries(files)) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) throw new Error(`${p} exists; refusing to overwrite`);
      fs.writeFileSync(p, body, { mode: 0o600, flag: 'wx' });
    }
    console.log(`wrote ${Object.keys(files).join(', ')} in ${dir} (600); values not printed`);
    return;
  }
  if (cmd === 'api-build') {
    const out = path.resolve(argv[1] || 'dist/funx-api.zip');
    const { buildApiZip } = require('./api-package');
    const buf = buildApiZip(loadConfig());
    require('fs').mkdirSync(path.dirname(out), { recursive: true });
    require('fs').writeFileSync(out, buf);
    console.log(`${out} (${(buf.length / 1048576).toFixed(1)} MB)`);
    return;
  }
  const cfg = loadConfig();
  const owner = checkDeployKey(process.env.FUNX_DEPLOY_KEY);
  const { makeScf } = require('./scf');
  const scf = makeScf(credsFromEnv(), cfg);
  const log = (m) => console.error(`funx: ${m}`);

  switch (cmd) {
    case 'runtime-deploy': {
      const zipPath = argv[1];
      if (!zipPath) throw new Error('usage: funx runtime-deploy <zip>');
      const fs = require('fs');
      const zip = fs.readFileSync(path.resolve(zipPath));
      await ops.runtimeDeploy(scf, cfg, { zip, log });
      // Token from env (never print): FUNX_RUNTIME_TOKEN or file via FUNX_RUNTIME_TOKEN_FILE
      let token = process.env.FUNX_RUNTIME_TOKEN || '';
      if (!token && process.env.FUNX_RUNTIME_TOKEN_FILE) {
        const body = fs.readFileSync(process.env.FUNX_RUNTIME_TOKEN_FILE, 'utf8');
        const m = /(?:^|\n)FUNX_RUNTIME_TOKEN=([^\n]+)/.exec(body);
        token = m ? m[1].trim() : body.trim();
      }
      if (!token) throw new Error('set FUNX_RUNTIME_TOKEN or FUNX_RUNTIME_TOKEN_FILE');
      const f = await scf.GetFunction({ FunctionName: 'funx-runtime', Namespace: cfg.namespace });
      const vars = ((f.Environment && f.Environment.Variables) || []).map((v) => ({ Key: v.Key, Value: v.Value })).filter((v) => v.Key !== 'FUNX_RUNTIME_TOKEN');
      vars.push({ Key: 'FUNX_RUNTIME_TOKEN', Value: token });
      await scf.UpdateFunctionConfiguration({ FunctionName: 'funx-runtime', Namespace: cfg.namespace, Environment: { Variables: vars } });
      await ops.waitActive(scf, cfg, 'funx-runtime');
      console.log('funx-runtime is Active');
      break;
    }
    case 'deploy': {
      const dir = argv[1];
      const name = arg(argv, '--name');
      if (!dir || !name) throw new Error('usage: funx deploy <dir> --name <name>');
      const url = await ops.deploy(scf, cfg, { name, dir: path.resolve(dir), owner, log, skipDomain: argv.includes('--no-domain') });
      console.log(url);
      break;
    }
    case 'list': {
      const rows = await ops.list(scf, cfg);
      for (const r of rows) console.log(`${r.name.padEnd(32)} ${String(r.status).padEnd(10)} ${r.disabled ? 'DISABLED' : r.routed ? 'live' : 'unrouted'}  ${r.url}`);
      if (!rows.length) console.log('(no sites)');
      break;
    }
    case 'delete': await ops.remove(scf, cfg, { name: argv[1] }); console.log(`deleted ${argv[1]}`); break;
    case 'disable': { const r = await ops.setDisabled(scf, cfg, { name: argv[1], disabled: true }); console.log(`disabled ${argv[1]} (router 403, origin ${r.origin})`); break; }
    case 'enable': { const r = await ops.setDisabled(scf, cfg, { name: argv[1], disabled: false }); console.log(`enabled ${argv[1]} (origin ${r.origin})`); break; }
    case 'rotate-key': await ops.rotateKey(scf, cfg, { name: argv[1] }); console.log(`rotated key for ${argv[1]}`); break;
    case 'set-origin': await ops.setOrigin(scf, cfg, { name: argv[1], url: await readStdin() }); console.log(`origin set for ${argv[1]}`); break;
    case 'cert-rotate': { const d = await ops.rotateCert(scf, cfg, { certId: argv[1] }); console.log(`updated ${d.length} domain(s)`); break; }
    case 'secret': {
      const [sub, name, key] = argv.slice(1);
      if (sub === 'put') { const r = await ops.updateBindings(scf, cfg, { name, set: { [key]: await readStdin() }, type: 'secret' }); console.log(`secrets: ${r.secrets.join(', ')}`); }
      else if (sub === 'list') { const w = await ops.getWorker(scf, cfg, { name }); if (!w) throw new Error(`${name} does not exist`); console.log(w.secrets.join('\n')); }
      else if (sub === 'delete') { await ops.updateBindings(scf, cfg, { name, remove: [key] }); console.log(`deleted ${key}`); }
      else throw new Error('usage: funx secret put|list|delete <name> [KEY]');
      break;
    }
    case 'var': {
      const [sub, name, key, value] = argv.slice(1);
      if (sub === 'set') { await ops.updateBindings(scf, cfg, { name, set: { [key]: value ?? '' }, type: 'var' }); console.log(`${key} set`); }
      else if (sub === 'delete') { await ops.updateBindings(scf, cfg, { name, remove: [key] }); console.log(`deleted ${key}`); }
      else throw new Error('usage: funx var set|delete <name> <KEY> [value]');
      break;
    }
    case 'router-deploy': await ops.routerDeploy(scf, cfg, { log }); console.log('funx-router is Active'); break;
    default: throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    // Print only the message: SDK errors can carry request details.
    console.error(`funx: ${e && e.message ? e.message : e}${e && e.code ? ` (${e.code})` : ''}`);
    process.exit(1);
  });
}

module.exports = { main };
