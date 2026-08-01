# EdgeOne WAF 运行契约

> 本文档定义 EdgeOne Web Application Firewall (WAF) 对 KZQ 项目各 API 路由的运行契约。
>
> **重要声明**：EdgeOne WAF 规则在 EdgeOne 控制台配置，无法通过仓库代码直接修改。本文档是**控制台操作的规范文档**，不是代码可执行的配置。部署人员必须按照本文档在 EdgeOne 控制台手动配置 WAF 规则，并在验收记录中提供证据。

## 0. 分布式限流架构与 Fail-Closed 决策 (KZQ-P1-011-a)

### 0.1 两层限流模型

KZQ 采用**两层限流模型**，各层职责明确，不可互相替代：

| 层 | 执行点 | 一致性范围 | 角色 |
|----|--------|------------|------|
| 第一层：应用层 `MemoryRateLimiter` | EdgeOne Cloud Function (Node 进程内) | 单进程 | 本机快速拒绝 + 开发/测试 fallback |
| 第二层：EdgeOne WAF / Rate Limiting | EdgeOne 边缘节点 | 跨实例全局 | 生产级跨实例 floor |

**为什么需要两层**：EdgeOne Cloud Functions 是多实例部署，应用层 `MemoryRateLimiter` 的计数器仅在单个 Node 进程内一致。当 N 个实例并行运行时，实际限流阈值为 `N × 配置值`，这**不是真正的生产级限流**。EdgeOne WAF / Rate Limiting 规则在边缘节点执行，所有实例的请求先经过边缘限流，提供跨实例一致的全局 floor。

### 0.2 Fail-Closed 决策

| 场景 | 决策 | 理由 |
|------|------|------|
| 应用层 `MemoryRateLimiter` 容量满 | **Fail-closed**（拒绝新 key） | 不驱逐活跃条目，防止攻击者重置受害者桶 |
| 应用层 `MemoryRateLimiter` 异常 | **Fail-open**（放行，依赖 WAF 层） | 单进程故障不应阻断所有请求；WAF 层仍提供 floor |
| EdgeOne WAF 未配置（生产） | **BLOCK 发布** | `WAF_RATE_LIMIT_VERIFIED ≠ "true"` 时 `check-release-readiness --mode=production` 阻断 |
| EdgeOne WAF 未配置（staging） | **WARN** | Staging 可在 WAF 配置前先部署验证应用层 |
| EdgeOne WAF 规则触发 | **429**（限流）或 **403**（拦截） | 由 EdgeOne 边缘节点返回，不到达应用层 |

### 0.3 发布门控

生产环境发布前必须满足：

1. EdgeOne 控制台已按本文档第 1 节配置所有路由的 WAF 限流规则
2. 已执行第 5 节的全部验收测试并记录证据
3. 在生产环境变量中设置 `WAF_RATE_LIMIT_VERIFIED=true`
4. `npm run check:release-readiness -- --mode=production` 通过（exit 0）

**仅接受精确字符串 `"true"`**（区分大小写）。`"TRUE"` / `"1"` / `"yes"` 均被拒绝，防止误配。

### 0.4 应用层限流器的多实例边界声明

`lib/services/rate-limit.ts` 文件头已明确声明：

> MemoryRateLimiter is consistent only within a single Node process. On EdgeOne multi-instance deployments the effective limit may be N × configured (N = running instances). Production deployments MUST additionally enable EdgeOne WAF / Rate Limiting rules.

应用层所有 `getXxxRateLimiter()` 工厂返回的 `MemoryRateLimiter` 实例**仅作为本机/第二层保护**，不是生产级限流的唯一执行点。

## 1. 受保护路由清单

