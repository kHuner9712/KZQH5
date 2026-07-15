# Staging Supabase 初始化与验证

本手册只适用于新建、隔离、无客户数据的 Supabase Staging 项目。不得把 Production URL、数据库密码或 service role 传给任何 Staging 命令。

## 安全停止点

1. 在 Supabase Dashboard 记录新项目 ref，并明确标记 `KZQ STAGING`。
2. 确认 `public` schema 没有业务表、Auth 没有客户账号、Storage 没有客户文件。
3. 设置 `KZQ_STAGING_CONFIRMATION=KZQ-STAGING-ONLY` 和 `KZQ_STAGING_PROJECT_REF=<ref>`。
4. `scripts/init-staging-database.mjs` 会校验连接 host/pooler user 含该 ref，并在 `public` 已有任何表时拒绝；它不包含 drop/reset。

## 当前仓库的正确顺序

1. `supabase/schema.sql`
2. `supabase/policies.sql`
3. `supabase/seed.sql`
4. `supabase/cms_seed.sql`
5. `20260713181111_upgrade_inquiries.sql`
6. `20260714032351_b2b_product_search_and_inquiry_items.sql`
7. `20260714084116_procurement_assets_and_projects.sql`
8. `20260714125149_production_stability_analytics_wechat.sql`
9. `20260714201851_enforce_inquiry_product_integrity.sql`
10. `20260715090000_security_hardening_explicit_grants.sql`

`schema.sql` 已折叠 CMS 表/字段，`policies.sql` 已折叠 CMS RLS，因此 `cms_upgrade.sql` **不得用于当前全新安装**。它是旧库兼容脚本；在安全加固迁移之后重跑会重写 `is_admin()` 的 `search_path` 配置。第一份询盘 migration 的字段多数已在 schema 中，但外键、补充索引和触发器尚未全部折叠，所以仍需执行。

`seed.sql` 会清理并重建公开基础内容，只能用于已通过“空 public schema”检查的新 Staging；绝不能用于已有远程项目。以后增量升级只执行尚未登记的时间戳 migration，不重跑 schema、policies 或 seed。

## 可控初始化

```powershell
$env:DATABASE_STAGING_URL = "postgresql://..."
$env:KZQ_STAGING_PROJECT_REF = "<staging-project-ref>"
$env:KZQ_STAGING_CONFIRMATION = "KZQ-STAGING-ONLY"
npm run database:init:staging
```

数据库 URL 只放在本机进程环境，不写 `.env`、日志、工单或 GitHub Artifact。脚本使用单事务和 `ON_ERROR_STOP=1`；失败后检查 Dashboard，不要盲目重跑。

## 初始化后验证

本地数据库验证与远程验证必须分别记录：

```powershell
# 本地一次性 Postgres 容器；会重建仅限 _test 数据库
npm run test:database

# 远程 Staging；公开读取与带 `Prefer: tx=rollback` 的拒绝性检查，不 reset
$env:NEXT_PUBLIC_SUPABASE_URL = "<staging-url>"
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = "<staging-anon-key>"
$env:KZQ_STAGING_CONFIRMATION = "KZQ-STAGING-ONLY"
npm run test:database:staging
npm run test:smoke
```

远程写入 Smoke 另需：

```powershell
$env:SUPABASE_SERVICE_ROLE_KEY = "<staging-only-service-role>"
$env:SMOKE_TEST_ALLOW_WRITES = "true"
$env:KZQ_STAGING_CONFIRMATION = "KZQ-STAGING-ONLY"
npm run test:smoke
```

写入测试创建的数据都含 `[REGRESSION TEST]`，并按明确 UUID 与标记在 `finally` 中清理。失败后仍需在 Dashboard 按本次日志中的测试时间核对，不允许宽泛 delete。

## 人工步骤

- 在 Authentication 创建普通测试账号与独立管理员测试账号；管理员 UUID 手工加入 `admin_profiles`。
- 在 `public-assets` 上传一份已确认可公开的展示版/水印版资源，供 Storage 诊断使用。
- 验证后台登录、CMS 只读/写入、真实 CSV 导出；导出文件不得提交仓库。
- 如测试 WeCom/Resend/微信，只在 EdgeOne/Supabase/GitHub `staging` secret 中配置 Staging 凭据。
