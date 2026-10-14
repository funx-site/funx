// Runs worker code in the browser for the tester: a dedicated module Web Worker per run, so the
// code gets its own thread (no access to the page, its storage or the token) and can be killed
// after 10 s. Same contract as the platform: default export { fetch(request, env, ctx) }.

const WORKER_SRC = `
self.onmessage = async (e) => {
  const { code, url, method, headers, body, env } = e.data;
  const started = performance.now();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})), passThroughOnException() {}, props: {} };
  let blobUrl;
  try {
    blobUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    const mod = await import(blobUrl);
    const w = mod.default && typeof mod.default.fetch === 'function' ? mod.default : (typeof mod.fetch === 'function' ? mod : null);
    if (!w) throw new Error('export default { fetch(request, env, ctx) } is missing');
    const init = { method, headers };
    if (method !== 'GET' && method !== 'HEAD' && body) init.body = body;
    const res = await w.fetch(new Request(url, init), Object.freeze({ ...env }), ctx);
    if (!(res instanceof Response)) throw new Error('fetch must return a Response');
    const buf = new Uint8Array(await res.arrayBuffer());
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 5000))]);
    const h = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    const ct = res.headers.get('content-type') || '';
    const text = !ct || /^(text\\/|application\\/(json|javascript|xml))|charset=/i.test(ct);
    let out;
    if (text) out = new TextDecoder().decode(buf);
    else { let s = ''; for (const b of buf) s += String.fromCharCode(b); out = btoa(s); }
    self.postMessage({ ok: true, status: res.status, statusText: res.statusText, headers: h, body: out, bodyEncoding: text ? 'utf8' : 'base64', size: buf.length, ms: Math.round(performance.now() - started) });
  } catch (err) {
    self.postMessage({ ok: false, error: 'exception', message: String(err && err.message || err), ms: Math.round(performance.now() - started) });
  } finally { if (blobUrl) URL.revokeObjectURL(blobUrl); }
};`;

let workerUrl = null;

export function runInBrowser({ code, name, env = {}, req, baseDomain = 'funx.run', timeoutMs = 10000 }) {
  workerUrl = workerUrl || URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
  const w = new Worker(workerUrl, { type: 'module' });
  const path = String(req.path || '/').startsWith('/') ? req.path || '/' : `/${req.path}`;
  const msg = { code, url: `https://${name || 'preview'}.${baseDomain}${path}`, method: (req.method || 'GET').toUpperCase(), headers: req.headers || {}, body: req.body || '', env };
  return new Promise((resolve) => {
    const timer = setTimeout(() => { w.terminate(); resolve({ ok: false, error: 'timeout', ms: timeoutMs }); }, timeoutMs);
    w.onmessage = (e) => { clearTimeout(timer); w.terminate(); resolve(e.data); };
    w.onerror = (e) => { clearTimeout(timer); w.terminate(); resolve({ ok: false, error: 'exception', message: e.message || 'syntax error', ms: 0 }); };
    w.postMessage(msg);
  });
}
