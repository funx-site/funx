// Hash routes for the console SPA. Pure (no DOM) so Node tests can call it.
//   #/                          worker list
//   #/new                       editor for a worker that has no name yet
//   #/workers/<name>            editor for a deployed worker
//   #/workers/<name>/settings   vars, secrets, disable, delete
//   #/workers                   old list URL; redirect to #/
//   #/w/<name>[/settings]       old editor URL; redirect to #/workers/<name>
//   #/login                     email + password
//   #/setup?t=<token>           one-time password setup link

const NAME = '[a-z0-9-]+';

export function resolveRoute(hash) {
  const h = (hash || '#/').split('?')[0];
  if (h.startsWith('#/login')) return { page: 'login' };
  if (h.startsWith('#/setup')) return { page: 'setup' };
  if (h === '#/workers' || h === '#/workers/') return { page: 'redirect', to: '#/' };
  let m = h.match(new RegExp(`^#/workers/(${NAME})(/settings)?$`));
  if (m) return { page: m[2] ? 'settings' : 'editor', name: m[1] };
  m = h.match(new RegExp(`^#/w/(${NAME})(/settings)?$`));
  if (m) return { page: 'redirect', to: `#/workers/${m[1]}${m[2] || ''}` };
  if (h === '#/new') return { page: 'editor', name: null };
  return { page: 'list' };
}

// Nav highlight: the list itself, including the old list URL before it redirects.
export function isListHash(hash) {
  const h = (hash || '#/').split('?')[0];
  return h === '#/' || h === '#/workers' || h === '#/workers/';
}
