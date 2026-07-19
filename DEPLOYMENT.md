# 部署指南

本文件说明 KZQ 的正式部署与验证流程。

**生产架构（已确定）：**

- **EdgeOne**：正式前端及 Next.js 服务端运行平台（SSR / ISR / Route Handlers / `next/image` / CDN），Node 20。
- **Supabase**：正式数据库、Auth 与 Storage。
- **Vercel**：已废弃，不再用于 Preview 或 Production；本指南不再维护 Vercel 部署步骤。
- **Cloudflare Pages / CloudBase**：历史备选方案，仅在 `docs/ADR-001-CHINA-DEPLOYMENT.md` 中作为决策证据保留，不属于当前部署主流程。

中国大陆运营商、微信内置浏览器与真机验收仍属人工验收项，未在代码自动化中替代；详见 `docs/CHINA_WECHAT_NETWORK_TEST.md`。

## 前置条件

1. GitHub / GitLab 仓库（已推送项目代码）
2. 独立 Supabase Staging 项目（不得使用客户 Production）
3. 管理员账号已创建（详见 [README.md](./README.md) 第 2 节）

## 必填环境变量

| 变量名 | 说明 | 示例 |
|-------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL | `https://xxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | `eyJhbGci...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key（仅服务端） | `eyJhbGci...` |
| `NEXT_PUBLIC_SITE_URL` | 站点正式域名 | `https://kzq.example.com` |
| `NEXT_PUBLIC_DEMO_MODE` | 可选，Demo 模式开关 | `true` / `false` |
| `STAGING_DIAGNOSTICS_ENABLED` | 可选，仅 Staging 诊断开关 | `true` / `false` |
| `STAGING_DIAGNOSTICS_TOKEN` | 可选，仅 Staging Bearer secret | 不写示例值 |

### 可选询盘通知变量

| 变量名 | 说明 |
|-------|------|
| `INQUIRY_WECOM_WEBHOOK_URL` | 企业微信机器人 webhook，仅服务端 |
| `RESEND_API_KEY` | Resend HTTP API 密钥，仅服务端 |
| `INQUIRY_NOTIFICATION_FROM` | 邮件发件人 |
| `INQUIRY_NOTIFICATION_TO` | 邮件收件人，多个地址用英文逗号分隔 |

通知变量均未配置时询盘仍正常写入；通知失败不会让用户提交失败。Demo 模式不写数据库、不发送真实通知。

⚠️ `NEXT_PUBLIC_SITE_URL` 必须填写正式域名，影响 sitemap.xml、JSON-LD、SEO 分享卡片。

⚠️ `SUPABASE_SERVICE_ROLE_KEY` 只能在服务端环境变量中配置，不可出现在客户端代码或 `NEXT_PUBLIC_*` 变量中。

## EdgeOne Makers（生产平台）

官方与项目实测边界见 [兼容性矩阵](./docs/EDGEONE_COMPATIBILITY_MATRIX.md)。Makers 当前项目环境变量对所有环境生效，因此 Demo Preview 与 Supabase Staging 推荐创建两个独立 Makers 项目，避免 Preview 继承 Staging 密钥。

### 通用构建设置

- Framework preset：`Next.js`
- Root Directory：`./`
- Node.js：`20`（仓库 `.nvmrc` 同步固定）
- Install Command：`npm ci`
- Build Command：`npm run build`
- Output Directory：`.next`

不新增 `edgeone.json`：函数地域、路由重写和 timeout 尚无经部署验证的需求，先使用官方 Next.js preset 与控制台默认值。

### 模式一：Demo Preview

只设置：

```text
NEXT_PUBLIC_DEMO_MODE=true
```

不要设置任何 Supabase、通知、微信或诊断密钥。部署后运行：

```powershell
$env:BASE_URL = "https://<demo>.edgeone.app"
$env:EXPECT_DEMO_MODE = "true"
npm run check:deployed
```

该模式只证明 EdgeOne 可以构建和运行项目，不证明真实 Supabase、Storage、Auth 或中国网络可用。

### 模式二：Supabase Staging

```text
NEXT_PUBLIC_DEMO_MODE=false
NEXT_PUBLIC_SUPABASE_URL=<staging>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging>
SUPABASE_SERVICE_ROLE_KEY=<staging>
NEXT_PUBLIC_SITE_URL=<edgeone-staging-root-url>
```

可选诊断必须同时配置 `STAGING_DIAGNOSTICS_ENABLED=true` 与随机 `STAGING_DIAGNOSTICS_TOKEN`。调用时只通过 `Authorization: Bearer <token>`；不要把 token 放 URL。

初始化顺序见 [STAGING_SUPABASE_SETUP.md](./docs/STAGING_SUPABASE_SETUP.md)。部署后默认只读验证：

