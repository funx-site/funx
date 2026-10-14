// CodeMirror 6 bundle for the Funx console. Grayscale only (no purple/blue/red syntax colors).
// Layout metrics come from CSS variables in app.css (--code-*), shared with the first-paint view
// (.code-static), so the swap from the static view to CodeMirror does not move a single line.
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';

const ink = EditorView.theme({
  '&': { color: 'var(--code-fg)', backgroundColor: 'transparent', height: '100%', fontSize: 'var(--code-size)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: 'var(--code-lh)', overflow: 'auto' },
  '.cm-content': { fontFamily: 'var(--mono)', caretColor: '#ffffff', padding: 'var(--code-pad-y) 0' },
  '.cm-line': { padding: '0 var(--code-pad-r) 0 var(--code-pad-l)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--code-ln)', border: 'none', paddingTop: '0' },
  '.cm-gutter.cm-lineNumbers': { width: 'var(--code-gutter)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 var(--code-ln-gap) 0 0', minWidth: '0', textAlign: 'right', boxSizing: 'border-box' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--code-ln-active)' },
  '.cm-activeLine': { backgroundColor: 'var(--code-active)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: '#ffffff' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(255,255,255,.16) !important' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(255,255,255,.12)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(255,255,255,.08)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-tooltip': { backgroundColor: '#1b1b1b', border: '1px solid rgba(255,255,255,.14)', color: '#e8e8e6' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'rgba(255,255,255,.14)', color: '#fff' },
}, { dark: true });

// Same classes the first-paint highlighter uses (.tk-*), so colors match too.
const gray = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword], class: 'tk-kw' },
  { tag: [t.string, t.special(t.string), t.regexp], class: 'tk-str' },
  { tag: [t.comment, t.lineComment, t.blockComment], class: 'tk-com' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tk-num' },
  { tag: [t.punctuation, t.bracket, t.operator], class: 'tk-punc' },
]);

export function createEditor(parent, doc, onChange, { wrap = false } = {}) {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(),
        EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
        autocompletion(), highlightActiveLine(), highlightSelectionMatches(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        EditorState.tabSize.of(2),
        javascript(), ink, syntaxHighlighting(gray),
        ...(wrap ? [EditorView.lineWrapping] : []),
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange(u.state.doc.toString()); }),
      ],
    }),
  });
  return {
    get value() { return view.state.doc.toString(); },
    set value(v) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }); },
    focus() { view.focus(); },
    destroy() { view.destroy(); },
  };
}