| 路由 | 方法 | 用途 | 限流阈值 | 请求体上限 | 并发限制 | 可信 IP Header |
|------|------|------|----------|------------|----------|----------------|
| `/api/inquiries` | POST | 询盘提交 | 5 req/10min/IP | 32 KB | 5 | `eo-connecting-ip` |
| `/api/analytics/events` | POST | 前端分析事件 | 60 req/min/IP | 8 KB | 10 | `eo-connecting-ip` |
| `/api/products/selection` | POST | 产品选择查询 | 60 req/min/IP | 8 KB | 10 | `eo-connecting-ip` |
| `/api/csp-report` | POST | CSP 违规报告 | 60 req/min/IP | 8 KB | 10 | `eo-connecting-ip` |
| `/api/readiness` | GET | 就绪检查 | 12 req/min/IP | N/A | 10 | `eo-connecting-ip` |
| `/api/og` | GET | OG 图片生成 | 30 req/min/IP | N/A | 5 | `eo-connecting-ip` |
| `/api/wechat/jssdk` | GET | 微信 JS-SDK 配置 | 20 req/min/IP | N/A | 5 | `eo-connecting-ip` |
| `/api/admin/storage/upload` | POST | 单阶段文件上传 (fallback) | 20 req/5min/admin | 5 MB | 1 | `eo-connecting-ip` |
| `/api/admin/storage/upload/authorize` | POST | 两阶段上传授权 | 10 req/min/admin | 8 KB | 1 | `eo-connecting-ip` |
| `/api/admin/storage/upload/finalize` | POST | 两阶段上传确认 | 10 req/min/admin | 8 KB | 1 | `eo-connecting-ip` |
| `/api/admin/inquiries/export` | GET | 询盘 CSV 导出 | 10 req/min/admin | N/A | 1 | `eo-connecting-ip` |
| `/api/internal/outbox/dispatch` | POST | Outbox 调度 | 20 req/min | 4 KB | 1 | N/A (内部) |
| `/api/internal/outbox/status` | GET | Outbox 状态 | 30 req/min | N/A | 2 | N/A (内部) |
| `/api/internal/storage/cleanup-dispatch` | POST | Storage 清理调度 | 20 req/min | 4 KB | 1 | N/A (内部) |
| `/api/internal/storage/audit-reconcile` | POST | Storage 审计对账 | 20 req/min | 4 KB | 1 | N/A (内部) |

## 2. 各路由详细策略

### 2.1 `/api/inquiries`

**限流阈值**: 5 请求/10分钟/IP（应用层 `getInquiryRateLimiter`）

**请求体上限**: 32 KB（应用层 `readJsonBody` 限制）

**并发限制**: 5 并发请求/IP

**可信 IP Header**: `eo-connecting-ip`

**WAF 规则**:
- 拦截 SQL 注入特征（`' OR 1=1`、`UNION SELECT` 等）
- 拦截 XSS 特征（`<script>`、`javascript:` 等）
- 拦截路径遍历（`../`、`..\\` 等）
- 请求体大小超过 32 KB 时返回 413
- 请求频率超过 5 req/10min 时返回 429

**验收方法**:
- 使用 `curl` 发送超限请求，验证返回 429
- 发送超大请求体，验证返回 413
- 发送 SQL 注入特征，验证被拦截

**证据记录字段**:
- 规则 ID
- 触发时间
- 客户端 IP（脱敏后）
- 匹配规则名称
- 处置动作（block / rate-limit）

**回滚方式**: 在 EdgeOne 控制台禁用对应 WAF 规则

### 2.2 `/api/analytics/events`

**限流阈值**: 60 请求/分钟/IP（应用层 `getAnalyticsRateLimiter`）

**请求体上限**: 8 KB

**并发限制**: 10 并发请求/IP

**WAF 规则**:
- 请求体大小超过 8 KB 时返回 413
- 请求频率超过 60 req/min 时返回 429
- 拦截 XSS 特征

### 2.3 `/api/products/selection`

**限流阈值**: 60 请求/分钟/IP（应用层 `getAnalyticsRateLimiter`）

**请求体上限**: 8 KB

**WAF 规则**:
- 请求体大小超过 8 KB 时返回 413
- 请求频率超过 60 req/min 时返回 429
- 应用层限制最多 30 个产品 ID

### 2.4 `/api/csp-report`

**限流阈值**: 60 请求/分钟/IP（应用层 `getAnalyticsRateLimiter`）

