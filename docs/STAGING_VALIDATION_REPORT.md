# EdgeOne Staging 验证报告

> 历史记录：本报告记录 2026-07-15 至 2026-07-17 期间对 EdgeOne Staging 的远程验收执行情况。当前生产架构已确定为 EdgeOne + Supabase，正式部署分支为 `main`；本文件中的 `codex/edgeone-staging-validation` 分支引用是当时的预览分支，不再使用。中国大陆运营商、微信内置浏览器与真机验收仍属人工验收项，未在代码自动化中替代。

日期：2026-07-15。分支：`codex/edgeone-staging-validation`（历史预览分支，已被 `main` 取代）。基线：`51a3073167ed722f53d2aab9158ce14cf43c6a71`。

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
checks. The read-only run was triggered at
`https://github.com/kHuner9712/KZQH5/actions/runs/29437124679`.

- checkout, Node setup, `npm ci`, and Playwright install: **passed**;
- read-only Staging database verification: **failed** because all three required
  database settings were empty in GitHub Environment `staging`;
- Supabase smoke, EdgeOne probe, and deployed E2E: **skipped after failure**;
- explicitly enabled writes job: **skipped** because `allow_writes=false`.

The write run was not triggered because the required read-only pass did not
occur. Configure the missing Environment settings, rerun `allow_writes=false`,
and only after it passes rerun with `allow_writes=true`.

## Remaining decision boundary

No WeChat, China Mobile, China Unicom, China Telecom, home broadband, iOS
Safari, Android browser, or overseas comparison evidence was collected. ADR-001
therefore remains **Pending real network validation**.

# 2026-07-16 Stable Domain Remote Staging Acceptance

Baseline: `cd21b755a9e13a7a224b10cf04c3224946560aad`

Stable Staging domain: `https://h5.kzqdecor.com`

## Deployment and public-domain result

- **Manual pass**: the EdgeOne domain table showed `h5.kzqdecor.com` as
  Effective, HTTPS as Deployed, and the linked environment as Production.
- **Automated pass**: all requested HTTPS routes returned HTTP 200 on the
  stable host without an EdgeOne 401 page, preview authentication page,
  redirect loop, project-domain redirect, or preview query parameter.
- **Automated pass**: `/api/health` returned `success=true`, `demo=false`,
  `dataProvider=supabase`, and `runtime=nodejs`; `commit=unknown` was accepted.
- **Blocked**: the EdgeOne deployment list did not yield a reliable commit-SHA
  read through the console session. Remote GitHub `main` was independently
  confirmed identical to the baseline.
- **Blocked / P1**: the deployed HTML and sitemap still used the previous
  EdgeOne project domain for canonical, Open Graph, and sitemap URLs. The
  deployed artifact therefore has not absorbed the required stable
  `NEXT_PUBLIC_SITE_URL` configuration and must not be used to validate the
  latest Staging configuration.
- **Blocked / P1**: plain HTTP returned 200 instead of redirecting to HTTPS.

Per the deployment-version guard, no GitHub Staging workflow was triggered and
no remote write was attempted. Both read-only and write Workflow URLs are
therefore **Not executed / Skipped by guard**, not Passed.

## Local regression

The checked-out working directory had unrelated live Node file locks. No
unrelated process was inspected or terminated. A clean archive of the same SHA
was tested in an isolated temporary directory.

| Command | Exit | Result | Classification |
| --- | ---: | --- | --- |
| `npm ci` in the active workspace | 1 | npm cache permission failure | Local tool failure; superseded |
| two workspace cache retries | 1 each | stopped after prolonged file-lock stalls | Local tool failure; superseded |
| `npm ci` | 0 | 521 packages installed from the lockfile in the isolated copy | Automated pass |
| `npm run check` | 0 | typecheck and lint clean; 17 files / 81 unit tests; Demo build 41/41 pages | Automated pass |
| `npm run test:e2e:demo` on the occupied default port | 1 | reused an unrelated existing server; 5 failed, 1 passed, 2 skipped | Local port conflict; superseded |
| `PORT=3117 npm run test:e2e:demo` | 0 | 6 passed, 2 expected skips | Automated pass |
| `BASE_URL=https://h5.kzqdecor.com npm run check:deployed` (original probe) | 0 | exposed a false-pass coverage gap | Fixed |
| strengthened deployed probe against the same URL | 1 | correctly rejected HTTP downgrade and stale SEO origins | Automated regression evidence |

The first workspace `npm ci` attempt failed because npm could not write its
global cache. Two subsequent workspace attempts were stopped after prolonged
Windows file-lock stalls. The isolated-copy command above is the final result.
The first workspace Demo E2E result was also superseded by the isolated-port
rerun; no unrelated server process was stopped.

## Guarded acceptance areas

