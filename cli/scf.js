'use strict';
// Real SCF client (Tencent Cloud SDK). Credentials come only from the environment
// (temporary STS credentials of <deploy-role>); nothing is written to disk.
//
// Besides the SCF API actions, two Funx helpers backed by the Tag API are exposed:
//   FunxGetTags({FunctionName, Namespace})        -> [{Key, Value}]
//   FunxTagFunction({FunctionName, Namespace, Tags})
// Needed because SCF CreateFunction silently drops Tags when the caller is a role
// (seen live 2026-10-10), and GetFunction does not return them reliably.
const tencentcloud = require('tencentcloud-sdk-nodejs-scf');
const tagSdk = require('tencentcloud-sdk-nodejs-tag');

function makeScf(creds, cfg) {
  const credential = { secretId: creds.secretId, secretKey: creds.secretKey, token: creds.token };
  const client = new tencentcloud.scf.v20180416.Client({
    credential, region: cfg.region,
    profile: { httpProfile: { endpoint: `scf.${cfg.region}.tencentcloudapi.com`, reqTimeout: 60 } },
  });
  const tag = new tagSdk.tag.v20180813.Client({ credential, region: cfg.region, profile: { httpProfile: { endpoint: 'tag.tencentcloudapi.com', reqTimeout: 30 } } });
  const res = (p) => { if (!cfg.uin) throw new Error("FUNX_UIN is not set (owner account id)"); return `qcs::scf:${cfg.region}:uin/${cfg.uin}:namespace/${p.Namespace || cfg.namespace}/function/${p.FunctionName}`; };
  const extra = {
    async FunxGetTags(p) {
      const r = await tag.GetResources({ ResourceList: [res(p)] });
      const m = (r.ResourceTagMappingList || [])[0];
      return ((m && m.Tags) || []).map((t) => ({ Key: t.TagKey, Value: t.TagValue }));
    },
    async FunxTagFunction(p) {
      const r = await tag.TagResources({ ResourceList: [res(p)], Tags: p.Tags.map((t) => ({ TagKey: t.Key, TagValue: t.Value })) });
      if ((r.FailedResources || []).length) throw new Error(`tagging ${p.FunctionName} failed`);
      return r;
    },
  };
  return new Proxy({}, {
    get(_, action) {
      if (extra[action]) return extra[action];
      if (typeof client[action] !== 'function') return undefined;
      return (params) => client[action](params);
    },
  });
}

module.exports = { makeScf };