**请求体上限**: 8 KB（应用层 `readJsonBody` 限制为 8 KB）

**WAF 规则**:
- 仅接受 `Content-Type: application/json`、`application/reports+json`、`application/csp-report`
- 请求体大小超过 8 KB 时返回 413
- 请求频率超过 60 req/min 时返回 429
- 不解析或记录 `script-sample`、`blocked-uri` 完整值

### 2.5 `/api/readiness`

**限流阈值**: 12 请求/分钟/IP（应用层 `getReadinessRateLimiter`）

**WAF 规则**:
- 仅接受 GET 方法
- 请求频率超过 12 req/min 时返回 429

### 2.6 `/api/og` (Phase 6 新增)

**限流阈值**: 30 请求/分钟/IP（应用层 `getOgRateLimiter`）

**请求体上限**: N/A (GET 请求)

**并发限制**: 5 并发请求/IP

**WAF 规则**:
- 仅接受 GET 方法
- 请求频率超过 30 req/min 时返回 429
- `title` 参数长度限制 90 字符（应用层校验）
- 响应可缓存（`Cache-Control: public, max-age=3600`）

**说明**: OG 图片渲染使用 Satori + resvg（CPU 密集），不限流可被 DoS。Phase 6 将路由从 Edge runtime 改为 Node runtime 以便使用共享限流助手。

### 2.7 `/api/wechat/jssdk` (Phase 6 新增)

**限流阈值**: 20 请求/分钟/IP（应用层 `getWechatJsSdkRateLimiter`）

**请求体上限**: N/A (GET 请求)

**并发限制**: 5 并发请求/IP

**WAF 规则**:
- 仅接受 GET 方法
- 请求频率超过 20 req/min 时返回 429
- `url` 参数长度限制 2000 字符（应用层校验）
- 仅允许同源 URL（应用层 `allowedOrigin` 校验）

**说明**: 微信 JS-SDK 配置端点调用微信后端 API（access_token + jsapi_ticket），微信 API 有共享配额。不限流可被攻击者耗尽配额，导致所有用户的 JS-SDK 失效。

### 2.8 `/api/admin/storage/upload` (单阶段 fallback)

**限流阈值**: 20 请求/5分钟/管理员（应用层 `getStorageUploadRateLimiter`，按 admin actor ID 分桶）

**请求体上限**: 5 MB（EdgeOne Cloud Functions 平台硬限制 6 MB，留 1 MB headroom）

**文件大小上限**: 4.5 MB（留 500 KB 给 multipart 框架开销）

**并发限制**: 1 并发请求/管理员

**WAF 规则**:
- 仅接受已认证的管理员会话（应用层 `requireAdminWrite` 检查）
- 请求体大小超过 5 MB 时返回 413
- 拦截恶意文件头

**说明**: Phase 4 + Phase 5 已实现两阶段上传（authorize → 浏览器直传 Supabase → finalize），所有 admin UI 组件已接入两阶段路径。此单阶段路由保留为 fallback，受 EdgeOne 6 MB 平台限制约束。PDF 上限 4 MB（单阶段）或 20 MB（两阶段），图片上限 4 MB（单阶段）或 5 MB（两阶段）。

### 2.9 `/api/admin/storage/upload/authorize` + `/finalize` (Phase 4 两阶段上传)

**限流阈值**: 10 请求/分钟/管理员（建议）

**请求体上限**: 8 KB（仅 JSON 元数据，不含文件字节）

**WAF 规则**:
- 仅接受已认证的管理员会话（应用层 `requireAdminWrite` 检查）
- 仅接受 `Content-Type: application/json`
- 请求体大小超过 8 KB 时返回 413
- `authorize`: 返回 Supabase 写签名 URL，客户端直传 Storage（不经 EdgeOne Function）
- `finalize`: 服务端校验 Magic Bytes + 路径 + 大小，更新 temp_uploads 状态

**说明**: 两阶段上传绕过 EdgeOne 6 MB 请求体限制。文件字节通过浏览器直传 Supabase Storage（Supabase 写签名 URL），不经过 EdgeOne Cloud Functions。EdgeOne 只处理小 JSON 请求（authorize/finalize）。

