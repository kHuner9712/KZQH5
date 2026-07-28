# EdgeOne WAF 运行契约

> 本文档定义 EdgeOne Web Application Firewall (WAF) 对 KZQ 项目各 API 路由的运行契约。
>
> **重要声明**：EdgeOne WAF 规则在 EdgeOne 控制台配置，无法通过仓库代码直接修改。本文档是**控制台操作的规范文档**，不是代码可执行的配置。部署人员必须按照本文档在 EdgeOne 控制台手动配置 WAF 规则，并在验收记录中提供证据。

## 1. 受保护路由清单

| 路由 | 方法 | 用途 | 限流阈值 | 请求体上限 | 并发限制 | 可信 IP Header |
|------|------|------|----------|------------|----------|----------------|
| `/api/inquiries` | POST | 询盘提交 | 10 req/min/IP | 16 KB | 5 | `eo-connecting-ip` |
| `/api/analytics/events` | POST | 前端分析事件 | 60 req/min/IP | 4 KB | 10 | `eo-connecting-ip` |
| `/api/csp-report` | POST | CSP 违规报告 | 30 req/min/IP | 8 KB | 10 | `eo-connecting-ip` |
| `/api/readiness` | GET | 就绪检查 | 60 req/min/IP | N/A | 10 | `eo-connecting-ip` |
| `/api/admin/storage/upload` | POST | 管理员文件上传 | 5 req/min/admin | 4 MB (Phase 4 后 20 MB) | 1 | `eo-connecting-ip` |
| `/api/internal/outbox/dispatch` | POST | Outbox 调度 | 20 req/min | 4 KB | 1 | N/A (内部) |
| `/api/internal/outbox/status` | GET | Outbox 状态 | 30 req/min | N/A | 2 | N/A (内部) |

## 2. 各路由详细策略

### 2.1 `/api/inquiries`

**限流阈值**: 10 请求/分钟/IP

**请求体上限**: 16 KB（应用层 `readJsonBody` 限制为 16 KB，WAF 层应匹配或略高）

**并发限制**: 5 并发请求/IP

**可信 IP Header**: `eo-connecting-ip`

**WAF 规则**:
- 拦截 SQL 注入特征（`' OR 1=1`、`UNION SELECT` 等）
- 拦截 XSS 特征（`<script>`、`javascript:` 等）
- 拦截路径遍历（`../`、`..\\` 等）
- 请求体大小超过 16 KB 时返回 413
- 请求频率超过 10 req/min 时返回 429

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

**限流阈值**: 60 请求/分钟/IP

**请求体上限**: 4 KB

**并发限制**: 10 并发请求/IP

**WAF 规则**:
- 请求体大小超过 4 KB 时返回 413
- 请求频率超过 60 req/min 时返回 429
- 拦截 XSS 特征

### 2.3 `/api/csp-report`

**限流阈值**: 30 请求/分钟/IP

**请求体上限**: 8 KB（应用层 `readJsonBody` 限制为 8 KB）

**WAF 规则**:
- 仅接受 `Content-Type: application/json`、`application/reports+json`、`application/csp-report`
- 请求体大小超过 8 KB 时返回 413
- 请求频率超过 30 req/min 时返回 429
- 不解析或记录 `script-sample`、`blocked-uri` 完整值

### 2.4 `/api/readiness`

**限流阈值**: 60 请求/分钟/IP

**WAF 规则**:
- 仅接受 GET 方法
- 请求频率超过 60 req/min 时返回 429

### 2.5 `/api/admin/storage/upload`

**限流阈值**: 5 请求/分钟/管理员

**请求体上限**: 4 MB（当前单阶段上传限制；Phase 4 两阶段上传后将改为 20 MB+，文件请求体不经过 EdgeOne Function）

**并发限制**: 1 并发请求/管理员

**WAF 规则**:
- 仅接受已认证的管理员会话（应用层 `requireAdminWrite` 检查）
- 请求体大小超过限制时返回 413
- 拦截恶意文件头

### 2.6 `/api/internal/**`

**Internal API 访问策略**:

`/api/internal/outbox/dispatch` 和 `/api/internal/outbox/status` 是内部 API，不接受公网直接访问。

**WAF 规则**:
- 仅接受来自 GitHub Actions IP 段或可信内部网络的请求
- 通过 IP 白名单限制访问
- 或者通过 EdgeOne 的 Access Control 配置限制访问
- 请求必须携带有效的 `Authorization: Bearer <OUTBOX_DISPATCH_SECRET>` header
- `dispatch`: 20 req/min，1 并发
- `status`: 30 req/min，2 并发
- 非 POST (dispatch) 或非 GET (status) 方法返回 405

**验收方法**:
- 从非白名单 IP 访问，验证返回 403
- 不携带 Authorization header 访问，验证返回 401
- 携带错误 token 访问，验证返回 403

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
6. **正常请求测试**: 发送正常请求，验证不被误拦截

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
- [ ] 为 `/api/csp-report` 配置限流和 Content-Type 过滤
- [ ] 为 `/api/readiness` 配置限流规则
- [ ] 为 `/api/admin/storage/upload` 配置限流和请求体大小限制
- [ ] 为 `/api/internal/**` 配置 IP 白名单访问控制
- [ ] 配置全局 fallback 限流
- [ ] 配置可信 IP Header (`eo-connecting-ip`)
- [ ] 执行验收测试并记录证据
