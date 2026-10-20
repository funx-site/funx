// Funx console: static SPA, hash routes, no build step.
//   #/                          worker list (home)
//   #/new                       editor for a worker that has no name yet
//   #/workers/<name>            editor for a deployed worker
//   #/workers/<name>/settings   vars, secrets, disable, delete
//   #/workers                   old list URL; redirects to #/
//   #/w/<name>[/settings]       old editor URL; redirects to #/workers/<name>
//   #/login                     email + password
//   #/setup?t=<token>           one-time password setup link (token removed from the URL at once)
import { t, getLang, setLang } from './i18n.js';
import { createClient, ApiError } from './api.js';
import { runInBrowser } from './runner.js';
import { sample, isSample } from './sample.js';
import { staticCodeHtml } from './highlight.js';
import { isMockMode, headerHtml } from './chrome.js';
import { resolveRoute } from './routes.js';

const cfg = window.FUNX_CONFIG || {};
const apiBase = isMockMode(cfg) ? '' : cfg.apiBase.trim();
const baseDomain = cfg.baseDomain || 'funx.run';
const api = createClient({ apiBase, baseDomain, runLive: (o) => runInBrowser({ ...o, baseDomain }) });
const app = document.getElementById('app');
const isMobile = () => window.matchMedia('(max-width: 760px)').matches;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,30})[a-z0-9]$/;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const fmtTime = (s) => (s ? String(s).slice(5, 16) : '—'); // "2026-10-10 17:02:11" (UTC+8) -> "10-10 17:02"

const icon = {
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.5 10.5h-.5a1.5 1.5 0 0 1-1.5-1.5V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  check: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l6.6 11.7H1.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.2v3.4M8 11.6v.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2v9.6L12.6 8z" fill="currentColor"/></svg>',
  ext: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2.5h4.5V7M13.3 2.7L7.5 8.5M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

function header(opts = {}) {
  return headerHtml({ ...opts, t, lang: getLang(), mock: api.mock, user: api.session.user, hash: location.hash });
}

function bindHeader() {
  $('#lang')?.addEventListener('click', () => { setLang(getLang() === 'zh' ? 'en' : 'zh'); render(); });
  $('#logout')?.addEventListener('click', () => { api.logout(); location.hash = '#/login'; });
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${kind === 'ok' ? icon.check : kind === 'bad' ? icon.warn : ''}<span>${esc(msg)}</span>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function errText(e) {
  if (e instanceof ApiError) return e.message || e.code || t('failed');
  return (e && e.message) || t('failed');
}

// ---------- login ----------

function loginPage() {
  let mode = 'login';
  const draw = () => {
    app.innerHTML = `${header()}
    <main class="auth">
      <form class="card authcard" id="f" novalidate>
        <h1>${mode === 'login' ? t('loginTitle') : t('register')}</h1>
        <p class="muted">${t('loginSub')}</p>
        <label>${t('email')}<input name="email" type="email" autocomplete="email" required></label>
        <label>${t('password')}<input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" minlength="10" required${mode === 'register' ? ` placeholder="${t('pwHint')}"` : ''}></label>
        <p class="formerr" id="err" role="alert"></p>
        <button class="primary wide" type="submit">${mode === 'login' ? t('login') : t('register')}</button>
        <button class="link" type="button" id="swap">${mode === 'login' ? t('noAccount') : t('haveAccount')}</button>
      </form>
    </main>`;
    bindHeader();
    $('#swap').onclick = () => { mode = mode === 'login' ? 'register' : 'login'; draw(); };
    $('#f').onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const btn = ev.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await (mode === 'login' ? api.login(fd.get('email'), fd.get('password')) : api.register(fd.get('email'), fd.get('password')));
        location.hash = sessionStorage.getItem('funx.next') || '#/';
        sessionStorage.removeItem('funx.next');
      } catch (e) { $('#err').innerHTML = `${icon.warn}<span>${esc(errText(e))}</span>`; btn.disabled = false; }
    };
  };
  draw();
}

// ---------- one-time setup link ----------