### 2.10 `/api/admin/inquiries/export` (Phase 6 加固)

**限流阈值**: 10 请求/分钟/管理员（建议）

**请求体上限**: N/A (GET 请求)

**WAF 规则**:
- 仅接受已认证的管理员会话（应用层 `getVerifiedAdmin` 检查）
- RBAC: 最低角色 `admin`（应用层 `hasAdminRole` 检查）
- CSRF 防御: `isSameSiteRequest`（允许 GET 导航缺失 Origin，但检查 Sec-Fetch-Site）
- 最多导出 10000 行
- 响应 `Cache-Control: private, no-store`

### 2.11 `/api/internal/**`

**Internal API 访问策略**:

所有 `/api/internal/**` 路由不接受公网直接访问。

| 路由 | 方法 | 鉴权 | 限流 |
|------|------|------|------|
| `/api/internal/outbox/dispatch` | POST | `OUTBOX_DISPATCH_SECRET` | 20 req/min, 1 并发 |
| `/api/internal/outbox/status` | GET | `OUTBOX_DISPATCH_SECRET` | 30 req/min, 2 并发 |
| `/api/internal/storage/cleanup-dispatch` | POST | `STORAGE_CLEANUP_DISPATCH_SECRET` | 20 req/min, 1 并发 |
| `/api/internal/storage/audit-reconcile` | POST | `STORAGE_MAINTENANCE_SECRET` | 20 req/min, 1 并发 |

**WAF 规则**:
- 仅接受来自 GitHub Actions IP 段或可信内部网络的请求
- 通过 IP 白名单限制访问
- 或者通过 EdgeOne 的 Access Control 配置限制访问
- 请求必须携带有效的 `Authorization: Bearer <对应 SECRET>` header
- 各 SECRET 相互独立（OUTBOX_DISPATCH_SECRET ≠ STORAGE_CLEANUP_DISPATCH_SECRET ≠ STORAGE_MAINTENANCE_SECRET）
- 非 POST (dispatch/reconcile) 或非 GET (status) 方法返回 405

**验收方法**:
- 从非白名单 IP 访问，验证返回 403
- 不携带 Authorization header 访问，验证返回 401
- 携带错误 token 访问，验证返回 403
- 使用 OUTBOX_SECRET 访问 storage 路由，验证返回 403（跨用途令牌隔离）

### 2.12 `/api/admin/login-guard` (KZQ-P1-021 新增)

**管理员登录防爆破 — 应用层登录闸门**:

登录表单在调用 `supabase.auth.signInWithPassword` 之前，先 POST 到本端点（无 body、不传输任何凭据）。服务端计数并判定是否超限——客户端从不自行计数。

| 路由 | 方法 | 鉴权 | 应用层限流 |
|------|------|------|------------|
| `/api/admin/login-guard` | POST | 无（仅限流闸门） | 5 req/min / 可信 IP；无可信 IP 时共享 `fallback:global` floor |

- 超限返回 `429` + 固定中文文案（`尝试次数过多，请稍后再试`）+ `Retry-After` + `Cache-Control: no-store`
- 服务端仅记录固定错误码 `ADMIN_LOGIN_RATE_LIMITED`，不记录邮箱、IP 或供应商错误细节
- 请求体被完全忽略——绝不在该端点接收/解析密码

**边界（如实声明）**: 本闸门只保护**走应用页面**的登录流程（含脚本化浏览器自动化执行页面自身登录 JS 的场景）。客户端若绕过表单直接调用 Supabase Auth（`auth.<ref>.supabase.co`），该请求不经过本应用——此路径的真实防线为:

1. **Supabase Auth 内建登录限流**（Auth Dashboard → Rate Limits，按 IP 与邮箱分别限流）——防爆破的根防线，必须人工配置并验收；
2. **EdgeOne WAF 规则**（见下方）。

**WAF 规则建议**:
- 对 `/api/admin/login-guard` 与 `/admin/login` 页面请求限流（例如 30 req/min/IP），防止闸门端点与登录页本身被高频扫描
- 将 `/api/admin/login-guard` 的 POST 请求纳入全局 fallback 限流（见第 4 节）

