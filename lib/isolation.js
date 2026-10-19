'use strict';
// Same-account fence (REQ-9). Funx may share a Tencent account only inside these
// checks. A separate main account is a later decision and is not represented here.
// Nothing in this file creates roles, databases, or cloud resources.

const { fromFunctionName } = require('./names');

const NAMESPACE = 'funx';
const DB_NAME = 'funx';
const DB_USER_RE = /^funx(?:[_-][a-z0-9]+)*$/;
const USER_PREFIX = 'funx-u-';
const PLATFORM_FUNCTIONS = Object.freeze(['funx-api', 'funx-router', 'funx-runtime']);
const COS_PREFIX = 'scf-deploy/ci/';
const TAG = Object.freeze({ key: 'codename', value: 'funx' });
const DENY_CONFIGURATION = 'scf:UpdateFunctionConfiguration';

// Draft only. Role names and action lists. No account id, no ARN, not applied.
const CAM_DRAFT = Object.freeze({
  roles: {
    'funx-ci-develop': {
      alias: 'develop',
      allow: [
        { actions: ['cos:PutObject', 'cos:GetObject'], prefix: COS_PREFIX },
        { actions: ['scf:UpdateFunctionCode'], namespace: NAMESPACE, functions: PLATFORM_FUNCTIONS },
        { actions: ['scf:UpdateAlias'], namespace: NAMESPACE, functions: PLATFORM_FUNCTIONS, alias: 'develop' },
      ],
      deny: [DENY_CONFIGURATION],
    },
    'funx-ci-production': {
      alias: 'production',
      allow: [
        { actions: ['scf:UpdateAlias'], namespace: NAMESPACE, functions: PLATFORM_FUNCTIONS, alias: 'production' },
      ],
      deny: [DENY_CONFIGURATION, 'scf:UpdateFunctionCode'],
    },
    'funx-ci-runtime': {
      alias: null,
      allow: [],
      deny: [DENY_CONFIGURATION],
    },
  },
});

function assertNamespace(namespace) {
  if (namespace !== NAMESPACE) {
    throw new Error(`SCF namespace must be "${NAMESPACE}" (got ${JSON.stringify(namespace)})`);
  }
  return namespace;
}

function assertDatabase({ name, user }) {
  if (name !== DB_NAME) throw new Error(`database name must be "${DB_NAME}"`);
  if (typeof user !== 'string' || !DB_USER_RE.test(user)) {
    throw new Error('database user must be a funx account (funx or funx_api), not root or a demox account');
  }
  return { name, user };
}

function classifyFunction(fn) {
  if (PLATFORM_FUNCTIONS.includes(fn)) return 'platform';
  if (typeof fn === 'string' && fn.startsWith(USER_PREFIX) && fromFunctionName(fn)) return 'user';
  return null;
}

function scfResource({ region, uin, namespace, functionName }) {
  assertNamespace(namespace);
  if (typeof region !== 'string' || !/^[a-z0-9-]+$/.test(region)) throw new Error('bad region');
  if (!/^\d+$/.test(String(uin || ''))) throw new Error('bad uin');
  if (!classifyFunction(functionName)) throw new Error(`not a Funx function: ${functionName}`);
  return `qcs::scf:${region}:uin/${uin}:namespace/${namespace}/function/${functionName}`;
}

function referencedTables(sql) {
  const src = String(sql).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out = new Set();
  const re = /\b(?:from|join|into)\s+`?([a-z0-9_]+)|update\s+`?([a-z0-9_]+)\s+set|create\s+table(?:\s+if\s+not\s+exists)?\s+`?([a-z0-9_]+)/gi;
  let m;
  while ((m = re.exec(src))) out.add((m[1] || m[2] || m[3]).toLowerCase());
  return [...out];
}

function assertFunxSql(sql) {
  if (/demox/i.test(sql)) throw new Error('SQL names a Demox object');
  const bad = referencedTables(sql).filter((t) => t !== 'information_schema' && !t.startsWith('funx_'));
  if (bad.length) throw new Error(`SQL touches a non-Funx table: ${bad.join(', ')}`);
  return true;
}

function camAllows(roleName, target) {
  const role = CAM_DRAFT.roles[roleName];
  if (!role || !target || role.deny.includes(target.action)) return false;
  return role.allow.some((st) => {
    if (!st.actions.includes(target.action)) return false;
    if (st.prefix) {
      return typeof target.cosKey === 'string' && target.cosKey.startsWith(st.prefix) && !target.cosKey.includes('..');
    }
    if (st.namespace !== target.namespace) return false;
    if (!st.functions.includes(target.functionName)) return false;
    if (st.alias) return target.alias === st.alias;
    return !target.alias;
  });
}

function reviewCamDraft(draft = CAM_DRAFT) {
  const errors = [];
  const roles = draft && draft.roles;
  if (!roles || typeof roles !== 'object') return ['draft has no roles'];
  for (const [name, role] of Object.entries(roles)) {
    if (!/^funx-ci-[a-z0-9-]+$/.test(name) || /demox/i.test(name)) errors.push(`${name}: role name`);
    if (!Array.isArray(role.deny) || !role.deny.includes(DENY_CONFIGURATION)) errors.push(`${name}: missing ${DENY_CONFIGURATION} deny`);
    for (const st of role.allow || []) {
      const blob = JSON.stringify(st);
      if (/demox/i.test(blob) || /"default"/.test(blob)) errors.push(`${name}: statement names demox or default`);
      if (st.prefix && st.prefix !== COS_PREFIX) errors.push(`${name}: COS prefix`);
      if (st.namespace && st.namespace !== NAMESPACE) errors.push(`${name}: namespace`);
      for (const fn of st.functions || []) {
        if (classifyFunction(fn) !== 'platform') errors.push(`${name}: ${fn} is not a platform function`);
      }
      if ((st.actions || []).includes('scf:UpdateAlias') && st.alias !== role.alias) errors.push(`${name}: UpdateAlias alias`);
      if ((st.actions || []).some((a) => a.startsWith('cos:')) && name !== 'funx-ci-develop') errors.push(`${name}: COS is develop-only`);
      if (name === 'funx-ci-production' && (st.actions || []).includes('scf:UpdateFunctionCode')) errors.push(`${name}: no UpdateFunctionCode`);
      if (name === 'funx-ci-runtime' && (st.actions || []).length) errors.push(`${name}: runtime role is not granted here`);
    }
  }
  return errors;
}

module.exports = {
  NAMESPACE, DB_NAME, DB_USER_RE, USER_PREFIX, PLATFORM_FUNCTIONS, COS_PREFIX, TAG, CAM_DRAFT,
  assertNamespace, assertDatabase, classifyFunction, scfResource, referencedTables, assertFunxSql,
  camAllows, reviewCamDraft,
};
