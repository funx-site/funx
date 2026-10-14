# AGENTS.md

本文件给改 Funx 仓库的 coding agent。用户 worker 的发布优先走 CLI，不要打开控制台。

## 先读

- 用户 worker（`fetch` 契约、`funx dev`、`funx deploy --name`、`funx var` / `funx secret`）：[skills/worker-cli/SKILL.md](skills/worker-cli/SKILL.md)
- 平台函数（`api-build` / `runtime-build` / `router-deploy` 相对 CI）：[skills/platform-ops-cli/SKILL.md](skills/platform-ops-cli/SKILL.md)
- Workers 契约和请求路径：[README.md](README.md)
- CLI 怎么安装、怎么跑：[cli/README.md](cli/README.md)

## 发布

- 用户 worker：`node cli/funx.js deploy <dir> --name <name>`（`npm link` 之后是 `funx`）。公开地址是 `https://<name>.funx.run`。
- 平台函数（`funx-api`、`funx-router`、`funx-runtime`）：接线之后，GitHub Actions 是唯一可信的发布路径。`.github/workflows/deploy.yml` 现在是骨架，会拒绝运行。不要手改这些 SCF，不要在对话里贴函数 URL。
- 本地只构建、不部署：`funx api-build`、`funx runtime-build`。

## 密钥

不要把密钥、STS、deploy key 或函数 URL 写进 git、聊天、日志或 Actions 输出。`funx secret put` 从 stdin 读值，CLI 不打印明文。
