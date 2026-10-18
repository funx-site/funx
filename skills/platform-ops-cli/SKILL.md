---
name: funx-platform-ops-cli
description: Operate Funx platform functions with the Funx CLI. Use when choosing funx api-build, runtime-build, or router-deploy versus GitHub CI. Never print function URLs or secret values. Funx uses its own cloud account tagged codename=funx. Do not borrow demox-ci-* roles.
---

# Funx 平台函数：CLI 与 CI

只在改「平台自己」时用这份技能：`funx-api`、`funx-runtime`、`funx-router`。用户 worker 走 [worker-cli](../worker-cli/SKILL.md)（再指向 funx-site/skill 与 funx-site/cli），不要用这里的平台命令。

安装与入口见 [cli/README.md](../../cli/README.md)。权限边界的文字规则在 [.github/workflows/deploy.yml](../../.github/workflows/deploy.yml)，尚未接线。

## 什么时候用哪条命令

| 目的 | 命令 | 会不会改线上 |
| --- | --- | --- |
| 只打 funx-api 包 | `node cli/funx.js api-build [out.zip]` | 不会。默认 `dist/funx-api.zip` |
| 只打 funx-runtime 包 | `node cli/funx.js runtime-build --api https://<funx-api host> [out.zip]` | 不会。默认 `dist/funx-runtime.zip` |
| 创建或更新 funx-router | `node cli/funx.js router-deploy` | 会。要 STS 和 deploy key |
| 创建或更新 funx-runtime | `node cli/funx.js runtime-deploy <zip>` | 会。令牌用 `FUNX_RUNTIME_TOKEN` 或文件，命令不打印令牌 |

`api-build` 和 `runtime-build` 可以在本地核对包。它们不是发布。

`router-deploy` 和 `runtime-deploy` 仍是操作者命令，留在 CLI 里。它们不是平台函数的可信发布路径。接线之后，平台函数只从 GitHub Actions 发。在那之前，`.github/workflows/deploy.yml` 是骨架：`workflow_dispatch` 会打印 `deploy is not wired` 并失败。不要为了「先发出去」改这个失败，也不要在对话里补 OIDC、CAM、COS 或 `id-token`。

## 账号和角色

- Funx 使用独立云账号。资源标签是 `codename=funx`。还在同一个主账号里时，命名空间、库和 CAM 草案以 [docs/ISOLATION.md](../../docs/ISOLATION.md) 为准。独立主账号仍要 phosa 拍板后才开。
- 不要借用、假定或引用 `demox-ci-*` 角色，也不要把 Demox 的命名空间、桶或账号当成 Funx 的。
- 将来的 app 层是两个角色，别名写死在各自策略里：`develop` 才能上传、`GetObject`、`UpdateFunctionCode` 并切换 **develop** 别名；`production` 只能切换 **production** 别名，没有 COS，也没有 `UpdateFunctionCode`。
- `UpdateFunctionConfiguration` 保持 Deny。运行时底座是另一个角色 `funx-ci-runtime`，不要并进 app 角色。
- 这些角色只覆盖带 `codename=funx` 的平台函数，不覆盖用户函数（`funx-u-*`）。COS 只到 `scf-deploy/ci/*`（或 Funx 等价前缀）。
- GitHub Environments 将是 `develop` 和 `production`。`production` 要人工批准。OIDC 的 `sub` 绑到对应 environment。正式 CAM 策略卡仍要云架构出具，Chief 批准后才能接线。

## 不要做的事

- 不要打印函数 URL（`*.tencentscf.com`）或任何密钥、令牌、deploy key。路由日志只有名字、状态码和耗时。
- 不要手改平台 SCF（控制台或裸 tccli）。不要把用户 worker 的发布做成对这三支函数的更新。
- 不要把密钥写进 git、Actions、聊天或日志。`runtime-secrets` 把文件写成 `0600`，并且不打印内容。