**验收方法**:
- 连续超过 5 次登录尝试（同 IP），第 6 次在页面显示固定限流文案且不再调用 Supabase Auth
- 无可信 IP 场景（未配置 `TRUSTED_PROXY_HEADER`）下，轮换 User-Agent 等 header 仍被全局 floor 拦截
- 直接调用 Supabase Auth 的请求在 Auth Dashboard 达到限流阈值后返回 `429`（平台侧验收）

## 3. 可信 IP Header 配置

EdgeOne 环境必须配置以下可信 IP Header：

| Header 名称 | 用途 | 环境变量 |
|-------------|------|----------|
| `eo-connecting-ip` | 客户端真实 IP 提取（限流分桶） | `TRUSTED_PROXY_HEADER=eo-connecting-ip` |

**验收**: 应用层 `getClientIp()` 函数从 `TRUSTED_PROXY_HEADER` 指定的 header 读取客户端 IP。`check-release-readiness` 在部署环境验证该变量已配置且在允许枚举中。

## 4. Global Rate Limit Fallback

EdgeOne WAF 必须配置全局 fallback 限流，防止未知客户端绕过路由级限流。

| 条件 | 阈值 | 处置 |
|------|------|------|
| 全局请求速率 | 1000 req/min/IP | 429 |
| 全局请求体大小 | 10 MB | 413 |
| 全局并发 | 100 | 429 |

应用层 `MemoryRateLimiter` 也有全局 fallback:global bucket（当无法提取可信 IP 时使用 `RATE_LIMIT_FALLBACK_SECRET` HMAC 生成分桶 key）。两层独立运作。

## 5. WAF 规则验收流程

每次 WAF 规则变更或新增路由后，必须执行以下验收：

1. **限流测试**: 发送超限请求，验证返回 429
2. **请求体大小测试**: 发送超大请求体，验证返回 413
3. **SQL 注入测试**: 发送含 SQL 注入特征的请求，验证被拦截
4. **XSS 测试**: 发送含 XSS 特征的请求，验证被拦截
5. **Internal API 访问控制测试**: 从非白名单 IP 访问 internal API，验证返回 403
6. **跨用途令牌隔离测试**: 使用 OUTBOX_SECRET 访问 storage internal 路由，验证返回 403
7. **正常请求测试**: 发送正常请求，验证不被误拦截

## 6. 证据记录

每次 WAF 规则变更必须在以下位置记录证据：

- EdgeOne 控制台截图（规则配置页面）
- 验收测试结果（curl 输出或测试脚本输出）
- 变更时间、操作人、规则 ID

## 7. 回滚方式

- **WAF 规则回滚**: 在 EdgeOne 控制台禁用或删除对应规则
- **限流阈值回滚**: 在 EdgeOne 控制台修改阈值
- **IP 白名单回滚**: 在 EdgeOne 控制台移除或修改 IP 白名单
- **应用层回滚**: 通过 Git revert 回滚应用代码变更

## 8. 控制台操作清单（待人工执行）

以下操作必须在 EdgeOne 控制台手动完成，无法通过仓库代码执行：

