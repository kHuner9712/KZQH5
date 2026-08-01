# 安全审计：管理员 MFA / AAL2（KZQ-P1-022-a）

> 子任务 1：数据与 Auth 能力审计。
> 本文件为只读审计交付物——不含 UI 占位、不含功能实现。
> 实施（Enrollment / Challenge / Server guard / step-up / E2E）由
> KZQ-P1-022-b ~ f 依次执行，每轮一个子任务。

## 1. 审计范围与方法

- 数据模型：`admin_profiles` 表结构与 MFA 状态存储位置
- Auth 能力：`@supabase/supabase-js` / `@supabase/auth-js` 的 MFA API 支持
- 现有集成：后台会话验证路径是否检查 AAL
- 敏感操作端点清单（step-up 目标）
- 平台配置前提（Supabase Auth Dashboard 人工配置）

## 2. 数据模型审计

`supabase/schema.sql` 中 `admin_profiles`：

```sql
create table if not exists public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text default 'admin',
  created_at timestamptz default now()
);
```

结论：

- `admin_profiles` **不需要**新增 MFA 字段。MFA 状态（factor / challenge / AAL）由
  Supabase Auth 自身管理（`auth.mfa_factors`、`auth.mfa_challenges` 等 auth schema
  内部表，RLS 保护，应用不可直接访问）。
- 应用侧如需"该管理员是否已启用 MFA"的可读数据，应通过
  `supabase.auth.mfa.listFactors()`（当前用户）或 Auth Admin API 查询，而非新增列。
- 本轮**不创建 migration**——当前无 schema 缺口。

## 3. Auth 能力审计

依赖版本（`package.json`）：`@supabase/supabase-js 2.109.0`、`@supabase/ssr 0.12.0`。

`@supabase/auth-js`（2.109.0 内置）确认包含完整 MFA API：

| API | 用途 | 子任务 |
|-----|------|--------|
| `auth.mfa.enroll()` | TOTP / Phone / WebAuthn 因子注册 | b（Enrollment） |
| `auth.mfa.challenge()` / `auth.mfa.verify()` | 因子挑战与验证 | c（Challenge） |
| `auth.mfa.getAuthenticatorAssuranceLevel()` | 返回 `{ currentLevel, nextLevel, currentAuthenticationMethods }` | d（Server guard） |
| `auth.mfa.listFactors()` / `auth.mfa.unenroll()` | 因子管理 | b / e |

AAL 语义：

- `aal1` = 仅密码（当前后台所有会话）。
- `aal2` = 密码 + 至少一个验证过的 MFA 因子。
- Supabase access_token JWT payload 含 `aal` claim（`"aal1"` / `"aal2"`），
  服务端可从 token 读取，也可调用 `getAuthenticatorAssuranceLevel()`。

结论：**SDK 能力完备，无需升级依赖即可实施 MFA/AAL2。**

## 4. 当前集成状态（真实证据）

- 全库 grep `mfa|aal2|totp|enrolled_factors|authenticator-assurance`：
  除本文档与 `docs/TRAE_UPGRADE_LEDGER.md` 提及外，代码零命中（`public/lib/pdfjs` worker
  为无关第三方匹配）。
- `lib/services/admin-auth.ts` `getVerifiedAdmin()`：
  1. `createServerSupabaseClient()` + `auth.getUser()` 验证会话（阶段 1）；
  2. `createAdminSupabaseClient()`（service_role）查询 `admin_profiles`（阶段 3）。
  **未调用 `mfa.getAuthenticatorAssuranceLevel()`，未解析 `aal` claim** ——
  任意达到 `aal1`（仅密码）的合法管理员即可通过全部后台鉴权。
- `lib/supabase/middleware-session.ts`：解码 SSR cookie 中的 session JSON
  （`{ access_token, ... }`），无 `aal` 解析。
- 无 MFA 相关页面 / 组件 / API 路由。

结论：**MFA/AAL2 完全未实现**，与 ledger 证据一致。

## 5. 敏感操作端点清单（step-up 候选，子任务 e）

以下端点均经过 `requireAdminWrite`（5 层防护：鉴权 + 全局限流 + per-admin 限流 +
RBAC + CSRF），但当前**均不要求 AAL2**。step-up 应优先覆盖：

| 类别 | 端点 | 理由 |
|------|------|------|
| 询盘导出 | `POST /api/admin/inquiries/export` | PII 批量导出 |
| 存储上传 | `POST /api/admin/storage/upload`、`/authorize`、`/finalize`、`/object`（DELETE）、`/publish`、`/cleanup` | 敏感文件操作 / 公开内容发布 |
| 资料管理 | `POST/PATCH/DELETE /api/admin/product-assets/**`、`/certificates/**/authorize|publish|unpublish` | 发布公开内容 |
| CMS 写操作 | `/api/admin/products/**`、`categories/**`、`projects/**`、`homepage`、`pages`、`site-settings`、`company` | 内容篡改面 |

