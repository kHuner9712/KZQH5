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
3. **d（Server guard）** ✅ 已完成（`trae/p1-022d-server-guard`）：
   `lib/services/admin-auth.ts` `getVerifiedAdmin()` 在 session 验证（Stage 1）后、
   service-role client 创建前（Stage 2）新增 AAL 检查（Stage 1.5）——
   调用 `sessionClient.auth.mfa.getAuthenticatorAssuranceLevel()`：
   - `nextLevel === "aal2" && currentLevel !== "aal2"`（账号有已验证因子但
     当前会话仍是 aal1）→ 返回 `{ ok: false, reason: "aal-insufficient" }`；
   - 无已验证因子（`nextLevel === "aal1"`）**不拦截**——强制 aal2 会锁死
     所有未绑定 MFA 的管理员，也阻断他们去 `/admin/security` 绑定（死锁）；
   - **fail-closed**：AAL 探测 error/异常同样视为 `aal-insufficient`
     （无法确认 AAL 级别不得放行，challenge 页兜底显示固定错误）；
   - 新增 reason `aal-insufficient`，`failureStage()` 映射为固定外部
     stage `"mfa"`（不泄露内部细节）；
   - `(protected)/layout.tsx` 与 `analytics/page.tsx` 对
     `reason === "aal-insufficient"` 重定向到 `/admin/mfa/challenge`
     （而非登录页），日志仅记 `ADMIN_GUARD_MFA`；
   - API 层 `requireAdminWrite`/`requireAdminRead` 无需改动——`!admin.ok`
     已返回固定 401 `ADMIN_WRITE_UNAUTHORIZED`（不泄露 AAL 细节）。
   middleware 解析 `aal` claim 提前分流仍为可选（本子任务未实现，非必需）。
4. **e（step-up）** ✅ 已完成（`trae/p1-022e-step-up`）：
   `lib/services/admin-write-boundary.ts` 对 **API 层**敏感操作实施 step-up
   错误码区分——`requireAdminWrite` 与 `requireAdminRead` 在
   `getVerifiedAdmin()` 返回 `aal-insufficient`（账号有已验证 MFA 因子但
   会话未完成 challenge，见子任务 d）时，返回**可区分的固定错误码**
   `ADMIN_WRITE_MFA_REQUIRED`（401 + 固定日志码 `ADMIN_WRITE_MFA_REQUIRED`），
   而非笼统的 `ADMIN_WRITE_UNAUTHORIZED`。客户端可据此识别"需要完成 MFA
   step-up"并路由到 `/admin/mfa/challenge`（复用 c 的挑战流程）；挑战通过后
   `mfa.verify()` 保存 aal2 会话——该 aal2 token 即"短期放行"凭证（token
   生命周期内免重复挑战）。其他失败原因（session-missing 等）仍返回
   `ADMIN_WRITE_UNAUTHORIZED`，语义不混淆。未给非敏感端点开设
   aal-insufficient 放行分支（拒绝语义不变，仅错误码可区分）。
   TESTS: `tests/unit/admin-write-boundary-mfa.test.ts`（4 行为测试：write/read
   对 aal-insufficient 返回 401 + ADMIN_WRITE_MFA_REQUIRED；对 session-missing
   保持 ADMIN_WRITE_UNAUTHORIZED）+ `tests/unit/mfa-aal2-audit.test.ts` 新增
   KZQ-P1-022-e describe（4 静态契约测试：错误码定义、write/read 映射、固定
   日志码、不泄露内部 reason）。
   middleware 解析 `aal` claim 提前分流仍为可选（未实现，非必需）。
5. **f（E2E 与文档）** ✅ 已完成（`trae/p1-022f-mfa-e2e`）：
   - `tests/e2e/staging-mfa.spec.ts`（staging 真实环境，凭据门控 + serial，
     加入 `npm run test:e2e:staging`）覆盖：① **Enrollment**——密码登录
     （aal1，无因子）→ `/admin/security` 绑定 TOTP 因子（enroll → 读取
     一次性 secret → challenge + verify → 状态"已启用"）；②
     **Challenge + step-up**——MFA 账号密码登录后必须落在
     `/admin/mfa/challenge`；会话仍为 aal1 时调用敏感读（询盘导出）被
     拒绝（401 + 固定码 `ADMIN_WRITE_MFA_REQUIRED`）；输入 TOTP 验证码
     （`mfa.verify()` 保存 aal2 会话）后同一接口放行（200 text/csv）；
     退出后后台再次关闭。账号已预绑定因子时用
     `STAGING_MFA_SECRET`（secret 仅在 enrollment 时展示一次）；
     无 secret 时对应测试跳过并明确提示（不猜测、不伪造成功）。
   - `tests/e2e/helpers/totp.ts`：纯 Node `crypto` 的 RFC 6238 TOTP 生成器
     （base32 + HMAC-SHA1 + 30s 窗口 + 6 位，支持 ±1 步窗口重试），
     不新增任何依赖。
   - 文档：`docs/LAUNCH_CHECKLIST.md` 新增 MFA 应用层 + 平台人工验收项；
     `docs/EDGEONE_WAF_RULES.md` §2.12 补充 challenge 路径限流建议；
     `docs/TRAE_UPGRADE_LEDGER.md` 标记 P1-022-f completed。
   - **验收边界**：本地/无凭据运行全部 skip（`--list` 验证 spec 可加载）；
     真实验收需平台人工前提（§7）+ 预绑定因子测试账号 +
     `STAGING_MFA_SECRET`，运行 `npm run test:e2e:staging`。

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
