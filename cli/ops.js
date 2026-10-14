'use strict';
// Funx control-plane operations. Every call goes through `scf`, an object with the
// Tencent Cloud SCF API actions as async methods (real SDK client or a test fake).
// Rules enforced here (CAM enforces them too):
//   * every function is tagged codename=funx
//   * no Role, no VpcConfig on any function
//   * the user function URL (origin) is never printed or logged

const { toFunctionName, validateName, ROUTER_FUNCTION, RUNTIME_FUNCTION } = require('../lib/names');
const { ENV_KEY, ENV_LIMIT_BYTES, parseRoutes, serializeRoutes, envSize, originIdFromUrl } = require('../lib/routes');
const { newRouteKey } = require('./auth');
const { buildUserZip, buildRouterZip, readEntryFromZip } = require('./package');
const { ROUTE_KEY_ENV, META_ENV, readBindings, applyBindings } = require('../lib/bindings');
const URL_TRIGGER = 'funx_url';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GetCustomDomain answers FailedOperation.Domain.UnExist (not ResourceNotFound) for a missing domain.
function isNotFound(e) { return !!(e && typeof e.code === 'string' && (e.code.startsWith('ResourceNotFound') || e.code === 'FailedOperation.Domain.UnExist')); }

async function getFunctionOrNull(scf, cfg, fn) {
  try { return await scf.GetFunction({ FunctionName: fn, Namespace: cfg.namespace }); } catch (e) { if (isNotFound(e)) return null; throw e; }
}

function hasFunxTag(f) { return (f.Tags || []).some((t) => t.Key === 'codename' && t.Value === 'funx'); }

// SCF drops Tags on CreateFunction when called by a role, and GetFunction may not list them:
// fall back to the Tag API (FunxGetTags) when the client has it.
async function withTags(scf, cfg, f, fn) {
  if (hasFunxTag(f) || typeof scf.FunxGetTags !== 'function') return f;
  return { ...f, Tags: await scf.FunxGetTags({ FunctionName: fn, Namespace: cfg.namespace }) };
}

// After create: make sure the tags actually landed (re-apply through the Tag API if not).
async function ensureTags(scf, cfg, fn, tags) {
  const f = await withTags(scf, cfg, await scf.GetFunction({ FunctionName: fn, Namespace: cfg.namespace }), fn);
  if (hasFunxTag(f)) return;
  if (typeof scf.FunxTagFunction !== 'function') throw new Error(`${fn} was created without its codename=funx tag`);
  await scf.FunxTagFunction({ FunctionName: fn, Namespace: cfg.namespace, Tags: tags });
}

async function checkSafe(scf, cfg, f, fn) { assertSafe(await withTags(scf, cfg, f, fn), fn); }

function assertSafe(f, fn) {
  if (!hasFunxTag(f)) throw new Error(`${fn} exists but is not tagged codename=funx; refusing to touch it`);
  if (f.Role) throw new Error(`${fn} has a role attached; Funx functions must have none. Remove it in the console first`);
  if (f.VpcConfig && f.VpcConfig.VpcId) throw new Error(`${fn} is in a VPC; Funx functions must not be`);
}

function envVar(f, key) {
  const v = ((f.Environment && f.Environment.Variables) || []).find((x) => x.Key === key);
  return v ? v.Value : undefined;
}

