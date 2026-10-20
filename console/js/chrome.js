// Page chrome shared by all routes. Pure (no DOM, no storage) so it can be tested in Node.
import { isListHash } from './routes.js';

// Mock mode only when the deployment config has no apiBase. A real-backend build can never be
// switched into mock mode (no ?mock override), so the sample-data label can't appear there.
export function isMockMode(cfg) {
  return !(cfg && typeof cfg.apiBase === 'string' && cfg.apiBase.trim());
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// minimal: logged-out pages (setup link, expired link) -> wordmark + language toggle only.
export function headerHtml({ t, lang, mock, user, hash = '', minimal = false, title = '', actions = '', crumbs = '' }) {
  const langBtn = `<button class="ghost small" id="lang">${lang === 'zh' ? 'EN' : '中文'}</button>`;
  if (minimal) {
    return `
  <header class="top minimal">
    <a class="wordmark" href="#/" aria-label="funx">funx</a>
    ${title ? `<h1 class="sr">${esc(title)}</h1>` : ''}
    <div class="spacer"></div>
    ${langBtn}
  </header>`;
  }
  return `
  <header class="top">
    <a class="wordmark" href="#/" aria-label="funx">funx</a>
    <nav class="nav"><a href="#/"${isListHash(hash) ? ' class="on"' : ''}>${t('workers')}</a></nav>
    ${crumbs ? `<div class="crumbs">${crumbs}</div>` : ''}
    ${title ? `<h1 class="sr">${esc(title)}</h1>` : ''}
    <div class="spacer"></div>
    ${mock ? `<span class="pill muted" title="mock">${t('mock')}</span>` : ''}
    ${langBtn}
    ${user ? `<button class="ghost small" id="logout" title="${esc(user.email)}">${t('logout')}</button>` : (hash.startsWith('#/login') ? '' : `<a class="ghost small btnlike" href="#/login">${t('login')}</a>`)}
    ${actions}
  </header>
  ${mock ? `<p class="mockline">${t('mock')}</p>` : ''}`;
}