| Area | Status | Reason |
| --- | --- | --- |
| Read-only GitHub workflow and step statuses | Skipped by guard | deployed stable-domain configuration mismatch |
| Remote database count summary and permission matrix | Not executed | workflow intentionally not triggered |
| Dashboard/database comparison and recent inquiries | Not executed | deployment guard stopped credentialed acceptance |
| Protected admin E2E and CSV | Not executed | deployment guard stopped credentialed acceptance |
| Inquiry write matrix and exact cleanup | Not executed | read-only gate did not pass |
| CRUD and Storage | Not executed | write gate did not run |
| Existing inquiry classification or deletion | Not executed | no rows or identifiers were read; nothing deleted |

## Regression coverage and rollback

The deployed probe now verifies the stable origin for canonical/Open Graph,
sitemap origin, HTTP-to-HTTPS redirect, absence of the EdgeOne project domain,
preview-auth pages, stable final host, and the complete Health provider/runtime
contract. Staging E2E now enforces the same origin and downgrade checks.

No Secret, administrator identifier, user identifier, inquiry contact, database
row, or diagnostic token was printed or stored. No database, Storage, DNS,
EdgeOne setting, seed, migration, RLS policy, or production resource was
modified.

Rollback is limited to reverting the probe/E2E assertion commit or redeploying
the prior EdgeOne artifact. The correct forward action is to redeploy current
`main` after the stable site URL is saved and enable an EdgeOne HTTP-to-HTTPS
redirect, then rerun `allow_writes=false`. Only a complete read-only pass may
unlock `allow_writes=true`.

# 2026-07-17 Final Remote Staging Acceptance Execution

Baseline: `b8440fdaeca0557b8d81ca2f93ff992bfbcfaaa6`.

Stable Staging URL: `https://h5.kzqdecor.com`.

## Result

The deployment configuration gate **failed**. Every requested HTTPS route
returned 200 without an EdgeOne 401, preview-auth page, preview query token, or
redirect to an `edgeone.dev` host. Canonical, Open Graph URL, and sitemap
origins used the stable HTTPS host. `/api/health` was an **Automated pass** with
`success=true`, `demo=false`, `dataProvider=supabase`, and `runtime=nodejs`.
The Health commit remained `unknown`, so the EdgeOne deployment SHA is
**Blocked** and is not inferred from the repository baseline.

Plain HTTP was the blocking P1 result. Both `/` and paths containing query
parameters returned HTTP 200 with zero redirects. Therefore HTTPS enforcement,
path preservation, and query-string preservation did not pass. The existing
deployment probe was minimally extended to assert the latter two properties on
future runs; this is **Fixed** test coverage, not a fix to the remote EdgeOne
configuration.

Per the write safety gate, no GitHub Workflow was triggered. The read-only
Workflow URL/Run ID/Step statuses and the write Workflow URL/Run ID/Step
statuses are **Skipped by guard**. Remote database counts and permission
checks, Dashboard comparison, protected administrator E2E, inquiry acceptance,
CRUD, and Storage are **Not executed**. No remote row or file was created,
updated, or deleted, so cleanup is an **Automated pass: nothing to clean**.

## Local regression evidence

| Command | Exit | Result | Classification |
| --- | ---: | --- | --- |
| `BASE_URL=https://h5.kzqdecor.com npm run check:deployed` | 1 | HTTPS/SEO/Health passed; HTTP returned 200 with no redirect | Blocked / P1 |
| HTTP path/query header probes | 0 | both responses were 200, not redirects | Automated failure evidence |
| `npm ci` | 0 | 521 packages installed from the lockfile | Automated pass |
| `npm run check` | 0 | typecheck and lint clean; 17 test files / 81 unit tests; Demo build 41/41 pages | Automated pass |
| `PORT=3129 npm run test:e2e:demo -- --output=.tmp-final-remote-staging-demo-e2e` | 0 | 6 passed, 2 expected skips | Automated pass |

The Playwright tests completed before its dedicated Windows WebServer stopped.
Only the PID printed by that run was terminated; the test command then exited
0. No unrelated process was inspected or stopped.

## Acceptance summary

| Area | Result |
| --- | --- |
| Operator-supplied domain, TLS, environment and GitHub-secret configuration | Manual pass; no values were read or printed |
| EdgeOne deployment SHA | Blocked (`/api/health.commit=unknown`) |
| Stable HTTPS routes, no 401/preview token/project-domain redirect | Automated pass |
| Canonical, Open Graph URL, sitemap stable origin | Automated pass |
| HTTP to HTTPS with path and query preservation | Blocked / P1 |
| Read-only Staging Workflow | Skipped by guard |
| Write-enabled Staging Workflow | Skipped by guard |
| Database count-only summary and RLS matrix | Not executed |
| Dashboard comparison and administrator E2E | Not executed |
| Inquiry write matrix and exact cleanup | Not executed |
| CRUD and Storage | Not executed |
| Secret safety | Automated pass; no Secret, administrator identity, user UUID, inquiry contact, connection string, or test token was printed or stored |

No seed, migration, RLS policy, authentication behavior, visual design,
database, Storage, DNS, or CloudBase resource was changed. The remote rollback
path is to revert the EdgeOne redirect-rule change if the operator later applies
one; the repository rollback path for this execution is to revert the probe and
documentation commit. After fixing HTTP enforcement, rerun the read-only
Workflow first and enable writes only after every required read-only step passes.
