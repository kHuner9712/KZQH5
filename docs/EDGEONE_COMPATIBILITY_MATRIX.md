# EdgeOne Makers 兼容性矩阵

审计日期：2026-07-15。项目基线：`51a3073167ed722f53d2aab9158ce14cf43c6a71`。

判定规则：只有 EdgeOne Makers 官方文档逐项明确的能力才记为“明确支持”；“Next.js 全栈支持”不自动推导到未列出的 API。未明确项统一写为“需要实际部署验证”。

## 官方依据

- [Next.js Framework Guide](https://pages.edgeone.ai/document/framework-nextjs)：明确支持 Next.js 13.5+、14、15、16；App Router、SSR、ISR、SSG、RSC、streaming、middleware、Route Handlers、图片优化；标准全栈构建输出为 `.next`。
- [Build Guide](https://pages.edgeone.ai/document/build-guide)：Git 导入可自动识别框架；可设置 root/build/output/install；支持 Node 20.18.0；`.nvmrc` 可切换版本；项目环境变量当前对所有环境生效。
- [Cloud Functions](https://pages.edgeone.ai/document/cloud-functions)：Node.js v20.x；请求/响应体 6 MB；默认 30 秒、可配置到 120 秒；不建议把函数本地文件当持久化存储。
- [Build Output Configuration](https://pages.edgeone.ai/document/building-output-configuration)：全栈 SSR Node 产物位于 `.edgeone/cloud-functions/ssr-node/`，API Node 产物另有目录。
- [Limits](https://pages.edgeone.ai/document/limits-and-quotas)：免费额度和限制可能调整；构建 20 分钟、4 核 6 GB；Cloud Functions 包 128 MB、请求体 6 MB。

## 项目逐项审计

| 能力 | 当前项目使用 | 官方状态 | 配置/降级 | 结论 |
| --- | --- | --- | --- | --- |
| Next.js 14.2.35 | 是，锁定版本 | 明确支持 Next.js 14 | Node 20，`npm ci`，`npm run build` | 官方兼容；仍需真实构建 |
| App Router | 是 | 明确支持 | 无额外配置 | 官方兼容；需真实路由验证 |
| 多个 Root Layout | 是，中文 `(public)` 与 `/en` 独立根布局 | 未逐项说明 | 无安全静态降级 | **需要实际部署验证** |
| Server Components | 是，公共页面服务端读 CMS/Supabase | 明确支持 RSC | Demo 先排除 Supabase 网络 | 官方兼容；需真实流式/错误验证 |
| API Route Handlers | 是，询盘、统计、后台、OG、微信、健康/诊断 | 明确支持 | 健康/诊断显式 Node runtime | 官方兼容；每个 API 需探测 |
| 动态路由 | 是，产品/案例 slug 与 catch-all 404 | 仅明确文件路由，未逐项说明动态段 | 无静态导出降级 | **需要实际部署验证** |
| ISR / `revalidate` | 是，公共页面和 sitemap 为 300 秒 | 明确支持；`revalidatePath` 标为实验性 | 本项目不依赖 on-demand `revalidatePath` | 官方兼容；缓存时效需实测 |
| `generateMetadata` | 是 | 未逐项说明 | 页面可渲染，但 SEO 不允许无声降级 | **需要实际部署验证** |
| `sitemap.ts` | 是 | 未逐项说明 | `/sitemap.xml` 纳入探测/E2E | **需要实际部署验证** |
| `robots.ts` | 是 | 未逐项说明 | `/robots.txt` 纳入探测/E2E | **需要实际部署验证** |
| `ImageResponse` / 动态 OG | 是，`/api/og` 显式 Edge runtime | 未明确说明 `next/og` | 普通 metadata 仍可工作；动态图需单独验收 | **需要实际部署验证** |
| `next/image` | 是，本地和 Supabase 图片 | 明确支持，零配置，仅 WebP 转换 | 保留现有 `remotePatterns` | 官方兼容；远程 Supabase 图需实测 |
| cookies | 是，仅后台 Supabase SSR Auth | Next.js 页面未逐项说明 cookies | Auth 必须真实管理员闭环 | **需要实际部署验证** |
| Supabase SSR Auth | 是，`@supabase/ssr` + cookies | 未明确说明 | 不改写 Auth；真实账号验收 | **需要实际部署验证** |
| Node.js runtime | 是，数据库、通知、微信、健康/诊断 | Cloud Functions 明确 Node v20.x；Next adapter 映射未逐路由说明 | `.nvmrc=20`，Node 路由显式 runtime | **需要实际部署验证** |
| AbortController | 是，通知、微信及浏览器请求超时 | 未逐项说明 | Node 20 原生具备，但平台行为不作推断 | **需要实际部署验证** |
| 服务端 `fetch` | 是，WeCom、Resend、微信、Storage 诊断 | Cloud/Edge runtime 有网络能力，但 Next adapter 出网未逐项说明 | 所有外呼已有超时 | **需要实际部署验证** |
| 环境变量 | 是 | 明确支持，名称 255 bytes、值 500 bytes | 当前变量对项目所有环境生效；Demo 与 Staging 建议独立 Makers 项目 | 官方支持；作用域需控制台确认 |
| 文件上传 | 是，浏览器直传 Supabase Storage | EdgeOne 未说明该组合 | 上传不经过 KZQ Route Handler；受 Supabase、浏览器和网络限制 | **需要实际部署验证** |
| 请求体大小 | 是，询盘 32 KB、后台 16 KB、统计 8 KB | Cloud Functions 为 6 MB | 应用上限远低于平台上限；浏览器直传另算 | 映射到 Cloud Function 仍需部署验证 |
| API 超时 | 是，外呼 8 秒、表单 15 秒 | Cloud Functions 默认 30 秒，可到 120 秒 | 不新增 `edgeone.json` 超时配置 | 官方限制明确；路由映射需实测 |
| Serverless 实例内存状态 | 是，限流、微信 token/ticket、single-flight | 官方说明 serverless 动态伸缩，未保证实例共享 | 只能 best-effort；多实例不强一致，正式需 KV/Redis/WAF | 存在明确降级 |
| Edge 与 Node runtime 差异 | 是，OG 为 Edge，其余默认/显式 Node | 两种函数有不同 API/包体/请求体限制 | 不把 Node crypto/Supabase SSR 移到 Edge | 两条 runtime 都需真实部署验证 |

## 最小构建配置

- Framework preset：Next.js。
- Root directory：`./`。
- Install command：在控制台显式设置 `npm ci`（官方默认是 `npm install`，但支持 npm lockfile）。
- Build command：`npm run build`。
- Output directory：`.next`。
- Node.js：仓库 `.nvmrc` 为 20；控制台同时选择 Node 20。
- 不新增 `edgeone.json`：当前没有已确认的函数地域、重写或超时需求，虚构配置反而会固定未经验证的部署决策。

## 部署门槛

先部署无 Supabase 依赖的 Demo Preview，再部署独立 Supabase Staging。兼容性矩阵中的“需要实际部署验证”只有在部署日志、`check:deployed`、Staging E2E 或人工记录提供证据后才能更新。
# 2026-07-16 deployment evidence update

| Capability | Evidence | Current conclusion |
| --- | --- | --- |
| Clean project domain access | `https://kzqh5.edgeone.dev` returned platform 401 on every route | Blocked by EdgeOne preview authentication |
| Preview notice source | 401 HTML title is `Tencent Edgeone`; project `<main>` is absent | Platform layer, not KZQ Demo mode |
| Stable Staging entry | Official Makers docs recommend a custom domain associated with Preview | Console/DNS action pending; no DNS changed here |
| Dashboard counts | Existing `HEAD` counts could fail while recent `GET` succeeds | Replaced locally with exact limited GET + explicit errors |
| Health commit | Official environment-variable docs list no injected commit SHA | `unknown` remains supported fallback |
| Canonical / OG / sitemap tokens | Automated assertions reject EdgeOne preview query parameters | Added; remote run blocked by 401 |
| GitHub Staging workflow | Run 29437124679 reached the database gate after setup/install passed | Blocked by empty GitHub Environment settings; writes correctly skipped |

The EdgeOne console path for a stable test entry is **Domain Management → Add
custom domain → Associate with Preview environment**. Temporary three-hour
preview URLs must not be persisted in repository configuration or SEO output.

# 2026-07-16 stable-domain evidence update

| Capability | Evidence | Current conclusion |
| --- | --- | --- |
| Custom domain | `h5.kzqdecor.com` showed Effective | Manual pass |
| Custom-domain TLS | HTTPS showed Deployed and HTTPS requests validated successfully | Manual + automated pass |
| Environment link | domain table showed Production | Manual pass; this remains a Staging technical acceptance target |
| Public Next.js routes | requested Chinese, English, admin-login, metadata and Health routes returned 200 | Automated pass |
| Preview protection removal | no 401, `Tencent Edgeone` page, project-domain redirect, or preview parameter on stable HTTPS routes | Automated pass |
| Health Route Handler | Supabase, non-Demo, Node.js result | Automated pass |
| Stable SEO origin | canonical, Open Graph and sitemap still reference the previous project domain | Blocked / P1; redeploy after environment update |
| HTTP-to-HTTPS | HTTP returned 200 directly | Blocked / P1; enable EdgeOne redirect |
| Deployment SHA | console list could not be read reliably in this execution | Blocked; stale SEO output already prevents acceptance |
| Probe coverage | stable final host, preview-auth page, exact SEO origin, sitemap origin, Health provider/runtime and HTTP redirect are now asserted | Fixed locally |

The remote read-only/write workflows remain guarded until a new deployment
serves the stable origin and HTTP redirects to HTTPS. No EdgeOne configuration
was changed during this execution.

# 2026-07-17 final remote gate evidence

| Capability | Evidence | Current conclusion |
| --- | --- | --- |
| Stable HTTPS routes | all required public, bilingual, metadata, admin-login and Health routes returned 200 | Automated pass |
| EdgeOne preview isolation | no 401, preview-auth page, preview token, project-domain redirect, or `edgeone.dev` SEO URL | Automated pass |
| Stable SEO origin | canonical, Open Graph URL and sitemap used `https://h5.kzqdecor.com` | Automated pass |
| Node Route Handler and Supabase provider | Health reported non-Demo Supabase with Node.js runtime | Automated pass |
| HTTP enforcement | root, path and query-bearing requests returned 200 with zero redirects | Blocked / P1 |
| Redirect path/query coverage | existing deployment probe now asserts both properties explicitly | Fixed test coverage; remote rule still blocked |
| Deployment SHA | Health returned `unknown` | Blocked; not inferred |
| Credentialed Staging acceptance | deployment guard failed before Workflow dispatch | Skipped by guard |

This result concerns a Staging technical acceptance target only. It is not
Production evidence and does not establish mainland carrier or WeChat quality.

# 2026-07-28 EdgeOne upload body limit correction (Review #2 WP7)

The previous project documentation (LAUNCH_CHECKLIST, TWO_PHASE_UPLOAD_DESIGN)
claimed that setting the EdgeOne WAF request body limit to 21 MB would allow
20 MB PDF uploads through `POST /api/admin/storage/upload`. This is incorrect.

EdgeOne Cloud Functions documentation
(https://pages.edgeone.ai/document/cloud-functions) explicitly states the
request/response body limit is **6 MB**. This is a platform-level hard cap
that **cannot** be raised by WAF configuration. The WAF rule cited in the
old Launch Checklist only controls what the WAF itself inspects; it does not
override the Cloud Functions runtime body limit.

Consequence: any single-stage multipart upload exceeding ~6 MB would be
rejected by the EdgeOne platform layer before reaching the Node.js process,
producing an opaque error to the client. The previous 21 MB / 20 MB
contract was therefore unachievable in production.

## Corrected application-layer limits

| Layer | Before | After | Rationale |
| --- | --- | --- | --- |
| Route `MAX_REQUEST_BYTES` | 21 MB | 5 MB | Below 6 MB platform cap with 1 MB headroom |
| Route `MAX_FILE_BYTES` | 20 MB | 4.5 MB | 500 KB multipart overhead below `MAX_REQUEST_BYTES` |
| per-MIME (image/PDF) | 5 MB / 20 MB | 4 MB / 4 MB | Unified below `MAX_FILE_BYTES` |
| Supabase bucket `file_size_limit` | 20 MB | 20 MB (unchanged) | Allows future two-stage upload (browser → Supabase direct, bypasses EdgeOne) and the catalog import script (direct to Supabase) |

The Supabase bucket limit is intentionally kept at 20 MB because:
1. Two-stage upload (when implemented) uploads directly browser → Supabase,
   bypassing EdgeOne Cloud Functions entirely. The bucket must accept larger
   files for this path to be useful.
2. The `scripts/import-catalog-assets.mjs` bulk import tool uploads directly
   to Supabase via the service_role key, not through the EdgeOne-routed API.
   Its 20 MB filter matches the bucket limit.

The route-layer 4 MB limit is the **single-stage API contract** that
clients see. The bucket's higher limit is an internal backend allowance
for direct-to-Supabase paths that do not traverse EdgeOne.

## Two-phase upload (implemented)

Two-stage upload (`/api/admin/storage/upload/authorize` → browser direct to
Supabase → `/api/admin/storage/upload/finalize`) is **fully implemented**
(Phase 4 + Phase 5). All admin UI upload components use the two-phase path
as the primary upload route, bypassing the EdgeOne 6 MB platform limit.
PDF uploads up to 20 MB and image uploads up to 5 MB are supported.
Design: `docs/TWO_PHASE_UPLOAD_DESIGN.md`. Launch Checklist entry:
`docs/LAUNCH_CHECKLIST.md` (section 6, "两阶段上传已实现").

**Deployment prerequisite**: Supabase Storage bucket must have CORS
configured to allow browser PUT requests.



# 2026-07-28 Node engine alignment (Review #2 Work Package 6)

EdgeOne Cloud Functions runtime is documented as Node.js v20.x
(https://pages.edgeone.ai/document/cloud-functions). The build host
default is Node 20.18.0 (https://pages.edgeone.ai/document/build-guide)
with `.nvmrc` switching supported. There is no EdgeOne Makers
documentation stating that Cloud Functions can run Node 22.x, so
Plan A (lock to Node 20-compatible dependency versions) was selected.

## Evidence — installed versions before / after

| Dependency | Before | engines.node | After | engines.node |
| --- | --- | --- | --- | --- |
| `@supabase/supabase-js` | 2.110.8 | `>=22.0.0` | 2.109.0 | `>=20.0.0` |
| `@supabase/ssr` | 0.12.3 | (none, peer `supabase-js ^2.110.5`) | 0.12.0 | (none, peer `supabase-js ^2.108.0`) |
| `pdfjs-dist` | 6.1.200 | `>=22.13.0 \|\| >=24` | 5.4.624 | `>=20.16.0 \|\| >=22.3.0` |

Version boundaries were verified directly via `npm view <pkg>@<ver> engines`:

- `@supabase/supabase-js@2.109.0` → `>=20.0.0` (last Node 20 release)
- `@supabase/supabase-js@2.110.0` → `>=22.0.0` (first Node 22-only release)
- `pdfjs-dist@5.4.624` → `>=20.16.0 || >=22.3.0` (last Node 20 release in 5.x)
- `pdfjs-dist@5.5.207` → `>=20.19.0 || >=22.13.0 || >=24` (requires Node 20.19+, above EdgeOne 20.18.0 default)
- `pdfjs-dist@5.7.284` → `>=22.13.0 || >=24` (drops Node 20)
- `pdfjs-dist@6.1.200` → `>=22.13.0 || >=24` (current 6.x, requires Node 22.13+)

`pdfjs-dist` was pinned to 5.4.624 (not 5.5+ which would require Node
20.19+) because the EdgeOne build host default is Node 20.18.0 and we
do not rely on `.nvmrc` switching behavior being documented for
Cloud Functions.

## API compatibility

- `@supabase/ssr@0.12.0` → `@supabase/supabase-js@2.109.0` peer is
  satisfied; no breaking API changes between ssr 0.12.0 and 0.12.3
  affect this project (only `createServerClient` + cookie adapter
  are used, both stable across 0.12.x).
- `pdfjs-dist@5.4.624` exposes the same API surface used by this
  project (`getDocument`, `GlobalWorkerOptions`, `PDFDocumentProxy`,
  `PDFPageProxy.getPage`, `Viewport`, `TextLayer`). The `legacy/build`
  path used by `scripts/sync-pdfjs-worker.mjs` exists in both v5 and
  v6. Type-check, 1261 unit tests, and demo build all pass with the
  downgrade.

## Enforcement

- `package.json` `engines.node` remains `"20.x"`, declaring the
  EdgeOne Cloud Functions runtime target.
- `package.json` pins `@supabase/ssr`, `@supabase/supabase-js`, and
  `pdfjs-dist` to exact versions (no caret) to prevent npm from
  auto-bumping into a Node 22-only release.
- CI gains an explicit "Verify dependency engines" step
  (`.github/workflows/ci.yml`) that runs `npm ls --engine-strict`
  under Node 20 and fails the build if any installed dependency
  declares an `engines.node` constraint incompatible with Node 20.

## Decision

Plan A selected. Plan B (upgrade to Node 22.13+) is **not** adopted
because no EdgeOne Makers documentation confirms Node 22.x support for
Cloud Functions, and the user's instruction requires EdgeOne runtime
verification evidence before changing the runtime target.

# 2026-07-29 Middleware Edge Runtime compatibility (Review #3 WP2)

EdgeOne Makers documentation states that Next.js middleware "默认运行在
Edge Runtime 环境中" (defaults to Edge Runtime). The docs do NOT
explicitly mention support for Node.js runtime in middleware. The
user's instruction requires EdgeOne-recommended values to be confirmed
through real Staging requests, not documentation assumptions alone.

## Problem

Vercel build output reported:

```
A Node.js module is loaded (@supabase/supabase-js uses process.version),
which is unsupported in the Edge Runtime.
```

Import chain: `@supabase/supabase-js` → `@supabase/ssr` →
`lib/supabase/middleware-session.ts` → `middleware.ts`.

`@supabase/supabase-js` uses `process.version` (a Node.js-only API) for
runtime version detection / telemetry. Although the code guards with
`typeof process !== 'undefined'`, the bundler still detects the usage
and emits the warning, which must not be ignored.

## Solution

Since EdgeOne docs only confirm Edge Runtime support for middleware
(not Node.js runtime), the safe path is to remove the
`@supabase/ssr` / `@supabase/supabase-js` dependency from the
middleware bundle entirely:

1. `lib/supabase/middleware-session.ts` was rewritten to use only
   Web APIs (`fetch`, `Headers`, `TextEncoder`, `TextDecoder`,
   `atob`, `btoa`) — all available in both Edge Runtime and Node.js.
2. Token refresh is now performed by a direct `fetch()` call to the
   Supabase Auth refresh-token endpoint
   (`POST /auth/v1/token?grant_type=refresh_token`).
3. Cookie chunking (read + write) is implemented manually to stay
   compatible with `@supabase/ssr` v0.12.x's cookie format
   (base64-prefixed, 3180-byte chunks).
4. All existing security semantics are preserved: cookie forwarding
   to request, `Set-Cookie` on response, `Cache-Control: private,
   no-store` when cookies are rotated, security header preservation.

## CI enforcement

A new CI step (`Check middleware Edge Runtime compatibility`) was
added to the `compile-contract` job. It runs
`scripts/check-middleware-edge-runtime.mjs` which scans the build
output for Edge Runtime warning patterns:

- `uses process.version`
- `not supported in the Edge Runtime`
- `A Node.js module is loaded`
- `which is not supported in the Edge Runtime`

If any pattern is found, the CI job fails. This prevents regressions
where a dependency update silently reintroduces a Node.js-only API
into the middleware bundle.

## Unit test enforcement

`tests/unit/middleware-session.test.ts` includes a static source-level
test (`Edge Runtime compatibility > does NOT import @supabase/ssr or
@supabase/supabase-js`) that reads the module source and asserts no
banned imports are present.

## Staging validation checklist (PENDING — not yet executed)

The following checklist MUST be executed against a real EdgeOne Staging
deployment before claiming Auth Middleware is adapted to EdgeOne.
Until all items pass, the middleware must be considered "Staging
unverified".

| Step | Action | Expected result | Status |
| --- | --- | --- | --- |
| 1 | Log in to the admin backend via the Staging login page | Auth cookies set in browser | PENDING |
| 2 | Manually shorten the access token's expiry (or wait near expiry) | Token is close to expiry | PENDING |
| 3 | Request `/admin` (any admin page) | Page loads without auth redirect | PENDING |
| 4 | Verify the access token was refreshed (check cookie value changed) | New access token cookie present | PENDING |
| 5 | Verify the response carries `Set-Cookie` with the rotated auth cookie | `Set-Cookie: sb-<ref>-auth-token=...` present | PENDING |
| 6 | Verify the response carries `Cache-Control: private, no-store` | Header present on refreshed responses | PENDING |
| 7 | Make a subsequent admin API call (e.g. `GET /api/admin/products`) | API succeeds (200) with the refreshed token | PENDING |
| 8 | Verify a public ISR page (e.g. `/products`) is still statically cached | No `Cache-Control: private, no-store` on public pages | PENDING |
| 9 | Verify no `process.version` or Edge Runtime warnings in EdgeOne build logs | Clean build log | PENDING |

**Until this checklist is fully executed and passed, the Auth Middleware
must NOT be claimed as EdgeOne-verified.** The CI check ensures the
middleware bundle is Edge-compatible at build time; the Staging checklist
ensures it works at runtime on EdgeOne.

