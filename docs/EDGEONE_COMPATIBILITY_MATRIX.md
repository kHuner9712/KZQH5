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