- [ ] 为 `/api/inquiries` 配置 WAF 规则（限流 + SQL/XSS 拦截）
- [ ] 为 `/api/analytics/events` 配置限流规则
- [ ] 为 `/api/products/selection` 配置限流规则
- [ ] 为 `/api/csp-report` 配置限流和 Content-Type 过滤
- [ ] 为 `/api/readiness` 配置限流规则
- [ ] 为 `/api/og` 配置限流规则（Phase 6 新增）
- [ ] 为 `/api/wechat/jssdk` 配置限流规则（Phase 6 新增）
- [ ] 为 `/api/admin/storage/upload` 配置限流和请求体大小限制（5 MB）
- [ ] 为 `/api/admin/storage/upload/authorize` 配置限流（Phase 4 两阶段上传）
- [ ] 为 `/api/admin/storage/upload/finalize` 配置限流（Phase 4 两阶段上传）
- [ ] 为 `/api/admin/inquiries/export` 配置限流（Phase 6 加固）
- [ ] 为 `/api/internal/outbox/**` 配置 IP 白名单访问控制
- [ ] 为 `/api/internal/storage/cleanup-dispatch` 配置 IP 白名单 + SECRET 鉴权
- [ ] 为 `/api/internal/storage/audit-reconcile` 配置 IP 白名单 + SECRET 鉴权
- [ ] 配置全局 fallback 限流
- [ ] 配置可信 IP Header (`eo-connecting-ip`)
- [ ] 执行第 5 节全部验收测试并记录证据
- [ ] **KZQ-P1-011-a**: 验收通过后，在生产环境变量中设置 `WAF_RATE_LIMIT_VERIFIED=true`
- [ ] **KZQ-P1-011-a**: 运行 `npm run check:release-readiness -- --mode=production` 确认通过
- [ ] **KZQ-P1-012**: 设置 `CANONICAL_APP_ORIGIN=https://<生产域名>`
- [ ] **KZQ-P1-013**: 在 EdgeOne 边缘层配置 HSTS（详见 §9）

### 8.1 证据要求

设置 `WAF_RATE_LIMIT_VERIFIED=true` 前，必须收集并归档以下证据：

1. **EdgeOne 控制台截图**：展示已配置的限流规则列表（含路由、阈值、处置动作）
2. **验收测试输出**：第 5 节全部 7 项测试的 curl 或脚本输出
3. **变更记录**：操作时间、操作人、规则 ID、变更工单号

`WAF_RATE_LIMIT_VERIFIED=true` 是运维人员的**人工断言**，表示上述证据已收集归档。代码无法验证 WAF 配置的真实性，但可以通过此门控确保发布前有人工确认环节。

## 9. HSTS 边缘配置（KZQ-P1-013）

### 背景

EdgeOne 终止 TLS 并以 HTTP 转发到源站。应用中间件 (`middleware.ts`)
通过 `x-forwarded-proto` 头判断用户侧协议并设置 HSTS——这覆盖了
请求到达源站的场景。但部分请求可能在 EdgeOne 边缘直接响应（缓存
命中、WAF 拦截、边缘重定向），永远不到达源站，因此中间件的
HSTS 头不会被设置。

### 要求

HSTS **必须**在 EdgeOne 边缘层也配置，确保所有 HTTPS 响应（无论
是否到达源站）都携带 `Strict-Transport-Security` 头。

| 配置项 | 值 |
|--------|-----|
| Header 名称 | `Strict-Transport-Security` |
| Header 值 | `max-age=31536000; includeSubDomains` |
| 适用条件 | 仅 HTTPS 响应（EdgeOne 边缘自动按协议设置） |
| 适用范围 | 所有域名（主域 + 备用域名） |

### 两层 HSTS 模型

| 层级 | 位置 | 覆盖场景 |
|------|------|----------|
| EdgeOne 边缘层 | EdgeOne 控制台规则 | 所有 HTTPS 响应（含缓存命中、WAF 拦截、边缘重定向） |
| 应用中间件层 | `middleware.ts` `getUserFacingProtocol()` | 到达源站的请求（通过 `x-forwarded-proto` 判断用户侧 HTTPS） |

两层独立运作，互不冲突。EdgeOne 边缘层是主防线，应用中间件层是
补充。

### 验收方法

1. 使用 `curl -I https://<生产域名>/products` 检查响应头是否包含
   `Strict-Transport-Security: max-age=31536000; includeSubDomains`
2. 使用 `curl -I http://<生产域名>/products` 检查 HTTP 响应是否
   **不**包含 HSTS 头（HSTS 仅在 HTTPS 上有效）
3. 访问一个会被 EdgeOne 缓存的页面，验证 HSTS 头仍存在（证明
   边缘层配置生效，不依赖源站）

### 证据记录

- EdgeOne 控制台截图（HSTS 规则配置页面）
- curl 验收测试输出
- 变更时间、操作人