```powershell
npm run test:smoke
$env:BASE_URL = "https://<staging>.edgeone.app"
npm run check:deployed
$env:PLAYWRIGHT_BASE_URL = $env:BASE_URL
npm run test:e2e:staging
```

写入 Smoke/E2E 还必须分别设置 `SMOKE_TEST_ALLOW_WRITES=true`、`STAGING_E2E_ALLOW_WRITES=true`，并设置 `KZQ_STAGING_CONFIRMATION=KZQ-STAGING-ONLY`。默认 GitHub Workflow 不执行远程写入。

### 控制台人工步骤

1. GitHub 导入 `kHuner9712/KZQH5`，部署分支以仓库和 EdgeOne 当前真实配置为准（正式部署分支：`main`）。
2. 使用上方构建设置；保存环境变量后触发新部署，旧部署不会自动更新。
3. 记录 build log、deployment URL、commit SHA 和 Function request id；不得上传 `.env`。
4. 先验证 `/api/health`，再运行部署探测与 Staging E2E。
5. 未取得部署权限时将结果记为“被阻塞”，不得把本地 Demo 记作 EdgeOne 通过。

---

## Supabase 初始化顺序

部署前请确认在 Supabase SQL Editor 中按以下顺序执行：

1. `supabase/schema.sql` — 基础表结构 + 索引 + 触发器
2. `supabase/policies.sql` — RLS 权限策略 + Storage buckets
3. `supabase/seed.sql` — 基础种子数据（类目/产品/证书/公司/站点设置）
4. `supabase/cms_seed.sql` — CMS 内容 + 产品 GEO 字段
5. 按文件名时间顺序执行尚未执行的时间戳 migration，直到 `20260715090000_security_hardening_explicit_grants.sql`

> `cms_upgrade.sql` 已折叠进当前基础 SQL，不用于全新安装或标准自动流程。它仅供经审计的旧库兼容，且不得在安全加固 migration 后重跑。已经执行过的历史 migration 不要修改；只执行尚未应用的新 migration。

最新 migration 会启用 `pg_trgm`、创建参数化产品搜索 RPC、`inquiry_items` 表及原子询盘写入函数。无需新增环境变量；请在执行后确认 `anon/authenticated` 可调用公开搜索 RPC，而原子写入 RPC 仅 `service_role` 可执行。

采购资料与案例 migration 新增 `product_assets`、`projects`、`project_images`、`project_products` 及对应 RLS。无需新增环境变量；公开展示文件继续使用 `public-assets`。上线前确认匿名请求只能读取已发布资料/案例，后台管理员可维护草稿。

---

## 部署后验证清单

部署完成后，按以下清单逐项验证（完整版见 [docs/LAUNCH_CHECKLIST.md](./docs/LAUNCH_CHECKLIST.md)）：

### 前台验证

- [ ] 首页 `/` 正常加载，Logo 与品牌展示
- [ ] 产品中心 `/products` 可筛选一级/二级类目
- [ ] 产品详情 `/products/[slug]` 轮播图、视频、规格表正常
- [ ] 资质证书 `/certificates` 列表展示
- [ ] 公司介绍 `/about` 内容完整
- [ ] 联系询盘 `/contact` 表单可提交，提交后 Supabase `inquiries` 表有新记录
- [ ] 中文仅姓名 + 手机、仅姓名 + 微信均可提交；两者都空时拒绝
- [ ] 英文仅 Email、仅 WhatsApp 均可提交；两者都空时拒绝
- [ ] 产品 ID/slug、页面 URL、来源和 UTM 正确写入
- [ ] `/privacy` 与 `/en/privacy` 可访问，隐私同意框默认未选中
- [ ] 移动端 BottomNav 正常切换
- [ ] 产品详情页移动端 BottomNav 隐藏，底部询盘 CTA 正常
- [ ] PC 端 DesktopHeader 正常
- [ ] 响应式布局正常

### 后台验证

- [ ] `/admin` 未登录跳转到 `/admin/login`
- [ ] 登录后进入 Dashboard，统计数字正确
- [ ] 站点设置 / 首页内容 / 页面内容可编辑
- [ ] 类目管理可新增/编辑/删除/启停
- [ ] 产品管理可新增/编辑/发布/删除/设主推/复制/批量操作
- [ ] 产品图片可上传到 Supabase Storage
- [ ] 证书管理可新增/编辑/删除
- [ ] 公司信息可保存
- [ ] 询盘管理可查看未读、筛选、分页、备注、负责人、切换状态并导出当前筛选结果 CSV

### SEO / GEO 验证

