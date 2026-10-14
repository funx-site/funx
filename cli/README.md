# Funx CLI

`funx` 把一个 Workers 风格的 worker 部署到 `https://<name>.funx.run`。仓库里的入口是 `cli/funx.js`。`package.json` 的 `bin.funx` 指向这个文件。

用户和 agent 用的公开包是 sibling 仓库 [funx-site/cli](https://github.com/funx-site/cli)（`@funx-site/cli`，尚未发布），skill 是 [funx-site/skill](https://github.com/funx-site/skill)。本目录是平台仓库里的操作者入口。当前 `package.json` 的 `name` 仍是 `funx-mvp`，并且 `private: true`。不要从这里执行 `npm publish`。

## 直接用 node

在仓库根目录：

```bash
npm install
node cli/funx.js --help
node cli/funx.js dev ./examples/worker
node cli/funx.js deploy ./examples/worker --name hello
```

## 本地 `npm link` / `npx`

```bash
npm link
funx --help
```

不把包发到 npm，也可以用仓库目录本身：

```bash
npx --package=. -- funx --help
```

`npm link` 和上面的 `npx` 都走 `bin.funx`，不会访问云 API。`--help` 不需要凭证。

## 命令

`node cli/funx.js --help` 是完整列表。常用的有：

| 命令 | 作用 | 云 |
| --- | --- | --- |
| `funx dev [dir]` | 本地跑 worker | 否 |
| `funx deploy <dir> --name <name>` | 创建或更新用户站点 | 是 |
| `funx var` / `funx secret` | 明文变量 / stdin 密钥 | 是 |
| `funx list` / `delete` / `disable` / `enable` | 站点操作 | 是 |
| `funx api-build` | 只构建 `funx-api` zip | 否 |
| `funx runtime-build --api <url>` | 只构建 `funx-runtime` zip | 否 |
| `funx router-deploy` / `funx runtime-deploy` | 操作者更新平台函数 | 是 |

需要云的命令使用环境变量里的 STS（`TENCENTCLOUD_SECRET_ID` / `TENCENTCLOUD_SECRET_KEY` / `TENCENTCLOUD_SESSION_TOKEN`）和 `FUNX_DEPLOY_KEY`。不要把这些值写进 git、聊天或日志。密钥用 `funx secret put` 从 stdin 读入，CLI 不打印明文，也不打印函数 URL。

用户 / agent 部署见 [funx-site/skill](https://github.com/funx-site/skill) 与 [funx-site/cli](https://github.com/funx-site/cli)。本仓库指针是 [skills/worker-cli/SKILL.md](../skills/worker-cli/SKILL.md)。平台函数见 [AGENTS.md](../AGENTS.md) 和 [skills/platform-ops-cli/SKILL.md](../skills/platform-ops-cli/SKILL.md)。