let setupToken = null;

function expiredPage() {
  app.innerHTML = `${header({ minimal: true })}
  <main class="auth">
    <div class="card authcard expired">
      <h1>${t('expiredTitle')}</h1>
      <p class="muted">${t('expiredSub')}</p>
      <a class="primary wide btnlike" href="#/login">${t('toLogin')}</a>
    </div>
  </main>`;
  bindHeader();
}

async function setupPage() {
  // Take the token out of the address bar and history right away; keep it only in memory.
  const m = (location.hash.split('?')[1] || '').match(/(?:^|&)t=([\w-]+)/);
  if (m) { setupToken = m[1]; history.replaceState(null, '', `${location.pathname}${location.search}#/setup`); }
  if (!setupToken) return expiredPage();
  app.innerHTML = `${header({ minimal: true })}<main class="auth"><div class="card authcard" aria-busy="true"><p class="muted">${t('checking')}</p></div></main>`;
  bindHeader();
  let info;
  try { info = await api.setupCheck(setupToken); } catch (e) {
    if (e instanceof ApiError && e.status === 410) { setupToken = null; return expiredPage(); }
    app.innerHTML = `${header({ minimal: true })}<main class="auth"><div class="card authcard"><p class="formerr">${icon.warn}<span>${esc(errText(e))}</span></p></div></main>`;
    bindHeader();
    return;
  }
  app.innerHTML = `${header({ minimal: true })}
  <main class="auth">
    <form class="card authcard setup" id="f" novalidate>
      <h1>${t('setupTitle')}</h1>
      <p class="muted">${t('setupSub')}</p>
      <p class="acctline" id="acct">${esc(info.email)}</p>
      <input hidden type="email" name="username" autocomplete="username" value="${esc(info.email)}" readonly>
      <div class="field">
        <label for="pw">${t('newPassword')}</label>
        <p class="fieldhint" id="pwhint" aria-live="polite">${t('pwHint')}</p>
        <input id="pw" name="password" type="password" autocomplete="new-password" minlength="10" required aria-describedby="pwhint">
      </div>
      <div class="field">
        <label for="pw2">${t('confirmPassword')}</label>
        <input id="pw2" name="password2" type="password" autocomplete="new-password" minlength="10" required>
      </div>
      <p class="formerr" id="err" role="alert"></p>
      <button class="primary wide" type="submit">${t('setupSave')}</button>
    </form>
  </main>`;
  bindHeader();
  const hint = $('#pwhint');
  const hintNormal = () => { if (hint.classList.contains('bad')) { hint.className = 'fieldhint'; hint.textContent = t('pwHint'); $('#pw').removeAttribute('aria-invalid'); } };
  $('#pw').addEventListener('input', () => { if ($('#pw').value.length >= 10) hintNormal(); });
  $('#f').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const showErr = (msg) => { $('#err').innerHTML = `${icon.warn}<span>${esc(msg)}</span>`; };
    $('#err').innerHTML = '';
    if (String(fd.get('password')).length < 10) {
      hint.className = 'fieldhint bad';
      hint.innerHTML = `${icon.warn}<span>${esc(t('pwHint'))}</span>`;
      $('#pw').setAttribute('aria-invalid', 'true');
      $('#pw').focus();
      return;
    }
    hintNormal();
    if (fd.get('password') !== fd.get('password2')) { $('#pw2').focus(); return showErr(t('pwMismatch')); }
    const btn = ev.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api.setup(setupToken, fd.get('password'));
      setupToken = null;
      location.hash = '#/';
    } catch (e) {
      if (e instanceof ApiError && e.status === 410) { setupToken = null; return expiredPage(); }
      showErr(errText(e)); btn.disabled = false;
    }
  };
}

// ---------- list ----------

