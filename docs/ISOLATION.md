# 同账号隔离（REQ-9）

Funx 和 Demox 还在同一个腾讯云主账号里时，只允许停在下面这四道栅栏内。独立主账号加 CAM/OIDC 仍是门闩 B 的目标，开账号要 phosa 拍板，本页不代替那个决定，也不创建角色、库或函数。

机器可读的同一份规则在 `lib/isolation.js`。验收用例在 `test/isolation.test.js`，不访问云。

## 隔离边界

| 边界 | 允许 | 拒绝 |
| --- | --- | --- |
| SCF 命名空间 | 只有 `funx`。未设置 `FUNX_NAMESPACE` 时也是 `funx` | `default`、空串、`demox` 以及任何别的名字 |
| 资源前缀 | 用户函数 `funx-u-<name>`；平台函数只有 `funx-api`、`funx-router`、`funx-runtime`；标签 `codename=funx` | 没有前缀的函数、`demox-*`、把用户函数当成平台函数 |
| 资源六段名 | `qcs::scf:<region>:uin/<uin>:namespace/funx/function/<funx 函数名>` | `namespace/default`，或函数名通不过上面的前缀 |
| 数据库 | 库名 `funx`。账号是 `funx` 或 `funx_api` 这种 `funx` / `funx_<小写>` 形式。权限只给这个库的 SELECT、INSERT、UPDATE、DELETE、CREATE | 库名不是 `funx`；账号是 `root`、`demox` 或其他名字；SQL 点到 `funx_` 和 `information_schema` 以外的表 |
| CAM 草案 | 见下表。角色名是 `funx-ci-develop`、`funx-ci-production`、`funx-ci-runtime` | `demox-ci-*`；CI 碰到用户函数；`UpdateFunctionConfiguration`；production 碰到 COS 或改代码 |

`funx-api` 入口注释里仍写着广州、以及库所在的 VPC。那是生产拓扑，本页不改。把函数迁出 VPC 要单独拍板。

用户之间的隔离已经在 API 里：非管理员只能看见 `owner` 等于自己的 worker。那不是这道云账号栅栏。

## CAM 草案（未接线）

| 角色 | 允许 | 拒绝 |
| --- | --- | --- |
| `funx-ci-develop` | COS 只到 `scf-deploy/ci/`；对三支平台函数 `scf:UpdateFunctionCode`；只把别名 `develop` 切到这三支 | `scf:UpdateFunctionConfiguration`；用户函数 `funx-u-*`；别名 `production` |
| `funx-ci-production` | 只把别名 `production` 切到三支平台函数 | 改代码、COS、`UpdateFunctionConfiguration`、别名 `develop` |
| `funx-ci-runtime` | 本草案不授权任何动作。它不并进上面两个角色 | `UpdateFunctionConfiguration` |

GitHub `production` 环境仍要人工批准，OIDC 的 `sub` 绑到对应 environment。`.github/workflows/deploy.yml` 继续拒绝运行，也不申请 `id-token`。

## 验收用例

`node --test test/isolation.test.js` 覆盖下面每一条。

1. 命名空间只有 `funx`。`default`、`demox`、空串会被 `loadConfig` 拒绝；不设 `FUNX_NAMESPACE` 时得到 `funx`。
2. `funx-u-hello` 是用户函数。`funx-api` / `funx-router` / `funx-runtime` 是平台函数。`demox-api`、`funx-u-` 两边都不是。
3. 资源名带 `namespace/funx/function/funx-u-hello`。`default` 或 `demox-api` 组不出资源名。
4. 库名 `funx`、账号 `funx` 或 `funx_api` 通过。`demox`、`root`、`u` 在打开连接之前就被拒绝。
5. `api/store-mysql.js`、`api/workers-store.js` 和 `api/data-store.js` 的 SQL 只出现 `funx_` 表（健康检查可读 `information_schema`）。出现 `demox_users` 或裸表 `users` 会失败。
6. develop 能改平台函数代码、切 `develop` 别名、写 `scf-deploy/ci/`。它不能改 `funx-u-hello`、不能用命名空间 `default`、不能切 `production`、不能改函数配置。
7. production 只能切 `production` 别名。它不能改代码，也不能读 COS。runtime 角色在本草案里没有任何允许项。
8. 把用户函数写进 develop 的允许列表，或给 production 加 COS，草案审查会失败。
9. `deploy.yml` 仍打印 `deploy is not wired` 并退出，且没有 `id-token: write`。

## 这页做不到的事

- 不打开独立腾讯云主账号。
- 不把 Funx 送进 F1。进 F1 还要等 Demox 的证书备用和封禁邮件收完。
- 不把草案写成已生效的 CAM 策略。
