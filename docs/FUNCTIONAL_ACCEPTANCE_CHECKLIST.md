# KZQ 功能验收清单

验收日期：2026-07-15

状态定义：只有本次真实执行并取得成功退出码或明确断言证据的项目标为“通过”；需要生产账号、真实 Supabase 项目、微信、邮件或通知服务的闭环保持“部分通过”。

## 自动化验收结果

| 范围           | 证据                                                                                   | 状态     |
| -------------- | -------------------------------------------------------------------------------------- | -------- |
| TypeScript     | `npm run check` 内执行 `npm run typecheck`，exit 0                                     | 通过     |
| ESLint         | `npm run check` 内执行 `npm run lint`，0 warning / 0 error                             | 通过     |
| 单元/服务层    | Vitest 14 个文件、67 个用例：i18n、搜索、询盘、CSV、统计、限流、管理员 API、通知、微信 | 通过     |
| Demo 构建      | `NEXT_PUBLIC_DEMO_MODE=true npm run build`，41/41 路由生成                             | 通过     |
| Demo E2E       | Playwright Chromium：390×844、1440×1000；6 项通过、2 项为互斥项目跳过                  | 通过     |
| 响应式矩阵     | 360、390、430、768、1024、1440；无横向溢出，移动底部导航/详情 CTA 不遮挡               | 通过     |
| 服务器页面语言 | Playwright 直接读取 response HTML：`/` 为 `zh-CN`，`/en` 为 `en`                       | 通过     |
| 数据库全新安装 | 隔离 Postgres 容器按 schema → policies → seed → cms_seed → migrations 执行             | 通过     |
| 旧库增量升级   | 从 `d5c5822` 基线应用 migration；管理员、产品、询盘哨兵保留                            | 通过     |
| RLS/权限矩阵   | anon、普通 authenticated、管理员、service_role SQL 断言                                | 通过     |
| 原子询盘写入   | 正常写入成功；强制 inquiry_items 触发器失败后主询盘不存在                              | 通过     |
| 真实环境 Smoke | `npm run test:smoke` exit 0，但因本机未配置真实 Supabase，4 项全部 skip                | 部分通过 |
| npm 安全审计   | `npm audit --json` 已执行；仍有 1 moderate / 4 high，修复仅提供 Next 16 主版本         | 部分通过 |

## 业务与安全验收

| 项目                    | 已验证内容                                                                                        | 状态                     |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| 中英文产品流程          | 首页、产品中心、搜索、一级分类、详情、加入询盘、清单数量、联系页                                  | 通过（Demo）             |
| 中文询盘                | 手机号校验、隐私拒绝、Demo 成功、成功后清空清单                                                   | 通过（Demo）             |
| 英文询盘                | Email、Destination Port、Trade Term、隐私链接、Demo 成功                                          | 通过（Demo）             |
| 询盘产品完整性          | 客户端名称/slug/封面被忽略；仅数据库公开产品生成快照；缺失/下架 ID 返回本地化 400                 | 通过（单元 + API + SQL） |
| 手工产品询盘            | 无 product_id/items 时仍允许 interested_product、quantity、message                                | 通过（单元）             |
| 管理员 API              | 每次服务端复核用户与 admin_profiles；普通用户 401；同源、JSON、大小、UUID、状态、字段长度、空更新 | 通过（单元/代码审计）    |
| CSV                     | UTF-8 BOM、中文、引号、换行、逗号、公式注入、当前筛选参数                                         | 通过（单元）             |
| Analytics               | 允许事件、非法名称/路径/外部 URL/UUID/长度、无个人表单字段                                        | 通过（单元）             |
| Rate limiter            | 窗口次数、超限、重置、过期清理、unknown IP 不共享全站桶                                           | 通过（单元）             |
| WeCom / Resend          | 未配置、成功、4xx、5xx、超时、非 JSON；失败不改变已入库结果                                       | 通过（适配器单元）       |
| 微信 token/ticket       | 未配置、成功、4xx/5xx、超时、非 JSON、过期刷新、缓存、并发合并                                    | 通过（适配器单元）       |
| 404/错误/SEO            | 产品/案例真实 notFound；404 noindex；英文错误页；详情 metadata 失败安全 fallback；同请求缓存      | 通过（代码 + 构建）      |
| 证书 Dialog             | 移动端打开并用 Escape 关闭                                                                        | 通过（Demo E2E）         |
| 生产 Supabase 读取/拒绝 | 已提供默认只读 Smoke；当前无真实环境变量，未执行请求                                              | 部分通过                 |
| 真实管理员账号          | 无真实普通账号/管理员账号，未做线上登录态闭环                                                     | 部分通过                 |
| 真实 WeCom/Resend/微信  | 无第三方密钥，未向外部服务发送                                                                    | 部分通过                 |
| 微信/iOS/Android 真机   | Playwright 响应式通过，未执行真机手势、分享和下载                                                 | 部分通过                 |

## 依赖结论

- `next` 与 `eslint-config-next` 已从 14.2.15 升至 14.2.35，并保持同版本。
- 14.2.35 是可用的 14.2.x 末版；当前 npm 审计中的后续 Next 公告只提供跨主版本修复。根据本任务“不升级到 Next 15 或更高”的限制，未运行 `npm audit fix --force`，残余风险必须由后续主版本升级任务处理。

