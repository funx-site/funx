---
name: funx-worker-cli
description: Thin pointer. User and agent worker deploys go through funx-site/skill and funx-site/cli (@funx-site/cli, not published yet). Do not use this file as a deploy cookbook. Do not put secrets in git.
---

# Funx 用户 worker：公开 skill 与 CLI

用户和 agent 部署 worker，权威来源是这两个仓库，不是本文件：

- Skill：https://github.com/funx-site/skill
- CLI：https://github.com/funx-site/cli（`@funx-site/cli`，尚未发布到 npm）

Workers 契约仍以本仓库 [README.md](../../README.md) 为准。平台函数（`funx-api`、`funx-router`、`funx-runtime`）留在 [platform-ops-cli](../platform-ops-cli/SKILL.md)。

不要把密钥、`.dev.vars`、`.env*`、`*.pem`、`*.key` 写进 git，也不要在聊天、日志或 PR 里粘贴密钥或函数 URL。