async function listPage() {
  if (!api.session.token) { sessionStorage.setItem('funx.next', '#/'); location.hash = '#/login'; return; }
  const shell = (body) => `${header({ actions: `<a class="primary btnlike" href="#/new">${t('new')}</a>` })}
    <main class="page"><div class="pagehead"><h1>${t('workers')}</h1></div>${body}</main>`;
  app.innerHTML = shell(`<div class="table skeleton" aria-busy="true">${'<div class="row sk"></div>'.repeat(3)}</div>`);
  bindHeader();
  let rows;
  try { rows = await api.list(); } catch (e) { app.innerHTML = shell(`<p class="formerr">${icon.warn}<span>${esc(errText(e))}</span></p>`); bindHeader(); return; }
  const body = !rows.length
    ? `<div class="card empty"><p>${t('empty')}</p><a class="primary btnlike" href="#/new">${t('emptyCta')}</a></div>`
    : `<div class="table" role="table">
        <div class="row head" role="row"><span>${t('name')}</span><span>${t('url')}</span><span>${t('status')}</span><span title="UTC+8">${t('lastDeploy')}</span><span></span></div>
        ${rows.map((w) => `
        <div class="row" role="row">
          <a class="name" href="#/workers/${esc(w.name)}">${esc(w.name)}</a>
          <a class="mono url" href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.url.replace('https://', ''))}</a>
          <span class="state ${w.disabled ? 'off' : ''}"><i></i>${w.disabled ? t('disabled') : t('running')}</span>
          <span class="mono muted time">${fmtTime(w.last_deploy)}</span>
          <span class="rowact"><a class="ghost small btnlike" href="#/workers/${esc(w.name)}/settings">${t('settings')}</a></span>
        </div>`).join('')}
      </div>`;
  app.innerHTML = shell(body);
  bindHeader();
}

// ---------- editor ----------

const DRAFT_KEY = 'funx.draft';

