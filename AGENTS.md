# AGENTS.md

本文件给改 Funx 仓库的 coding agent。用户和 agent 部署 worker 走公开 skill 与 CLI，不要打开控制台，也不要按本仓库的操作者 CLI 给用户写部署步骤。

## 先读

- 用户 / agent worker（权威）：[funx-site/skill](https://github.com/funx-site/skill)、[funx-site/cli](https://github.com/funx-site/cli)（`@funx-site/cli`，尚未发布）。本仓库只留指针：[skills/worker-cli/SKILL.md](skills/worker-cli/SKILL.md)
- 平台函数（`api-build` / `runtime-build` / `router-deploy` 相对 CI）：[skills/platform-ops-cli/SKILL.md](skills/platform-ops-cli/SKILL.md)
- Workers 契约和请求路径：[README.md](README.md)
- 本仓库操作者 CLI（平台内部）：[cli/README.md](cli/README.md)

## 发布

- 用户 worker：按 funx-site/skill 与 funx-site/cli。公开地址是 `https://<name>.funx.run`。
- 平台函数（`funx-api`、`funx-router`、`funx-runtime`）：接线之后，GitHub Actions 是唯一可信的发布路径。`.github/workflows/deploy.yml` 现在是骨架，会拒绝运行。不要手改这些 SCF，不要在对话里贴函数 URL。
- 本地只构建、不部署：`funx api-build`、`funx runtime-build`。

## 密钥

不要把密钥、STS、deploy key 或函数 URL 写进 git、聊天、日志或 Actions 输出。不要打印明文密钥。