## 发布前人工准备

1. 提供 staging Supabase URL/anon key 后运行 `npm run test:smoke`；若允许写入，再设置 `SMOKE_TEST_ALLOW_WRITES=true` 与 staging service role，确认 `[REGRESSION TEST]` 数据自动清理。
2. 使用普通 authenticated 与 `admin_profiles` 管理员账号验证后台登录、询盘更新、CSV 下载与 401/403。
3. 配置 staging WeCom、Resend、微信凭据，分别验证成功、4xx、5xx、超时和日志脱敏。
4. 在微信、iOS Safari、Android Chrome 做真机分享、证书缩放、资料下载和电话/WhatsApp 跳转。
5. 为 Next 15/16 单独建立升级任务，解决 npm audit 中无法在 14.2.x 回补的公告。
# 2026-07-16 Real Staging closure delta

| Area | Result | Evidence / next action |
| --- | --- | --- |
| Local check | Automated pass | 73 unit tests, lint, typecheck, Demo build |
| Dashboard failure handling | Fixed locally | explicit error state; no failure-to-zero fallback |
| Dashboard counts/list source | Fixed locally | one verified admin Supabase client; no mock import |
| Dashboard freshness | Fixed locally | dynamic + no-store; inquiry mutation revalidation |
| Clean public Staging URL | Blocked | EdgeOne platform returned 401 before project HTML |
| Real database counts | Not executed | local Staging secrets missing |
| Inquiry write smoke | Not executed | three explicit write gates not satisfied |
| Protected admin E2E | Not executed | administrator credentials missing |
| CRUD and Storage | Not executed | administrator/service credentials missing |
| Test-residual deletion | Not executed | source and exact UUIDs could not be verified |
| GitHub Staging workflow | Blocked | read-only Run 29437124679 failed because required Environment settings were empty; write run not triggered |
| China/WeChat network | Not executed | real-device and carrier evidence still required |

Acceptance must be rerun after this branch is deployed to an un-tokenized,
stable Staging domain. A Staging pass must not be described as Production.

# 2026-07-16 Stable domain acceptance delta

| Area | Result | Evidence / next action |
| --- | --- | --- |
| Remote `main` baseline | Automated pass | baseline and remote `main` are identical |
| Stable HTTPS routes | Automated pass | requested routes returned 200 on `h5.kzqdecor.com`; no preview auth or tokenized URL |
| Health | Automated pass | non-Demo Supabase provider on Node.js runtime |
| EdgeOne domain binding | Manual pass | Effective, HTTPS Deployed, linked to Production environment (Staging technical target only) |
| Deployment configuration | Blocked | public SEO output still reflects the prior project domain; redeploy required |
| HTTP downgrade protection | Blocked / P1 | HTTP returns 200 instead of HTTPS redirect |
| canonical / Open Graph / sitemap | Blocked / P1 | stale project-domain origin detected |
| Local lockfile install | Automated pass | isolated same-SHA copy, 521 packages, exit 0 |
| Local check | Automated pass | 17 files / 81 tests, lint/typecheck clean, 41/41 Demo build |
| Demo E2E | Automated pass | 6 passed, 2 expected skips |
| Read-only Staging workflow | Skipped by guard | deployment configuration mismatch; no run created |
| Write workflow, inquiries, CRUD, Storage | Not executed | read-only gate was not reached |
| Database counts, Dashboard and admin E2E | Not executed | credentialed acceptance stopped by deployment guard |
| Cleanup | Automated pass | no remote test record or file was created; nothing to delete |
| China/WeChat network | Not executed | real devices, carriers, home broadband and overseas comparison still required |

The deployed probe and Staging E2E now reject a wrong SEO origin and missing
HTTP-to-HTTPS redirect. They do not alter business behavior or platform state.

## 2026-07-17 Final Remote Staging acceptance update

| Acceptance item | Evidence | Result |
| --- | --- | --- |
| Stable HTTPS public routes, SEO origin and Health | real remote probe; all requested HTTPS routes returned 200 and Health reported non-Demo Supabase on Node.js | Automated pass |
| HTTP to HTTPS, path and query preservation | `/`, `/products`, and a query-bearing URL returned HTTP 200 without a redirect | Blocked / P1 |
| Local code regression | `npm ci` exit 0; `npm run check` exit 0 with 81 tests; Demo E2E exit 0 with 6 passed / 2 expected skips | Automated pass |
| Read-only GitHub Staging Workflow | deployment guard failed before dispatch | Skipped by guard |
| Remote database, Dashboard and administrator read-only acceptance | read-only Workflow did not pass | Not executed |
| Write Workflow, inquiries, CRUD and Storage | write guard remained closed | Not executed |
| Test-data cleanup | no remote test data or file was created | Automated pass: nothing to clean |

The local environment had all five credential variables `missing`; this does
not assert that GitHub Environment settings are missing because the guarded
Workflow was not dispatched. No credential value or protected identity was
read, printed, or saved.