async function editorPage(name) {
  const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') || { name: '', code: sample(getLang()) };
  // An untouched sample follows the UI language.
  if (isSample(draft.code)) draft.code = sample(getLang());
  const state = {
    name: name || draft.name || '',
    code: name ? '' : draft.code,
    deployedUrl: null,
    tab: 'code',
    mode: 'draft',
    req: { method: 'GET', path: '/', headers: '', body: '' },
    res: null,
    busy: false,
  };
  let editor = null;

  const urlBlock = () => (state.deployedUrl ? `
    <span class="deployed" id="deployed">
      <a class="mono" href="${esc(state.deployedUrl)}" target="_blank" rel="noopener">${esc(state.deployedUrl.replace('https://', ''))}</a>
      <button class="iconbtn" id="copy" title="${t('copy')}" aria-label="${t('copy')}">${icon.copy}</button>
    </span>` : '');

  const crumbs = name
    ? `<span class="mono wname">${esc(name)}</span><a class="ghost small btnlike" href="#/workers/${esc(name)}/settings">${t('settings')}</a>`
    : `<input class="mono wname-in" id="wname" value="${esc(state.name)}" placeholder="${t('namePh')}" aria-label="${t('name')}" spellcheck="false" autocomplete="off">`;

  app.innerHTML = `${header({ crumbs, actions: `${urlBlock()}<button class="primary deploy" id="deploy">${t('deploy')}</button>` })}
  <div class="tabs" role="tablist">
    <button role="tab" data-tab="code" aria-selected="true">${t('editor')}</button>
    <button role="tab" data-tab="test" aria-selected="false">${t('test')}</button>
  </div>
  <main class="ide" data-tab="code">
    <section class="pane code-pane" aria-label="${t('editor')}">
      <div class="inkblock"><div id="code" class="code-static${isMobile() ? ' wrap' : ''}" aria-label="code">${staticCodeHtml(state.code)}</div><div id="cm" class="cm-host"></div></div>
    </section>
    <section class="pane test-pane" aria-label="${t('test')}">
      <div class="req">
        <div class="panehead"><h2>${t('request')}</h2>
          <div class="seg" role="radiogroup">
            <button role="radio" data-mode="draft" aria-checked="true" title="${t('draftHint')}">${t('draft')}</button>
            <button role="radio" data-mode="live" aria-checked="false" title="${t('liveHint')}">${t('live')}</button>
          </div>
        </div>
        <form id="reqf" class="reqline">
          <select id="method" aria-label="method">${['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => `<option>${m}</option>`).join('')}</select>
          <input id="path" class="mono" value="/" aria-label="path" spellcheck="false">
          <button class="primary" type="submit" id="send">${icon.play}<span>${t('send')}</span></button>
        </form>
        <label class="sub">${t('headers')}<textarea id="headers" class="mono" rows="2" placeholder="content-type: application/json" spellcheck="false"></textarea></label>
        <label class="sub" id="bodywrap" hidden>${t('body')}<textarea id="body" class="mono" rows="3" spellcheck="false"></textarea></label>
        <p class="hint muted" id="modehint">${t('draftHint')}</p>
      </div>
      <div class="res" id="res" aria-live="polite"></div>
    </section>
  </main>`;
  bindHeader();

  const drawRes = () => {
    const r = state.res;
    const el = $('#res');
    if (!r) { el.innerHTML = `<div class="panehead"><h2>${t('response')}</h2></div><p class="muted empty-res">${t('noResponse')}</p>`; return; }
    if (!r.ok) {
      el.innerHTML = `<div class="panehead"><h2>${t('response')}</h2><span class="status bad">${icon.warn}${r.error === 'timeout' ? t('timeout') : t('failed')}</span><span class="mono muted">${r.ms ?? 0} ${t('ms')}</span></div>
      <pre class="resbody mono">${esc(r.message || r.error || '')}</pre>`;
      return;
    }
    const good = r.status >= 200 && r.status < 300;
    const hdrs = Object.entries(r.headers || {}).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('\n');
    let body = r.body || '';
    if (r.bodyEncoding === 'base64') body = `[binary ${r.size} bytes]`;
    else if (/json/.test((r.headers || {})['content-type'] || '')) { try { body = JSON.stringify(JSON.parse(body), null, 2); } catch { /* raw */ } }
    el.innerHTML = `<div class="panehead"><h2>${t('response')}</h2>
        <span class="status ${good ? 'ok' : 'bad'}">${good ? '' : icon.warn}${r.status} ${esc(r.statusText || '')}</span>
        <span class="mono muted">${r.ms} ${t('ms')}</span><span class="mono muted">${r.size ?? body.length} B</span></div>
      <details class="reshead"><summary>${t('resHeaders')}</summary><pre class="mono">${hdrs}</pre></details>
      <pre class="resbody mono">${esc(body)}</pre>`;
  };
  drawRes();

  // First paint: static view of the code (same rows, gutter and metrics as CodeMirror);
  // CodeMirror replaces it in place when its bundle arrives.
  const staticView = $('#code');
  const getCode = () => (editor ? editor.value : state.code);
  const saveDraft = () => { if (!name) localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: $('#wname')?.value || '', code: getCode() })); };
  const upgrade = () => import('../vendor/codemirror.js').then(({ createEditor }) => {
    if (!document.body.contains(staticView)) return;
    const host = $('#cm');
    editor = createEditor(host, state.code, saveDraft, { wrap: isMobile() });
    host.classList.add('ready');
    staticView.hidden = true;
    watchOverflow(host.querySelector('.cm-scroller'));
  }).catch(() => { /* keep the static view */ });

  // Right-edge fade while there is more code to the right (long lines on desktop).
  function watchOverflow(scroller) {
    if (!scroller) return;
    const block = scroller.closest('.inkblock');
    const update = () => block.classList.toggle('more-right', scroller.scrollWidth - scroller.clientWidth - scroller.scrollLeft > 1);
    scroller.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(update).observe(scroller);
    new MutationObserver(update).observe(scroller, { childList: true, subtree: true, characterData: true });
    update();
  }
  watchOverflow(staticView);

  if (name) {
    try {
      const [w, c] = await Promise.all([api.get(name), api.getCode(name)]);
      state.deployedUrl = w.url;
      state.code = c.code;
      staticView.innerHTML = staticCodeHtml(c.code);
      const slot = $('#deploy');
      slot.insertAdjacentHTML('beforebegin', urlBlock());
      bindCopy();
    } catch (e) { toast(errText(e), 'bad'); }
  }
  upgrade();
  $('#wname')?.addEventListener('input', saveDraft);

  // tabs (mobile)
  app.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    $('.ide').dataset.tab = state.tab;
    app.querySelectorAll('.tabs [data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  }));
  // draft / live
  app.querySelectorAll('.seg [data-mode]').forEach((b) => b.addEventListener('click', () => {
    state.mode = b.dataset.mode;
    app.querySelectorAll('.seg [data-mode]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    $('#modehint').textContent = state.mode === 'draft' ? t('draftHint') : t('liveHint');
  }));
  $('#method').addEventListener('change', (e) => { $('#bodywrap').hidden = ['GET', 'HEAD'].includes(e.target.value); });

  function parseHeaders(text) {
    const out = {};
    for (const line of text.split('\n')) { const i = line.indexOf(':'); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    return out;
  }

  $('#reqf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const req = { method: $('#method').value, path: $('#path').value || '/', headers: parseHeaders($('#headers').value), body: $('#body').value };
    const btn = $('#send');
    btn.disabled = true;
    try {
      if (state.mode === 'draft') {
        state.res = await runInBrowser({ code: getCode(), name: name || $('#wname')?.value || 'preview', req, baseDomain });
      } else {
        const target = name || (state.deployedUrl && $('#wname')?.value);
        if (!target) { state.res = { ok: false, error: 'not_deployed', message: t('notDeployed'), ms: 0 }; }
        else state.res = await api.invoke(target, req);
      }
    } catch (e) { state.res = { ok: false, error: 'error', message: errText(e), ms: 0 }; }
    btn.disabled = false;
    drawRes();
    if (window.matchMedia('(max-width: 760px)').matches) app.querySelector('.tabs [data-tab="test"]').click();
  });

  function bindCopy() {
    $('#copy')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(state.deployedUrl); } catch { /* clipboard blocked */ }
      const b = $('#copy'); b.innerHTML = icon.check; b.classList.add('done');
      setTimeout(() => { b.innerHTML = icon.copy; b.classList.remove('done'); }, 1400);
    });
  }
  bindCopy();

  $('#deploy').addEventListener('click', async () => {
    const target = name || ($('#wname').value || '').trim();
    if (!api.session.token) { saveDraft(); sessionStorage.setItem('funx.next', location.hash || '#/new'); toast(t('loginToDeploy')); location.hash = '#/login'; return; }
    if (!NAME_RE.test(target)) { toast(t('nameRule'), 'bad'); $('#wname')?.focus(); return; }
    const btn = $('#deploy');
    btn.disabled = true; btn.textContent = t('deploying');
    try {
      const w = await api.deploy(target, getCode());
      state.deployedUrl = w.url;
      $('#deployed')?.remove();
      btn.insertAdjacentHTML('beforebegin', urlBlock());
      bindCopy();
      toast(t('deployed'), 'ok');
      if (!name) { localStorage.removeItem(DRAFT_KEY); history.replaceState(null, '', `${location.pathname}${location.search}#/workers/${target}`); name = target; }
    } catch (e) { toast(errText(e), 'bad'); }
    btn.disabled = false; btn.textContent = t('deploy');
  });
}