- [ ] 访问 `/sitemap.xml` 返回完整站点地图
- [ ] 访问 `/robots.txt` 返回规则
- [ ] 产品详情页查看源码包含 JSON-LD Product 结构化数据（不输出 price=0）
- [ ] 产品详情页包含 FAQ JSON-LD
- [ ] 首页查看源码包含 Organization JSON-LD
- [ ] 浏览器标签显示正确 title
- [ ] 不出现实木、A1、B1、ISO9001、CARB P2 等未确认口径

### 安全验证

- [ ] 退出登录后访问 `/admin` 跳转登录页
- [ ] 非管理员账号登录后被拒绝
- [ ] 前台无法直接读取 `/admin` API
- [ ] Storage 私有 bucket 无法被前台直接访问
- [ ] 询盘接口限流生效（频繁提交返回 429）

---

## 常见问题

### Q1: 部署后询盘提交失败？
检查 `SUPABASE_SERVICE_ROLE_KEY` 是否正确配置。询盘写入依赖 service_role，且仅在服务端使用。

### Q2: 图片上传失败？
- 检查 Supabase Storage 是否已创建 `public-assets` bucket
- 检查 `policies.sql` 中 Storage 策略是否执行
- 检查管理员账号是否在 `admin_profiles` 中

### Q3: 后台登录提示无权限？
确认该用户：
1. 已在 Supabase Authentication → Users 中创建
2. 已在 `admin_profiles` 表中添加对应行（id 一致）

### Q4: 产品详情页 404？
- 确认产品 `is_published = true`
- 确认 `slug` 唯一且无特殊字符
- ISR 缓存可能延迟，可等待 60 秒或重新部署

### Q5: 部署后样式异常？
- 确认构建时 Tailwind CSS 编译成功
- 检查 `tailwind.config.ts` 中 `content` 路径包含所有组件目录
- 清除浏览器缓存后重试

### Q6: 微信内置浏览器打不开？
- 确保站点已配置 HTTPS
- 微信可能拦截部分外部域名，建议使用已备案域名
- 检查 `next.config.mjs` 中图片远程域名配置

### Q7: CMS 内容不显示？
- 确认已执行 `supabase/cms_seed.sql`
- 确认 `homepage_content` / `page_content` 表有数据
- 非 Demo 模式下 CMS 查询失败会自动 fallback 到默认文案，不会导致页面崩溃

---

## 历史备选方案（仅供参考，不属于当前架构）

CloudBase 与 Cloudflare Pages 曾作为中国大陆部署的备选方案评估，但当前正式架构已确定为 EdgeOne + Supabase，本节仅作为决策证据保留。除非 EdgeOne 或 Supabase 在中国大陆运营商网络下被真实证据证明为瓶颈，否则不进入迁移评估。完整历史候选方案与 Go/No-Go 条件见 [ADR-001](./docs/ADR-001-CHINA-DEPLOYMENT.md)。

## 域名与 SSL

- Staging 使用平台提供的 HTTPS URL；自定义正式域名、DNS 和生产证书不在本阶段变更
- 微信公众号菜单绑定 H5 时要求 HTTPS
- 海外客户通过二维码访问时，HTTPS 是必须的
- 建议使用顶级域名（如 `kzq.com`）或二级域名（如 `catalog.kzq.com`）

## 性能优化

项目已内置以下优化：
- 图片懒加载（Next.js Image）
- ISR 静态再生成（产品详情页 60 秒）
- Tailwind CSS purge
- 数据库索引（见 schema.sql）

如需进一步优化：
- 根据真实 EdgeOne Function 与 Supabase 耗时证据选择部署地域或后端迁移
- 图片使用 Supabase Image Transformations
## 第一方统计与微信分享部署

1. 按时间顺序执行 `supabase/migrations/20260714125149_production_stability_analytics_wechat.sql`。
2. 验证 `analytics_events` 已启用 RLS，`anon` 无法直接 insert/select，`service_role` 可通过服务端 API 写入并执行 `get_analytics_summary`。
3. 不配置微信变量时部署应正常完成，`/api/wechat/jssdk` 返回空响应，普通 OG 分享不受影响。
4. 如需启用微信公众号 JS-SDK，在部署平台添加仅服务端变量 `WECHAT_APP_ID` 与 `WECHAT_APP_SECRET`。不要添加 `NEXT_PUBLIC_` 前缀。
5. 在公众号后台验证 JS 接口安全域名，确认 `NEXT_PUBLIC_SITE_URL` 为同一 HTTPS 正式域名，再在微信内测试首页、产品详情和案例详情分享。
6. 默认 token/ticket 缓存为单实例内存缓存；多实例高流量部署可实现 `WechatCache` 接口迁移到 KV/Redis，无需改动签名服务。
