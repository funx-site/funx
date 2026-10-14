# How `*.funx.run` reaches the router (decision for v1)

**Choice: SCF custom domains in ap-hongkong, one per site (`<name>.funx.run`), all pointing at
`funx-router`, plus ONE wildcard DNS record.** `funx deploy` creates the custom domain; nothing
else needs buying.

| Option | Verdict |
| --- | --- |
| SCF custom domain, wildcard `*.funx.run` | Not possible: `CreateCustomDomain` says "不支持泛域名". |
| **SCF custom domain per name → funx-router** | **Chosen.** No new product, no purchase, HK region needs no ICP filing, HTTPS with our uploaded LE cert, Host header arrives at the router. Cost: one `CreateCustomDomain` per deploy. |
| API Gateway custom domain | Gone: API Gateway stopped selling 2024-07-01 and shut down 2025-06-30. |
| EdgeOne (global excl. mainland), wildcard accel domain → router function URL | Works and is the v2 path (one wildcard config, WAF, caching), but needs a new EdgeOne plan (one site per plan, the Demox plan is used), i.e. a purchase, and the router would see the function-URL Host, so the original host has to be passed in a header we configure. Not worth it for Monday. |
| Raw function URLs | Not a custom domain; ugly, and would expose origins. |

ICP: `funx.run` is not filed. Everything resolves to ap-hongkong only (SCF HK custom-domain CNAME).
The DNSPod record uses the default line only; never add a mainland line or a mainland origin.

## DNS records (DNSPod, zone funx.run)

| Name | Type | Value | Why |
| --- | --- | --- | --- |
| `*` | CNAME | `<APPID>.ap-hongkong.tencentscf.com` (exact value shown in the SCF console "添加自定义域名" dialog) | every `<name>.funx.run` reaches SCF HK custom-domain gateway; unknown names get no route |
| `_acme-challenge` | TXT | (managed by lego during issue/renew, deleted after) | LE DNS-01 for `*.funx.run` |
| `@` | (optional, later) | apex landing page | not needed for v1 |

Reserved labels (`api auth www admin app console status mail`) also match the wildcard CNAME
but never get a custom domain, so SCF answers them with its own 404. The router also 404s them.

## Exact calls (tccli; credentials from env = STS of <deploy-role>)

```bash
# 0. one-time: wildcard CNAME (value from the console dialog)
tccli dnspod CreateRecord --Domain funx.run --SubDomain '*' --RecordType CNAME \
  --RecordLine 默认 --Value '<APPID>.ap-hongkong.tencentscf.com' --TTL 600

# 1. cert (see cert/issue-wildcard.sh) -> CertificateId, export FUNX_CERT_ID=...

# 2. router: web function, no role, no VPC, tagged
node cli/funx.js router-deploy
#    = tccli scf CreateFunction --region ap-hongkong --cli-input-json file://router-create.json
#      (FunctionName funx-router, Type HTTP, Runtime Nodejs18.15, MemorySize 128, Timeout 15,
#       Tags codename=funx, Environment FUNX_ROUTES={} ..., Code.ZipFile=<base64>)
#    + tccli scf CreateTrigger --region ap-hongkong --cli-input-json file://tccli/function-url.example.json
#      (FunctionName funx-router; Type http; AuthType NONE; extranet on)

# 3. per site (what `funx deploy` does)
tccli scf CreateFunction   --region ap-hongkong ...   # funx-u-<name>, Type HTTP, env FUNX_ROUTE_KEY, tags
tccli scf CreateTrigger    --region ap-hongkong --cli-input-json file://tccli/function-url.example.json
tccli scf UpdateFunctionConfiguration --region ap-hongkong ...  # funx-router env FUNX_ROUTES (read-modify-write)
tccli scf CreateCustomDomain --region ap-hongkong --cli-input-json file://tccli/router-custom-domain.example.json
```

## Things to verify on first real deploy (could not be checked offline)

1. `CreateCustomDomain` accepts a name covered only by the wildcard CNAME (error would be `FailedOperation.CNAME`).
2. The custom-domain gateway passes the original `Host` to the web function. If it does not, the router sees
   no site name and answers 404; fallback is to read `x-forwarded-host` set by the gateway (one-line change in
   `router/router.js`, only if the gateway overwrites that header itself).
3. The function URL is readable from `CreateTrigger`/`ListTriggers`/`GetFunction` (`TriggerDesc`). The CLI scans
   for `https://<appid>-<id>.ap-hongkong.tencentscf.com`. If the API does not return it:
   `echo '<url from console>' | funx set-origin <name>` (never printed back).
4. Nodejs20.19 availability in HK: the CreateFunction docs still list Nodejs18.15 as newest; default is
   Nodejs18.15, `FUNX_RUNTIME=Nodejs20.19` is supported by the CLI but untested in HK.
5. Quota of custom domains per account/region (not documented); v1 needs ~10.