async function waitActive(scf, cfg, fn) {
  const deadline = Date.now() + cfg.waitTimeoutMs;
  for (;;) {
    const f = await scf.GetFunction({ FunctionName: fn, Namespace: cfg.namespace });
    if (f.Status === 'Active') return f;
    if (/Failed$/.test(f.Status || '')) {
      const why = (f.StatusReasons || []).map((r) => r.ErrorMessage).filter(Boolean).join('; ');
      throw new Error(`${fn} is ${f.Status}${why ? ': ' + why : ''}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${fn} to become Active (last status ${f.Status})`);
    await sleep(cfg.pollMs);
  }
}

function findOriginId(obj, region) {
  const seen = JSON.stringify(obj || {});
  // TriggerDesc is itself a JSON string, so URLs may appear with escaped slashes.
  return originIdFromUrl(seen.replace(/\\\//g, '/'), region);
}

// Ensure the function has a public, unauthenticated function URL and return its origin id.
async function ensureFunctionUrl(scf, cfg, fn, f) {
  let trig = (f.Triggers || []).find((t) => t.Type === 'http');
  if (!trig) {
    const r = await scf.CreateTrigger({
      FunctionName: fn, Namespace: cfg.namespace, TriggerName: URL_TRIGGER, Type: 'http', Qualifier: '$LATEST', Enable: 'OPEN',
      TriggerDesc: JSON.stringify({ AuthType: 'NONE', NetConfig: { EnableIntranet: false, EnableExtranet: true } }),
    });
    trig = r.TriggerInfo || {};
  }
  let id = findOriginId(trig, cfg.region);
  if (!id) {
    const lt = await scf.ListTriggers({ FunctionName: fn, Namespace: cfg.namespace });
    id = findOriginId(lt, cfg.region);
  }
  if (!id) {
    const g = await scf.GetFunction({ FunctionName: fn, Namespace: cfg.namespace });
    id = findOriginId(g.Triggers, cfg.region);
  }
  if (!id) throw new Error(`could not read the function URL of ${fn} from the API; set it with: funx set-origin <name> (reads the URL from stdin)`);
  return { originId: id, triggerName: trig.TriggerName || URL_TRIGGER };
}

// Read-modify-write of the router map. SCF replaces the whole Environment on update,
// so every other variable is carried over unchanged.
async function updateRoutes(scf, cfg, mutate) {
  const router = await getFunctionOrNull(scf, cfg, ROUTER_FUNCTION);
  if (!router) throw new Error(`${ROUTER_FUNCTION} does not exist yet; run: funx router-deploy`);
  await checkSafe(scf, cfg, router, ROUTER_FUNCTION);
  const vars = ((router.Environment && router.Environment.Variables) || []).map((v) => ({ Key: v.Key, Value: v.Value }));
  const routes = parseRoutes(envVar(router, ENV_KEY) || '');
  const result = await mutate(routes);
  const next = vars.filter((v) => v.Key !== ENV_KEY);
  next.push({ Key: ENV_KEY, Value: serializeRoutes(routes) });
  const size = envSize(next);
  if (size > ENV_LIMIT_BYTES) throw new Error(`router map would be ${size} bytes; SCF limit is ${ENV_LIMIT_BYTES}. Move the map into the router package (see RUNBOOK)`);
  await scf.UpdateFunctionConfiguration({ FunctionName: ROUTER_FUNCTION, Namespace: cfg.namespace, Environment: { Variables: next } });
  await waitActive(scf, cfg, ROUTER_FUNCTION);
  return result;
}

async function readRoutes(scf, cfg) {
  const router = await getFunctionOrNull(scf, cfg, ROUTER_FUNCTION);
  return router ? parseRoutes(envVar(router, ENV_KEY) || '') : new Map();
}

async function ensureCustomDomain(scf, cfg, name, { functionName = ROUTER_FUNCTION } = {}) {
  const Domain = `${name}.${cfg.baseDomain}`;
  const target = functionName;
  try {
    const d = await scf.GetCustomDomain({ Domain });
    const ok = (d.EndpointsConfig || []).some((e) => e.FunctionName === target);
    if (!ok) throw new Error(`${Domain} exists but does not point at ${target}; fix it by hand`);
    return;
  } catch (e) { if (!isNotFound(e)) throw e; }
  await scf.CreateCustomDomain({
    Domain, Protocol: 'HTTPS', CertConfig: { CertificateId: cfg.certId },
    EndpointsConfig: [{ Namespace: cfg.namespace, FunctionName: target, Qualifier: '$LATEST', PathMatch: '/*' }],
    Tags: cfg.tags,
  });
}

// Create or update a site. Code comes from `dir` (CLI) or a ready `zip` Buffer from buildUserZipFromFiles /
// buildSourceZip (funx-api). Vars and secrets in the function environment are kept on update.
async function deploy(scf, cfg, { name, dir, zip, owner, routeKey = newRouteKey, log = () => {}, skipDomain = false }) {
  const v = validateName(name);
  if (!v.ok) throw new Error(v.reason);
  if (!skipDomain && !cfg.certId) throw new Error('FUNX_CERT_ID is not set (SSL certificate id of *.funx.run)');
  const fn = toFunctionName(name);
  const ZipFile = (zip || buildUserZip(dir, cfg)).toString('base64');

  let f = await getFunctionOrNull(scf, cfg, fn);
  let key;
  const tags = [...cfg.tags, { Key: 'funx-name', Value: name }, ...(owner ? [{ Key: 'funx-owner', Value: owner }] : [])];
  if (!f) {
    key = routeKey();
    log(`creating ${name}`);
    await scf.CreateFunction({
      FunctionName: fn, Namespace: cfg.namespace, Type: 'HTTP', Runtime: cfg.runtime,
      MemorySize: cfg.memoryMb, Timeout: cfg.timeoutSec, Code: { ZipFile },
      Environment: { Variables: [{ Key: ROUTE_KEY_ENV, Value: key }, { Key: META_ENV, Value: '{"v":[],"s":[]}' }] },
      Tags: tags,
      Description: `funx site ${name}`,
      // Deliberately no Role, no VpcConfig, no InstallDependency.
    });
    await ensureTags(scf, cfg, fn, tags);
  } else {
    await checkSafe(scf, cfg, f, fn);
    key = envVar(f, ROUTE_KEY_ENV);
    if (!key) throw new Error(`${fn} has no route key; run: funx rotate-key ${name}`);
    await waitActive(scf, cfg, fn);
    log(`updating ${name}`);
    await scf.UpdateFunctionCode({ FunctionName: fn, Namespace: cfg.namespace, ZipFile });
  }
  f = await waitActive(scf, cfg, fn);
  await checkSafe(scf, cfg, f, fn);
  const { originId } = await ensureFunctionUrl(scf, cfg, fn, f);
  await updateRoutes(scf, cfg, (routes) => {
    const prev = routes.get(name);
    // While disabled the function holds a lock key nobody should get: keep the router's old key.
    routes.set(name, { originId, key: prev && prev.disabled ? prev.key : key, disabled: prev ? prev.disabled : false });
  });
  if (!skipDomain) await ensureCustomDomain(scf, cfg, name);
  return `https://${name}.${cfg.baseDomain}`;
}

async function remove(scf, cfg, { name }) {
  const fn = toFunctionName(name);
  const f = await getFunctionOrNull(scf, cfg, fn);
  if (f) await checkSafe(scf, cfg, f, fn);
  await updateRoutes(scf, cfg, (routes) => { routes.delete(name); });
  try { await scf.DeleteCustomDomain({ Domain: `${name}.${cfg.baseDomain}` }); } catch (e) { if (!isNotFound(e)) throw e; }
  if (f) await scf.DeleteFunction({ FunctionName: fn, Namespace: cfg.namespace });
}

async function list(scf, cfg) {
  const routes = await readRoutes(scf, cfg);
  const fns = [];
  for (let offset = 0; ; offset += 100) {
    const r = await scf.ListFunctions({ Namespace: cfg.namespace, SearchKey: 'funx-u-', Offset: offset, Limit: 100 });
    fns.push(...(r.Functions || []));
    if (fns.length >= (r.TotalCount || 0) || !(r.Functions || []).length) break;
  }
  const rows = new Map();
  for (const f of fns) {
    if (!f.FunctionName.startsWith('funx-u-')) continue;
    const name = f.FunctionName.slice('funx-u-'.length);
    rows.set(name, { name, status: f.Status, modTime: f.ModTime || null, routed: false, disabled: false });
  }
  for (const [name, r] of routes) {
    const row = rows.get(name) || { name, status: 'missing', routed: false, disabled: false };
    row.routed = true; row.disabled = r.disabled;
    rows.set(name, row);
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r, url: `https://${r.name}.${cfg.baseDomain}` }));
}

// Kill switch. SCF cannot close a function URL trigger (UpdateTriggerStatus/UpdateTrigger reject
// Type=http, seen live 2026-10-10), so the origin is locked instead:
//   disable: router answers 403 for the name, then the function's route key is replaced by a random
//            key that nobody holds -> the function URL answers 403 to everyone, router included.
//   enable:  fresh key into the function, then the router gets the same key and disabled=false.
async function setDisabled(scf, cfg, { name, disabled, routeKey = newRouteKey }) {
  const fn = toFunctionName(name);
  const setFnKey = async (key) => {
    const f = await getFunctionOrNull(scf, cfg, fn);
    if (!f) return false;
    await checkSafe(scf, cfg, f, fn);
    await waitActive(scf, cfg, fn);
    const vars = ((f.Environment && f.Environment.Variables) || []).filter((v) => v.Key !== ROUTE_KEY_ENV).map((v) => ({ Key: v.Key, Value: v.Value }));
    vars.push({ Key: ROUTE_KEY_ENV, Value: key });
    await scf.UpdateFunctionConfiguration({ FunctionName: fn, Namespace: cfg.namespace, Environment: { Variables: vars } });
    await waitActive(scf, cfg, fn);
    return true;
  };
  if (disabled) {
    await updateRoutes(scf, cfg, (routes) => {
      const r = routes.get(name);
      if (!r) throw new Error(`${name} is not in the router map`);
      r.disabled = true;
    });
    const ok = await setFnKey(routeKey()); // nobody keeps this key
    return { origin: ok ? 'locked' : 'missing' };
  }
  const routes = await readRoutes(scf, cfg);
  if (!routes.get(name)) throw new Error(`${name} is not in the router map`);
  const key = routeKey();
  const ok = await setFnKey(key);
  await updateRoutes(scf, cfg, (rs) => {
    const r = rs.get(name);
    if (!r) throw new Error(`${name} is not in the router map`);
    if (ok) r.key = key;
    r.disabled = false;
  });
  return { origin: ok ? 'unlocked' : 'missing' };
}

// New key: function first (router calls fail with 403 for a few seconds), then router.
async function rotateKey(scf, cfg, { name, routeKey = newRouteKey }) {
  const fn = toFunctionName(name);
  const f = await getFunctionOrNull(scf, cfg, fn);
  if (!f) throw new Error(`${fn} does not exist`);
  await checkSafe(scf, cfg, f, fn);
  const key = routeKey();
  const vars = ((f.Environment && f.Environment.Variables) || []).filter((v) => v.Key !== ROUTE_KEY_ENV).map((v) => ({ Key: v.Key, Value: v.Value }));
  vars.push({ Key: ROUTE_KEY_ENV, Value: key });
  await scf.UpdateFunctionConfiguration({ FunctionName: fn, Namespace: cfg.namespace, Environment: { Variables: vars } });
  await waitActive(scf, cfg, fn);
  await updateRoutes(scf, cfg, (routes) => {
    const r = routes.get(name);
    if (r) r.key = key;
  });
}

async function setOrigin(scf, cfg, { name, url }) {
  const originId = originIdFromUrl(url, cfg.region);
  if (!originId) throw new Error(`not a ${cfg.region} function URL`);
  const fn = toFunctionName(name);
  const f = await getFunctionOrNull(scf, cfg, fn);
  if (!f) throw new Error(`${fn} does not exist`);
  await checkSafe(scf, cfg, f, fn);
  const key = envVar(f, ROUTE_KEY_ENV);
  await updateRoutes(scf, cfg, (routes) => {
    const prev = routes.get(name);
    routes.set(name, { originId, key, disabled: prev ? prev.disabled : false });
  });
}

async function routerDeploy(scf, cfg, { log = () => {} } = {}) {
  const ZipFile = buildRouterZip(cfg).toString('base64');
  let f = await getFunctionOrNull(scf, cfg, ROUTER_FUNCTION);
  if (!f) {
    log(`creating ${ROUTER_FUNCTION}`);
    await scf.CreateFunction({
      FunctionName: ROUTER_FUNCTION, Namespace: cfg.namespace, Type: 'HTTP', Runtime: cfg.runtime,
      MemorySize: cfg.routerMemoryMb, Timeout: cfg.routerTimeoutSec, Code: { ZipFile },
      Environment: { Variables: [
        { Key: 'FUNX_BASE_DOMAIN', Value: cfg.baseDomain }, { Key: 'FUNX_REGION', Value: cfg.region },
        { Key: 'FUNX_ACCESS_LOG', Value: '1' }, { Key: ENV_KEY, Value: '{}' },
      ] },
      Tags: [...cfg.tags, { Key: 'funx-role', Value: 'router' }],
      Description: 'funx router: *.funx.run -> user functions',
    });
    await ensureTags(scf, cfg, ROUTER_FUNCTION, [...cfg.tags, { Key: 'funx-role', Value: 'router' }]);
  } else {
    await checkSafe(scf, cfg, f, ROUTER_FUNCTION);
    await waitActive(scf, cfg, ROUTER_FUNCTION);
    log(`updating ${ROUTER_FUNCTION}`);
    await scf.UpdateFunctionCode({ FunctionName: ROUTER_FUNCTION, Namespace: cfg.namespace, ZipFile });
  }
  f = await waitActive(scf, cfg, ROUTER_FUNCTION);
  await checkSafe(scf, cfg, f, ROUTER_FUNCTION);
  // Custom domains need the router to have a function URL. It is public but answers 404
  // to anything whose Host is not <name>.funx.run.
  await ensureFunctionUrl(scf, cfg, ROUTER_FUNCTION, f);
}

async function runtimeDeploy(scf, cfg, { zip, log = () => {} } = {}) {
  if (!zip || !Buffer.isBuffer(zip)) throw new Error('runtimeDeploy needs a zip Buffer (from funx runtime-build)');
  const ZipFile = zip.toString('base64');
  const fn = RUNTIME_FUNCTION;
  let f = await getFunctionOrNull(scf, cfg, fn);
  if (!f) {
    log(`creating ${fn}`);
    await scf.CreateFunction({
      FunctionName: fn, Namespace: cfg.namespace, Type: 'HTTP', Runtime: cfg.runtime,
      MemorySize: 1024, Timeout: 30, Code: { ZipFile },
      Environment: { Variables: [] }, // FUNX_RUNTIME_TOKEN set by caller via UpdateFunctionConfiguration
      Tags: [...cfg.tags, { Key: 'funx-role', Value: 'runtime' }],
      Description: 'funx shared runtime: *.funx.run -> MySQL workers (v2)',
    });
    await ensureTags(scf, cfg, fn, [...cfg.tags, { Key: 'funx-role', Value: 'runtime' }]);
  } else {
    await checkSafe(scf, cfg, f, fn);
    await waitActive(scf, cfg, fn);
    log(`updating ${fn}`);
    await scf.UpdateFunctionCode({ FunctionName: fn, Namespace: cfg.namespace, ZipFile });
  }
  f = await waitActive(scf, cfg, fn);
  await checkSafe(scf, cfg, f, fn);
  await ensureFunctionUrl(scf, cfg, fn, f);
  return f;
}

// After renewing the *.funx.run certificate: point every routed site's custom domain at the new cert.
async function rotateCert(scf, cfg, { certId }) {
  if (!certId) throw new Error('certificate id required');
  const routes = await readRoutes(scf, cfg);
  const done = [];
  for (const name of routes.keys()) {
    // Endpoints are re-sent so an update can never leave a domain without its route.
    await scf.UpdateCustomDomain({
      Domain: `${name}.${cfg.baseDomain}`, Protocol: 'HTTPS', CertConfig: { CertificateId: certId },
      EndpointsConfig: [{ Namespace: cfg.namespace, FunctionName: ROUTER_FUNCTION, Qualifier: '$LATEST', PathMatch: '/*' }],
    });
    done.push(name);
  }
  return done;
}

// ---------- worker management (used by funx-api and the CLI) ----------

function tagValue(f, key) { const t = (f.Tags || []).find((x) => x.Key === key); return t ? t.Value : undefined; }

// Summary of one site. Secret values and the route key are never included.
async function getWorker(scf, cfg, { name }) {
  const fn = toFunctionName(name);
  const f0 = await getFunctionOrNull(scf, cfg, fn);
  if (!f0) return null;
  const f = await withTags(scf, cfg, f0, fn);
  assertSafe(f, fn);
  const routes = await readRoutes(scf, cfg);
  const r = routes.get(name);
  const b = readBindings(f);
  return {
    name, url: `https://${name}.${cfg.baseDomain}`, status: f.Status, routed: !!r, disabled: r ? r.disabled : false,
    owner: tagValue(f, 'funx-owner') || null, runtime: f.Runtime, modTime: f.ModTime || null,
    vars: b.vars, secrets: b.secrets,
  };
}

async function updateBindings(scf, cfg, { name, set, type, remove }) {
  const fn = toFunctionName(name);
  const f = await getFunctionOrNull(scf, cfg, fn);
  if (!f) throw Object.assign(new Error(`${name} does not exist`), { code: 'ResourceNotFound.Function' });
  await checkSafe(scf, cfg, f, fn);
  if (!envVar(f, ROUTE_KEY_ENV)) throw new Error(`${fn} has no route key; refusing to rewrite its environment`);
  const Variables = applyBindings(f, { set, type, remove });
  await waitActive(scf, cfg, fn);
  await scf.UpdateFunctionConfiguration({ FunctionName: fn, Namespace: cfg.namespace, Environment: { Variables } });
  await waitActive(scf, cfg, fn);
  return readBindings({ Environment: { Variables } });
}

// Source of the deployed entry file. download(url) -> Buffer fetches the package from the
// presigned COS URL that GetFunctionAddress returns.
async function getCode(scf, cfg, { name, download }) {
  const fn = toFunctionName(name);
  const f = await getFunctionOrNull(scf, cfg, fn);
  if (!f) return null;
  await checkSafe(scf, cfg, f, fn);
  const a = await scf.GetFunctionAddress({ FunctionName: fn, Namespace: cfg.namespace, Qualifier: '$LATEST' });
  return readEntryFromZip(await download(a.Url));
}

// Recent log lines. Needs scf:GetFunctionLogs; callers map permission errors to "not available".
async function getLogs(scf, cfg, { name, limit = 50 }) {
  const fn = toFunctionName(name);
  const r = await scf.GetFunctionLogs({ FunctionName: fn, Namespace: cfg.namespace, Qualifier: '$LATEST', Offset: 0, Limit: Math.min(Math.max(Number(limit) || 50, 1), 100), Order: 'desc', OrderBy: 'start_time' });
  return (r.Data || []).map((l) => ({ time: l.StartTime, requestId: l.RequestId, status: l.RetCode, ms: l.Duration, log: String(l.Log || '').slice(0, 4000) }));
}

module.exports = { getWorker, updateBindings, getCode, getLogs, tagValue, rotateCert, deploy, remove, list, setDisabled, rotateKey, setOrigin, routerDeploy, runtimeDeploy, ensureCustomDomain, updateRoutes, readRoutes, waitActive, assertSafe, ROUTE_KEY_ENV, RUNTIME_FUNCTION, ROUTER_FUNCTION };