补充：`requireAdminWrite` 已有 per-admin 限流（`getAdminApiRateLimiter`，
60/min）与登录闸门（P1-021），MFA 在其之上叠加。

## 6. AAL2 实施技术路线（子任务 2-6）

1. **b（Enrollment）** ✅ 已完成（`trae/p1-022b-mfa-enrollment`）：
   `app/admin/(protected)/security/page.tsx` + `components/admin/MfaEnrollment.tsx`
   实现完整 TOTP 绑定流程——`auth.mfa.enroll()` 生成 `totp_uri` / `qr_code`
   （SDK 已带 `data:image/svg+xml;utf-8,` 前缀），展示二维码/密钥/URI，
   `auth.mfa.challenge()` + `verify()` 确认后完成 enrollment；
   "已启用 MFA"状态经 `listFactors()` 展示（不落库）。
   错误全部经 `lib/security/mfa-errors.ts` `mapMfaError()` 映射为固定中文文案，
   qr_code/secret/uri 仅在绑定步骤展示、绝不写日志。
   AdminShell 导航新增「账号安全」入口。
2. **c（Challenge）** ✅ 已完成（`trae/p1-022c-mfa-challenge`）：
   `app/admin/mfa/challenge/page.tsx` + `components/admin/MfaChallenge.tsx`
   在密码登录后建立 MFA challenge 门控——`LoginForm.tsx` 登录成功后调用
   `mfa.getAuthenticatorAssuranceLevel()` 分流：`nextLevel === "aal2"`
   （存在已验证因子）→ 跳转 `/admin/mfa/challenge`；探测失败 fail-closed
   同样路由到 challenge 页（该页自行评估并回跳无因子账号），不绕过 MFA。
   challenge 页位于 `(protected)` 分组之外（避免 `getVerifiedAdmin()` 在
   challenge 前放行）：无 session → `/admin/login`；已 aal2 → `/admin`；
   无已验证因子 → `/admin`；有因子 → `mfa.challenge()` 发一次性 challenge →
   输入 6 位码 → `mfa.verify()` 成功后 SDK 保存 aal2 会话进入后台；
   verify 失败时 challenge id 已消费，重新签发再试。错误全部经
   `mapMfaError()` 映射为固定中文文案。verify/challenge/enroll 的 code
   仅发送至 Supabase Auth，绝不经过自有 API。
3. **d（Server guard）**：在 `getVerifiedAdmin()` 增加 AAL 检查：
   `sessionClient.auth.mfa.getAuthenticatorAssuranceLevel()`，
   `currentLevel !== "aal2"` → 重定向到 MFA challenge（返回固定 stage 值，
   不泄露内部细节）。middleware 可选解析 access_token 的 `aal` claim 提前分流。
4. **e（step-up）**：第 5 节敏感端点要求 AAL2；`aal1` 会话访问时进入
   step-up challenge（复用 c 的挑战流程），通过后短期放行。
5. **f（E2E 与文档）**：Playwright 覆盖登录 → MFA challenge → 后台访问 →
   敏感操作 step-up；更新 `docs/LAUNCH_CHECKLIST.md` 与
   `docs/EDGEONE_WAF_RULES.md`（如适用）。

## 7. 平台配置前提（人工，先于子任务 2）

- Supabase Dashboard → Authentication → Providers：确认 **Email** 登录开启。
- Supabase Dashboard → Authentication → **Multi-factor Authentication**：
  - `TOTP` 启用；`Phone` / `WebAuthn` 按需；
  - `Enrollment` 设为 **Optional**（或按运营策略 Required）；
  - 生产环境（正式项目）配置，**不得在未配置的 Demo/本地假装已启用**。
- 若启用 WebAuthn，需 HTTPS 正式域名（EdgeOne 已具备）。

## 8. 结论

- 数据模型无缺口（MFA 状态由 auth schema 管理）。
- SDK 能力完备（enroll/challenge/getAuthenticatorAssuranceLevel 均已内建）。
- 当前后台鉴权**不检查 AAL**，任意密码登录管理员可访问全部后台——MFA/AAL2
  是真实缺口，应继续子任务 b-f。
- 平台侧 MFA 启用为人工配置项，已在上节明确，未在本审计中虚假标记为已部署。

## 9. 关联任务

- `docs/TRAE_UPGRADE_LEDGER.md` → KZQ-P1-022（workstream，6 个子任务）。
- 上一子任务已完成：P1-020（登录错误标准化）、P1-021（登录防爆破闸门）。
