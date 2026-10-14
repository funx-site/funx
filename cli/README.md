# Funx CLI

`funx` 把一个 Workers 风格的 worker 部署到 `https://<name>.funx.run`。仓库里的入口是 `cli/funx.js`。`package.json` 的 `bin.funx` 指向这个文件。

计划中的 npm 包名是 `@funx-site/cli`，命令名仍是 `funx`。包还没有发布。不要执行 `npm publish`，也不要用 `npx @funx-site/cli` 去注册表安装。当前 `package.json` 的 `name` 仍是仓库内的 `funx-mvp`，并且 `private: true`。

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

Agent 用法见 [AGENTS.md](../AGENTS.md)、[skills/worker-cli/SKILL.md](../skills/worker-cli/SKILL.md) 和 [skills/platform-ops-cli/SKILL.md](../skills/platform-ops-cli/SKILL.md)。
