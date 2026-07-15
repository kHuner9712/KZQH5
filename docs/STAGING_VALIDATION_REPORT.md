# EdgeOne Staging 验证报告

日期：2026-07-15。分支：`codex/edgeone-staging-validation`。基线：`51a3073167ed722f53d2aab9158ce14cf43c6a71`。

## 已实际执行

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm ci` | 通过，exit 0 | 按 lockfile 安装 521 packages；npm 报告 1 moderate / 4 high 的现有审计项，未运行破坏性 `audit fix --force` |
| `npm run check` | 通过，exit 0 | typecheck、lint、73 unit tests、Demo production build 全部通过；41 个静态页面生成完成 |
| `npm run test:e2e:demo` | 通过，exit 0 | 6 passed、2 个按 viewport/project 设计 skip；覆盖 390×844 与 1440×1000 截图以及 360/430/768/1024 响应式矩阵 |
| `npm run test:database` | 通过，exit 0 | 临时 PostgreSQL 16 容器；fresh install、incremental upgrade、RLS permission matrix、旧数据哨兵、原子写入/回滚通过；容器已停止并自动删除 |
| `node --check scripts/*.mjs` | 通过 | 所有 `.mjs` 语法检查通过 |
| 当前文件与 Git 历史 secret 模式扫描 | 通过 | 未发现 Supabase service role、EdgeOne token、CloudBase secret、私钥或管理员密码候选；仅 `.env.example` / `.env.demo.example` 被 Git 跟踪 |

第一次受限环境中的 `npm ci` 因 npm 无法写本机 cache 而报 npm 自身错误；在允许访问 cache 后对同一 lockfile 重跑成功，最终结果以上表 exit 0 为准。Demo build 的 webpack cache snapshot 警告不影响构建 exit 0。

## 未执行 / 被阻塞

| 项目 | 状态 | 阻塞原因 |
| --- | --- | --- |
| EdgeOne Makers Demo/全栈部署 | 被阻塞 | 无 EdgeOne 登录/项目权限和部署 URL |
| `npm run test:smoke` 对真实 Staging | 被阻塞 | 无已确认的独立 Supabase Staging URL/anon key |
| 写入 Smoke | 被阻塞 | 无 Staging service role 与写入授权 |
| `BASE_URL=... npm run check:deployed` | 被阻塞 | 无 EdgeOne Staging URL |
| `PLAYWRIGHT_BASE_URL=... npm run test:e2e:staging` | 被阻塞 | 无 EdgeOne Staging URL |
| 真实 Storage、管理员、CSV | 被阻塞 | 无 Staging Storage 资源与真实测试管理员账号 |
| WeCom / Resend / 微信 JS-SDK | 被阻塞 | 无 Staging 第三方凭据、公众号安全域名与测试账号 |
| GitHub `staging` Environment | 被阻塞 | 无仓库 Environment/Secrets 管理权限 |
| 中国移动/联通/电信/家庭宽带与微信真机 | 被阻塞 | 无部署 URL 和当地真机测试人员 |

本报告没有用 Demo 结果替代真实 Staging，也没有将任何被阻塞项目标为通过。

## 新增环境变量

- 部署可选：`STAGING_DIAGNOSTICS_ENABLED`、`STAGING_DIAGNOSTICS_TOKEN`。
- 本机初始化：`DATABASE_STAGING_URL`、`KZQ_STAGING_PROJECT_REF`、`KZQ_STAGING_CONFIRMATION`。
- 明确写入开关：`SMOKE_TEST_ALLOW_WRITES`、`STAGING_E2E_ALLOW_WRITES`。
- 部署探测：`BASE_URL`、可选 `EXPECT_DEMO_MODE`。
- Staging E2E：`PLAYWRIGHT_BASE_URL`。

## 安全与回滚

- 健康接口不访问数据库、不输出 URL/key/user/stack，响应 `Cache-Control: no-store`。
- 诊断未启用时 404；启用后要求 Bearer token，只读且只返回成功状态/耗时。
- 远程初始化要求确认串、项目 ref 匹配和空 `public` schema；不提供 reset/drop/delete-all。
- 写入测试只清理由本次创建的明确 UUID 与 `[REGRESSION TEST]` 标记。
- 默认 Smoke 中的 anon 写权限拒绝性断言使用 PostgREST `tx=rollback`，即使策略异常也请求事务回滚。
- 代码回滚：回退本 PR/部署到 EdgeOne 上一个 deployment；关闭两个诊断变量即可让诊断恢复 404。
- 本阶段没有修改任何远程数据库、Storage、DNS 或正式域名，因此不存在远程数据回滚操作。以后若执行 migration，按数据库 Runbook 的备份与停止点处理，不运行 seed 回滚已有库。
# 2026-07-16 Real Staging closure execution

Baseline: `0a112f86a11eac2a282ad5c2c7bcb811d601bc22`
Target: `https://kzqh5.edgeone.dev` (Staging only; not Production)

## Status legend

- **Automated pass**: completed in this execution with exit code 0.
- **Manual pass**: supplied by the operator and not substituted for automation.
- **Fixed**: code changed locally; requires a new EdgeOne deployment before remote acceptance.
- **Blocked**: an external credential, tool, or platform access condition prevented execution.
- **Not executed**: prerequisites were intentionally not bypassed.

## Environment and baseline results

All six Staging secrets were `missing` in the local execution environment. No
secret value, prefix, length, partial value, or token was printed.

| Command | Exit | Tests/result | Classification |
| --- | ---: | --- | --- |
| `npm ci` | 0 | 521 packages installed; 5 audit findings (1 moderate, 4 high) | Automated pass |
| `npm run check` | 0 | 17 files / 81 unit tests passed; lint clean; Demo build passed | Automated pass |
| `npm run test:e2e:demo` | 0 | 6 passed, 2 expected skips; connected to the already-running local Demo server to avoid Windows web-server cleanup hang | Automated pass |
| `npm run test:database` | 1 | `psql` unavailable (`ENOENT`) | Blocked (local tool) |
| `npm run test:database:staging` | 1 | Staging URL and anon key missing | Blocked (credentials) |
| `npm run test:smoke` | 0 | 1 file / 5 tests skipped because Staging credentials and write opt-in were absent | Not executed (guarded) |
| `BASE_URL=https://kzqh5.edgeone.dev npm run check:deployed` | 1 | all clean-URL probes returned EdgeOne 401 | Blocked (Preview protection) |
| `PLAYWRIGHT_BASE_URL=https://kzqh5.edgeone.dev npm run test:e2e:staging` | 1 | 14 tests: 6 public failures on the EdgeOne 401 page; 8 guarded write/admin tests skipped | Blocked (Preview protection / credentials) |

The local Node runtime was 24.15.0; EdgeOne remains configured for Node 20 by
`.nvmrc`. Final CI evidence must therefore come from the Node 20 workflow.

## Manual evidence supplied by the operator

- `/api/health`: `success=true`, `demo=false`, `dataProvider=supabase`,
  `runtime=nodejs`.
- A Supabase administrator can log in to `/admin`.
- EdgeOne runs the App Router and Route Handlers.

These are recorded as **Manual pass**, not as results of this automated run.

## Dashboard integrity defect and fix

Root cause: the Dashboard issued five Supabase `HEAD` count requests and one
separate recent-inquiry `GET`. It discarded every count query `error` and
converted both `null` and failure to `0` with `count || 0`, while the successful
recent list remained visible. This exactly permits “all cards are zero, recent
inquiries has rows.” The Dashboard did not import mock data; both paths used the
same verified administrator client.

Fixed locally:

- centralized all six reads in one repository/service policy;
- changed counts to exact `GET` queries returning at most one row, avoiding the
  observed EdgeOne `HEAD` risk while preserving exact totals;
- treats an error or missing count as a failed snapshot, never as zero;
- renders `数据读取失败` and logs only safe query identifiers;
- marks the Dashboard `no-store` in addition to its existing dynamic rendering;
- makes the layout unread count use the same non-HEAD behavior;
- revalidates `/admin` and `/admin/inquiries` after inquiry mutations;
- added 8 unit tests for real/non-mock rows, two-row consistency, error state,
  empty tables, unread totals, publish changes, certificate changes, and error
  detail non-disclosure.
- added protected admin E2E with trace/screenshot/video disabled: anonymous and
  invalid-password rejection, login, live count comparison, admin lists, CSV,
  logout, and explicitly gated exact-UUID inquiry mutation/cleanup.

The fix is **not yet remotely accepted** because this branch has not been
deployed and the clean Staging URL is currently protected.

## Database counts and residual inquiries

Actual counts were **not executed** because the service role was missing. The
read-only verifier now prints only the required counts when the service role is
available; it never prints contacts, inquiry bodies, UUIDs, administrator email,
or Auth data. The two visible inquiries could not be safely classified. No row
or `inquiry_items` record was deleted.

## Write, admin, CRUD, and Storage acceptance

- Staging inquiry writes: **not executed**; all three write gates were absent.
- Protected admin E2E: **not executed**; admin credentials were absent.
- Admin CRUD regression: **not executed**; admin credentials were absent.
- Storage write/delete regression: **not executed**; administrator credentials
  and service role were absent.
- No seed file, historical migration, remote database reset, or production data
  operation was performed.

## EdgeOne preview layer and Health commit

Clean requests return `401`, `<html lang="en">`, and title `Tencent Edgeone`
before project HTML is reached. EdgeOne's official error-code documentation
defines this as expired preview authentication and states preview links last
three hours. This is platform behavior, not KZQ Demo mode.

Do not add preview query tokens to automation, canonical, sitemap, Open Graph,
sharing URLs, or `NEXT_PUBLIC_SITE_URL`. For stable Staging access, use EdgeOne
Makers console → **Domain Management** → add a custom domain → associate it with
the **Preview** environment. The official documentation does not describe a
runtime-injected Git commit SHA variable, so `/api/health.commit=unknown` remains
an accepted fallback.

## GitHub workflow

The workflow now runs the non-destructive Staging database verifier (including a
count-only summary when service role is configured) before smoke and deployment
checks. Triggering both `allow_writes=false` and `allow_writes=true` is
**blocked** locally because `gh auth status` reports an invalid token. No
Workflow Run URL exists for this execution.

## Remaining decision boundary

No WeChat, China Mobile, China Unicom, China Telecom, home broadband, iOS
Safari, Android browser, or overseas comparison evidence was collected. ADR-001
therefore remains **Pending real network validation**.
