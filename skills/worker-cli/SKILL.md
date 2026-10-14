---
name: funx-worker-cli
description: Deploy a user worker to Funx with the Funx CLI only. Use when writing a Cloudflare Workers fetch handler, running funx dev, funx deploy --name, or funx var / funx secret. No console. Do not touch funx-api, funx-router, or funx-runtime by hand, and do not put secrets in git.
---

# Funx 用户 worker：全程 CLI

朋友的站点是一个 Cloudflare Workers 风格的 `fetch` 函数时，只走 Funx CLI。不要打开控制台，不要手改 `funx-api`、`funx-router`、`funx-runtime`。

契约细节以仓库根目录 [README.md](../../README.md) 为准。安装方式见 [cli/README.md](../../cli/README.md)。

## 后端必须改成的样子

不是 Express `app.listen`。入口导出：

```js
export default {
  async fetch(request, env, ctx) {
    return Response.json({ path: new URL(request.url).pathname, hi: env.GREETING });
  },
};
```

CommonJS 也可以：`module.exports = { fetch }`。旧的 `exports.handler = async (event) => ({ statusCode, headers, body })` 仍可用。

- 入口：`funx.json` > `package.json` 的 `main` > `wrangler.toml` 的 `main` > `index.mjs` / `index.js` / `worker.js` / `src/index.js`
- `env.VAR` / `env.SECRET` 来自 `funx var` / `funx secret`，不是写进源码的常量
- 本地密钥放目录里的 `.dev.vars`（`funx dev` 会读）。这个文件不会被打进部署包，也不要提交
- 公开地址是 `https://<name>.funx.run`。`name` 为 3–32 位 `a-z`、`0-9`、`-`，不能以 `-` 开头或结尾；`api`、`www`、`admin` 等保留名不能用
- KV、D1、R2、Durable Objects、Cron 还没有

下面命令在仓库根目录执行。`npm link` 之后可以把 `node cli/funx.js` 换成 `funx`。

## 本地先跑

不需要云凭证：

```bash
node cli/funx.js dev ./examples/worker
# http://localhost:8787 ，保存后重载

node cli/funx.js dev ./my-worker --port 8787 --var GREETING=hi
```

## 部署

操作者命令需要 STS 临时凭证和 `FUNX_DEPLOY_KEY`。密钥放在环境里，不要写进命令行历史或仓库。

```bash
node cli/funx.js deploy ./my-worker --name hello
# 成功时只打印 https://hello.funx.run
```

`--no-domain` 会跳过自定义域名。不要自己去拼或打印函数 URL（`*.tencentscf.com`）。CLI 和路由都不打印它。

## 变量和密钥

密钥从 stdin 读，明文不会被打印：

```bash
node cli/funx.js var set hello GREETING hi
node cli/funx.js var delete hello GREETING

printf '%s' "$SOME_SECRET" | node cli/funx.js secret put hello API_TOKEN
node cli/funx.js secret list hello
node cli/funx.js secret delete hello API_TOKEN
```

`secret list` 只列出名字。

## 不要做的事

- 不要为了用户 worker 去更新、调用或删除 `funx-api`、`funx-router`、`funx-runtime`（控制台、tccli、或 `router-deploy` / `runtime-deploy` 都不行）
- 不要把密钥、`.dev.vars`、`.env*`、`*.pem`、`*.key` 写进 git。打包会排除它们，但提交仍然禁止
- 不要在聊天、日志或 PR 里粘贴密钥、STS、deploy key 或函数 URL
- 不要打开控制台来发布用户 worker
