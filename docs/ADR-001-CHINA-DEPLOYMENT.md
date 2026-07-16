# ADR-001：中国大陆部署架构

- 状态：Pending real network validation
- 日期：2026-07-15
- 基线：`51a3073167ed722f53d2aab9158ce14cf43c6a71`

## 背景与证据

当前代码自动化基线已覆盖 Demo、单元和本地数据库；本分支新增 EdgeOne 兼容性矩阵、健康/诊断、远程 Smoke、部署探测和 Staging E2E。当前没有 EdgeOne 登录权限、独立 Supabase Staging 凭据、中国运营商真机人员、微信公众号凭据或真实管理员账号，因此没有真实部署、国内网络、Storage、Auth、CSV 或通知闭环证据。

官方文档证明 Makers 支持 Next.js 14、App Router、SSR/ISR/RSC、Route Handlers 和 `next/image`，并提供 Node 20 Cloud Functions。官方声明不是本项目实测，也不证明 Supabase 在中国大陆稳定。

## 候选方案

| 维度 | A EdgeOne Makers + Supabase | B EdgeOne Makers + CloudBase 后端 | C CloudBase 部署 + CloudBase 后端 |
| --- | --- | --- | --- |
| 技术兼容性 | Next.js 核心能力官方支持；项目特殊能力待部署 | 前端 runtime 同 A；数据/Auth/Storage/Function 需迁移 | Next.js 全栈兼容性与部署形态待调研/原型 |
| 国内访问 | 未验证 | 未验证；仅在 Supabase 被证实为瓶颈后评估 | 未验证 |
| 海外访问 | 未验证 | 未验证 | 未验证 |
| 免费额度风险 | Makers 与 Supabase 配额均可调整 | Makers/CloudBase 配额均可调整 | CloudBase 配额可调整 |
| 数据库迁移成本 | 无 | 高：schema、RLS、RPC、原子询盘需重构 | 高 |
| Auth 迁移成本 | 无 | 高：管理员/session/RLS 语义需替换 | 高 |
| Storage 迁移成本 | 无 | 中高：文件、公开 URL、策略和 CMS 上传迁移 | 中高 |
| Function 迁移成本 | 无 | 高：询盘、统计、通知、微信边界重实现 | 高 |
| 运维复杂度 | 两平台、跨境链路 | 两平台但国内后端 | 单平台候选，但应用 runtime 风险更高 |
| 域名/备案 | 中国大陆加速、自定义域名与备案要求需控制台/主体确认 | 同时满足 EdgeOne 与 CloudBase 要求 | 依 CloudBase 产品和地域要求确认 |

## Go / No-Go 条件

方案 A Go：Demo 与 Staging 部署通过；健康、诊断、只读/写入 Smoke、真实管理员/CSV/Storage/通知通过；移动/联通/电信/家庭宽带和微信测试达到可接受稳定性；Supabase 数据/Storage/API 耗时无系统性失败。

方案 A No-Go：EdgeOne Next.js runtime 不兼容关键路由；或页面本身稳定而 Supabase 数据/Storage/写入在多个国内网络持续超时/失败，并有对照证据。

方案 B 进入原型：仅当方案 A 的证据把瓶颈定位到 Supabase，而 EdgeOne 页面和 Functions 本身稳定。不得仅凭单次慢请求启动迁移。

方案 C 进入评估：仅当 EdgeOne 无法可靠运行本项目 Next.js 核心能力，且 CloudBase 部署原型证明相应能力可用。

## 当前结论

**Pending real network validation**。本阶段不选择最终架构、不变更生产 DNS、不迁移 CloudBase。下一决策点必须附上部署 URL、日志、自动化退出码和 `docs/CHINA_WECHAT_NETWORK_TEST.md` 的真实记录。
# 2026-07-16 evidence addendum

The real EdgeOne/Supabase Staging has operator-confirmed Node Route Handler,
Supabase provider, non-Demo health, and administrator login. Local automation
found a Dashboard count error-handling defect and fixed it, but could not rerun
the deployed branch because the clean EdgeOne project domain returned the
platform 401 preview-authentication page. Credentials for direct Staging,
administrator E2E, CRUD, Storage, and write smoke were not present locally.

This is technical Staging progress only. It does not establish China mainland
reachability or production readiness. No CloudBase migration, production DNS
change, production Supabase use, or final architecture decision was made.

**Status remains: Pending real network validation.**

# 2026-07-16 stable-domain acceptance addendum

The stable custom domain is Effective, has deployed HTTPS, and is linked to the
EdgeOne Production environment for this Staging technical acceptance. Public
HTTPS routes and the non-Demo Supabase/Node.js Health endpoint are reachable
without preview authentication.

Acceptance remains blocked because the deployed artifact still emits the prior
project-domain origin in canonical, Open Graph and sitemap output, and plain
HTTP does not redirect to HTTPS. Remote database, Dashboard, admin, inquiry,
CRUD and Storage acceptance was stopped before credentialed execution. No
GitHub write workflow, remote data write, deletion, DNS change, or EdgeOne
configuration change was performed.

These findings do not identify Supabase as a mainland bottleneck and provide no
China carrier or WeChat evidence. They therefore do not meet the entry
condition for a CloudBase prototype or migration.

**Status remains: Pending real network validation.**

# 2026-07-17 final remote gate addendum

The stable Staging HTTPS host now serves the expected canonical, Open Graph and
sitemap origin, and its Health endpoint reports the non-Demo Supabase provider
on Node.js. However, real HTTP requests to the root, a path, and a query-bearing
path returned 200 without redirecting to HTTPS. The deployment gate therefore
failed before any GitHub Workflow, database, administrator, inquiry, CRUD, or
Storage acceptance was allowed to run.

No evidence from China Mobile, China Unicom, China Telecom, mainland home
broadband, WeChat, iOS, Android, or an independent overseas comparison was
collected. This does not identify Supabase as a mainland bottleneck and does not
meet the entry condition for a CloudBase prototype or migration.

**Status remains: Pending real network validation.**