// ---------- settings ----------

async function settingsPage(name) {
  if (!api.session.token) { sessionStorage.setItem('funx.next', location.hash); location.hash = '#/login'; return; }
  let w;
  const crumbs = `<a class="mono wname" href="#/workers/${esc(name)}">${esc(name)}</a>`;
  try { w = await api.get(name); } catch (e) { app.innerHTML = `${header({ crumbs })}<main class="page"><p class="formerr">${icon.warn}<span>${esc(errText(e))}</span></p></main>`; bindHeader(); return; }

  const draw = () => {
    app.innerHTML = `${header({ crumbs, actions: `<a class="primary btnlike" href="#/workers/${esc(name)}">${t('editor')}</a>` })}
    <main class="page narrow">
      <div class="pagehead"><h1>${t('settings')}</h1><a class="mono muted" href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.url.replace('https://', ''))}</a></div>

      <section class="card group">
        <h2>${t('vars')}</h2><p class="muted">${t('varsHint')}</p>
        <div class="kv">${Object.entries(w.vars).map(([k, v]) => `
          <div class="kvrow"><span class="mono k">${esc(k)}</span><span class="mono v">${esc(v)}</span><button class="textbtn" data-delvar="${esc(k)}">${t('remove')}</button></div>`).join('') || ''}
        </div>
        <form class="kvform" id="varf"><input name="k" class="mono" placeholder="GREETING" aria-label="${t('keyName')}" required><input name="v" class="mono" placeholder="${t('value')}" aria-label="${t('value')}"><button class="primary small" type="submit">${t('add')}</button></form>
      </section>

      <section class="card group">
        <h2>${t('secrets')}</h2><p class="muted">${t('secretsHint')}</p>
        <div class="kv">${w.secrets.map((k) => `
          <div class="kvrow"><span class="mono k">${esc(k)}</span><span class="mono v muted">••••••••</span><button class="textbtn" data-delsecret="${esc(k)}">${t('remove')}</button></div>`).join('')}
        </div>
        <form class="kvform" id="secf"><input name="k" class="mono" placeholder="API_TOKEN" aria-label="${t('keyName')}" required><input name="v" type="password" class="mono" placeholder="${t('value')}" aria-label="${t('value')}" autocomplete="off" required><button class="primary small" type="submit">${t('add')}</button></form>
      </section>

      <section class="card group danger">
        <h2>${t('danger')}</h2>
        <div class="dangerrow"><div><strong>${w.disabled ? t('enable') : t('disable')}</strong><p class="muted">${t('disableHint')}</p></div>
          <button class="outline" id="toggle">${w.disabled ? t('enable') : t('disable')}</button></div>
        <div class="dangerrow"><div><strong>${t('deleteWorker')}</strong><p class="muted">${t('deleteHint')}</p>
          <label class="confirm"><span>${t('typeNameBefore')} <span class="mono">${esc(name)}</span> ${t('typeNameAfter')}</span><input id="confirm" class="mono" placeholder="${esc(name)}" autocomplete="off"></label></div>
          <button class="primary destructive" id="del" disabled>${icon.warn}<span>${t('deleteWorker')}</span></button></div>
      </section>
    </main>`;
    bindHeader();
    const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg, 'ok'); w = await api.get(name); draw(); } catch (e) { toast(errText(e), 'bad'); } };
    $('#varf').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); act(() => api.setVars(name, { [f.get('k').trim()]: f.get('v') }), t('saved')); };
    $('#secf').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); act(() => api.putSecret(name, f.get('k').trim(), f.get('v')), t('saved')); };
    app.querySelectorAll('[data-delvar]').forEach((b) => { b.onclick = () => act(() => api.deleteVar(name, b.dataset.delvar)); });
    app.querySelectorAll('[data-delsecret]').forEach((b) => { b.onclick = () => act(() => api.deleteSecret(name, b.dataset.delsecret)); });
    $('#toggle').onclick = () => act(() => api.setDisabled(name, !w.disabled));
    $('#confirm').oninput = (e) => { $('#del').disabled = e.target.value !== name; };
    $('#del').onclick = async () => { try { await api.remove(name); location.hash = '#/'; } catch (e) { toast(errText(e), 'bad'); } };
  };
  draw();
}

// ---------- router ----------

function render() {
  let route = resolveRoute(location.hash);
  window.scrollTo(0, 0);
  if (route.page === 'redirect') {
    history.replaceState(null, '', `${location.pathname}${location.search}${route.to}`);
    route = resolveRoute(route.to);
  }
  if (route.page === 'login') return loginPage();
  if (route.page === 'setup') return setupPage();
  if (route.page === 'list') return listPage();
  if (route.page === 'settings') return settingsPage(route.name);
  return editorPage(route.name);
}

window.addEventListener('hashchange', render);
render();
