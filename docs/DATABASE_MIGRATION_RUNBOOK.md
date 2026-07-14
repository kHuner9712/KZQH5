# KZQ 数据库 Migration Runbook

本手册仅用于全新 Supabase 项目、旧项目增量升级和本地验收。任何验证命令都不得指向生产数据库；仓库脚本会拒绝非 localhost 且数据库名不以 `_test` 结尾的连接串。

## 1. 执行前备份与停止点

1. 在 Supabase Dashboard 或 `pg_dump` 创建带时间戳的 schema + data 备份，并记录项目 ref、当前 commit 和 `supabase_migrations.schema_migrations`。
2. 导出管理员、产品和询盘计数；不要导出或记录 service-role key。
3. 暂停后台 CMS 写操作和询盘发布窗口。公开只读站点可继续服务。
4. 每个 SQL 文件使用 `ON_ERROR_STOP=1` 单独执行。任一文件失败后立即停止，不继续后续 migration。
5. 不修改或重复编辑历史 migration；修复通过新的时间戳文件追加。

推荐记录：

```sql
select version, name, statements
from supabase_migrations.schema_migrations
order by version;
```

若项目由 SQL Editor 手工维护，另建部署工单记录文件名、SHA-256、执行人、开始/结束时间和结果，不要伪造 CLI 历史。

## 2. 路径 A：全新安装

严格按下列顺序执行：

1. `supabase/schema.sql`
2. `supabase/policies.sql`
3. `supabase/seed.sql`
4. `supabase/cms_seed.sql`
5. `supabase/migrations` 中所有 SQL，按文件名升序执行

当前 migration 顺序：

1. `20260713181111_upgrade_inquiries.sql`
2. `20260714032351_b2b_product_search_and_inquiry_items.sql`
3. `20260714084116_procurement_assets_and_projects.sql`
4. `20260714125149_production_stability_analytics_wechat.sql`
5. `20260714201851_enforce_inquiry_product_integrity.sql`
6. `20260715090000_security_hardening_explicit_grants.sql`
7. `cms_upgrade.sql`（兼容性升级，全部语句必须保持幂等）

应用完成后执行 `supabase/tests/permission_matrix.sql` 和 `supabase/tests/atomic_inquiry.sql`。

`schema.sql` / `policies.sql` 只定义 migration 序列之前的基础对象；采购资料、案例、统计等对象由对应 migration 创建。不要把这些对象再次复制回基础快照，否则全新安装会与历史 migration 重复创建。

注意：直接运行 `supabase start` 会先自动扫描时间戳 migration，而不会先执行仓库根顺序中的 `schema.sql`、`policies.sql` 和 seed，因此空库会在第一份增量 migration 处停止。全新安装应使用本节顺序或下方验证脚本，不要把 CLI 默认启动顺序当作正式安装顺序。

## 3. 路径 B：旧项目增量升级

1. 读取 migration 执行记录，跳过已经应用的文件。
2. 从最早未执行文件开始，按上节顺序逐个应用，不重新运行 `schema.sql`、seed 或已经执行的历史 migration。
3. 在本仓库自动验收中，`d5c5822` 作为新增采购/案例/统计/双语功能前的基线；脚本先写入带 `[REGRESSION TEST]` 标记的管理员、产品和询盘哨兵，再应用当前 migration。
4. 升级后确认哨兵记录仍存在，管理员未被重置，产品和询盘总数不减少，匿名权限未扩大。

本地可重复命令（需要两个独立的空白 localhost 数据库和本机 `psql`）：

```powershell
$env:DATABASE_TEST_URL = "postgresql://postgres:postgres@127.0.0.1:54322/kzq_fresh_test"
$env:DATABASE_UPGRADE_TEST_URL = "postgresql://postgres:postgres@127.0.0.1:54322/kzq_upgrade_test"
$env:LEGACY_BASELINE_COMMIT = "d5c5822"
npm run test:database
```

`scripts/verify-database.mjs` 会重建这两个 `_test` 数据库中的 `public/auth/storage` 测试 schema。不要把生产连接串传给该脚本。

也可使用名称以 `kzq-` 开头的隔离 Postgres 容器；脚本只允许重建名称以 `_test` 结尾的数据库：

```powershell
docker run -d --name kzq-migration-test -e POSTGRES_PASSWORD=postgres postgres:16-alpine
$env:DATABASE_TEST_DOCKER_CONTAINER = "kzq-migration-test"
npm run test:database
docker rm -f kzq-migration-test
```

2026-07-15 本地验收使用上述容器模式实际执行，路径 A、路径 B、权限矩阵、旧数据哨兵和原子回滚测试均以 exit 0 完成；临时容器已删除。

## 4. RLS 权限矩阵

| 角色                    | 允许                                                   | 禁止                                                          |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `anon`                  | 已启用分类；已发布产品、证书、案例、资料；公开搜索 RPC | 直接写询盘/统计；读取询盘；CMS 写入；管理员 RPC；原子询盘 RPC |
| 普通 `authenticated`    | 与匿名相同的公开读取                                   | 仅凭登录获得 CMS/询盘管理权限；原子询盘 RPC；统计直写         |
| `admin_profiles` 管理员 | 后台所需 CMS、案例、资料、询盘 CRUD 与统计聚合         | 绕过服务端管理员复核                                          |
| `service_role`          | 服务端询盘原子写入、统计写入、通知前读取和必要管理     | 客户端暴露或浏览器调用                                        |

`supabase/tests/permission_matrix.sql` 同时检查表权限、公开搜索 RPC、原子询盘 RPC、`is_admin()` 的 PUBLIC execute，以及普通 authenticated CMS 写入被 RLS 拒绝。

## 5. SECURITY DEFINER 审计 SQL

```sql
select
  n.nspname as schema_name,
  p.proname,
  p.prosecdef,
  p.proconfig,
  pg_get_userbyid(p.proowner) as owner,
  has_function_privilege('public', p.oid, 'execute') as public_execute,
  has_function_privilege('anon', p.oid, 'execute') as anon_execute,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
order by p.proname;
```

验收要求：所有 `SECURITY DEFINER` 函数固定 `search_path`；不向 PUBLIC 授权；仅按真实调用方授予 execute；函数体不存在从公开 RPC 到管理员能力的越权调用链。

## 6. 回滚策略

- SQL DDL 前先完成可恢复备份。发生失败时停止在首个失败文件，不继续执行。
- 新询盘完整性 migration 只替换 RPC，不改历史记录。回滚时从前一历史 migration 恢复该函数定义并重新应用最小 execute grants；不要删除 `inquiries` 或 `inquiry_items`。
- 依赖升级回滚使用 Git 恢复 `package.json` 与 `package-lock.json` 后重新 `npm ci`，不使用 `npm audit fix --force`。
- 若 migration 已写入数据，优先前向修复；只有经过恢复演练才从备份回滚整库。

## 7. 环境受阻时

Supabase CLI 本地栈依赖 Docker。若 CLI、Docker daemon 或 `psql` 不可用，只能提交脚本与文档，并将数据库两条路径标为“未执行”；不得写成通过。真实账号、管理员和第三方通知仍需在隔离的 staging 项目人工验收。
