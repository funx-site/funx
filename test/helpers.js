'use strict';
const http = require('http');

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, port, close: () => new Promise((r) => server.close(r)) };
}

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: raw.toString('utf8'), raw }); });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// In-memory stand-in for the SCF API (only the actions Funx uses).
// Beijing time like the real API ("2026-10-10 17:00:00").
let tick = 0;
function now() { return new Date(Date.UTC(2026, 9, 10, 9, 0, tick++)).toISOString().replace('T', ' ').slice(0, 19); }

function fakeScf({ appId = '1250000000', dropTags = false, logsDenied = false, logs = [] } = {}) {
  const fns = new Map();
  const domains = new Map();
  const calls = [];
  let urlSeq = 0;
  const err = (code, msg = code) => Object.assign(new Error(msg), { code });
  const need = (n) => { const f = fns.get(n); if (!f) throw err('ResourceNotFound.Function'); return f; };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const api = {
    async GetFunction({ FunctionName }) { const f = need(FunctionName); if (f.Status !== 'Active' && f._ticks-- <= 0) f.Status = 'Active'; return clone(f); },
    async CreateFunction(p) {
      if (fns.has(p.FunctionName)) throw err('ResourceInUse.Function');
      if (!(p.Tags || []).some((t) => t.Key === 'codename' && t.Value === 'funx')) throw err('UnauthorizedOperation.CAM', 'tag required');
      fns.set(p.FunctionName, { FunctionName: p.FunctionName, Status: 'Creating', _ticks: 1, Tags: dropTags ? [] : p.Tags, _tags: dropTags ? [] : p.Tags, Environment: p.Environment || { Variables: [] }, Role: p.Role || '', VpcConfig: p.VpcConfig || { VpcId: '', SubnetId: '' }, Type: p.Type, Runtime: p.Runtime, MemorySize: p.MemorySize, Timeout: p.Timeout, Triggers: [], _zip: p.Code.ZipFile, ModTime: now() });
      return {};
    },
    async UpdateFunctionCode(p) { const f = need(p.FunctionName); f._zip = p.ZipFile; f.ModTime = now(); f.Status = 'Updating'; f._ticks = 1; return {}; },
    async UpdateFunctionConfiguration(p) { const f = need(p.FunctionName); if (p.Environment) f.Environment = clone(p.Environment); f.Status = 'Updating'; f._ticks = 1; return {}; },
    async DeleteFunction(p) { need(p.FunctionName); fns.delete(p.FunctionName); return {}; },
    async CreateTrigger(p) {
      const f = need(p.FunctionName);
      const id = `${appId}-${(++urlSeq).toString(36).padStart(8, 'x')}`;
      const desc = JSON.stringify({ ...JSON.parse(p.TriggerDesc), UrlConfig: { ExtranetUrl: `https://${id}.ap-hongkong.tencentscf.com` } });
      const t = { Type: p.Type, TriggerName: p.TriggerName, TriggerDesc: desc, Enable: 1, Qualifier: p.Qualifier };
      f.Triggers.push(t);
      return { TriggerInfo: clone(t) };
    },
    async ListTriggers(p) { return { Triggers: clone(need(p.FunctionName).Triggers) }; },
    async UpdateTriggerStatus(p) { const t = need(p.FunctionName).Triggers.find((x) => x.TriggerName === p.TriggerName); t.Enable = p.Enable === 'OPEN' ? 1 : 0; return {}; },
    async ListFunctions(p) { const list = [...fns.values()].filter((f) => f.FunctionName.includes(p.SearchKey || '')).map((f) => ({ FunctionName: f.FunctionName, Status: f.Status, ModTime: f.ModTime })); return { Functions: list.slice(p.Offset, p.Offset + p.Limit), TotalCount: list.length }; },
    async GetFunctionAddress({ FunctionName }) { need(FunctionName); return { Url: `fake://zip/${FunctionName}` }; },
    async GetFunctionLogs({ FunctionName, Limit }) { need(FunctionName); if (logsDenied) throw err('UnauthorizedOperation.CAM', 'no log permission'); return { Data: logs.slice(0, Limit), TotalCount: logs.length }; },
    async GetCustomDomain({ Domain }) { const d = domains.get(Domain); if (!d) throw err('ResourceNotFound.Domain'); return clone(d); },
    async CreateCustomDomain(p) { domains.set(p.Domain, clone(p)); return {}; },
    async UpdateCustomDomain(p) { const d = domains.get(p.Domain); if (!d) throw err('ResourceNotFound.Domain'); Object.assign(d, clone(p)); return {}; },
    async DeleteCustomDomain({ Domain }) { if (!domains.delete(Domain)) throw err('ResourceNotFound.Domain'); return {}; },
  };
  if (dropTags) {
    api.FunxGetTags = async ({ FunctionName }) => clone(need(FunctionName)._tags || []);
    api.FunxTagFunction = async ({ FunctionName, Tags }) => { need(FunctionName)._tags = clone(Tags); return {}; };
  }
  const scf = new Proxy(api, { get(t, k) { if (typeof t[k] !== 'function') return undefined; return async (p) => { calls.push({ action: k, params: p }); return t[k](p); }; } });
  // download(url) for ops.getCode
  const download = async (url) => Buffer.from(need(url.replace('fake://zip/', ''))._zip, 'base64');
  return { scf, fns, domains, calls, download };
}

module.exports = { listen, request, fakeScf };
