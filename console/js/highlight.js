// First-paint code view: the same rows, gutter, metrics and token classes as the CodeMirror setup in
// build/cm-entry.js, rendered as static HTML so the first screen is complete before the editor loads.
const KW = new Set(['export', 'default', 'async', 'await', 'const', 'let', 'var', 'new', 'if', 'else', 'return', 'function', 'class', 'import', 'for', 'in', 'while', 'do', 'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'void', 'delete', 'yield', 'extends']);
const NUMLIKE = new Set(['true', 'false', 'null', 'undefined']);
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const span = (cls, s) => (cls ? `<span class="${cls}">${esc(s)}</span>` : esc(s));

// Returns an array of HTML strings, one per source line.
export function highlightLines(src) {
  const out = [];
  let i = 0;
  const stack = []; // 'tpl' while inside a template literal, 'expr' inside ${ }, 'brace' for nested { }
  const push = (cls, s) => { const parts = s.split('\n'); parts.forEach((p, k) => { if (k) out.push('\n'); if (p) out.push(span(cls, p)); }); };
  const n = src.length;
  while (i < n) {
    const top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (src[i] === '`') { push('tk-str', '`'); stack.pop(); i++; continue; }
      if (src.startsWith('${', i)) { push('tk-punc', '${'); stack.push('expr'); i += 2; continue; }
      if (src[i] === '\\') { push('', src.slice(i, i + 2)); i += 2; continue; }  // escapes: unstyled, as in CodeMirror
      let j = i; while (j < n && src[j] !== '`' && src[j] !== '\\' && !src.startsWith('${', j)) j++;
      push('tk-str', src.slice(i, j)); i = j; continue;
    }
    const c = src[i];
    if (src.startsWith('//', i)) { let j = src.indexOf('\n', i); if (j < 0) j = n; push('tk-com', src.slice(i, j)); i = j; continue; }
    if (src.startsWith('/*', i)) { let j = src.indexOf('*/', i + 2); j = j < 0 ? n : j + 2; push('tk-com', src.slice(i, j)); i = j; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      push('tk-str', c);
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') { push('', src.slice(j, j + 2)); j += 2; continue; }
        let k = j; while (k < n && src[k] !== c && src[k] !== '\n' && src[k] !== '\\') k++;
        push('tk-str', src.slice(j, k)); j = k;
      }
      if (src[j] === c) push('tk-str', c);
      i = j + 1; continue;
    }
    if (c === '`') { push('tk-str', '`'); stack.push('tpl'); i++; continue; }
    if (/[0-9]/.test(c)) { const m = /^[0-9][0-9_.xXa-fA-FeEn]*/.exec(src.slice(i)); push('tk-num', m[0]); i += m[0].length; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      const w = m[0];
      push(KW.has(w) ? 'tk-kw' : NUMLIKE.has(w) ? 'tk-num' : '', w); i += w.length; continue;
    }
    if (c === '{') { stack.push('brace'); push('tk-punc', c); i++; continue; }
    if (c === '}') { const s = stack.pop(); push('tk-punc', c); i++; if (s === undefined) { /* unbalanced */ } continue; }
    if (/[()[\];,.=+\-*/<>!?:&|%^~]/.test(c)) { let j = i + 1; while (j < n && /[=+\-*/<>!?:&|%^~.]/.test(src[j]) && c !== '.' && !src.startsWith('//', j)) j++; push('tk-punc', src.slice(i, j)); i = j; continue; }
    push('', c); i++;
  }
  return out.join('').split('\n');
}

export function staticCodeHtml(src) {
  return highlightLines(src.replace(/\n$/, '\n')).map((html, k) => `<div class="cs-row${k === 0 ? ' cs-active' : ''}"><span class="cs-ln">${k + 1}</span><span class="cs-line">${html || '<br>'}</span></div>`).join('');
}
