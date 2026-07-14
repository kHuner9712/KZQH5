# KZQ 产品展示站

## 中英文公共前台

公共前台采用中文无前缀、英文 `/en` 前缀的独立 URL：例如 `/products/[slug]` 与 `/en/products/[slug]`。现有中文分享链接保持不变；语言切换会保留当前路径、产品 slug、筛选参数和 query string。

两种语言共用查询与展示模块，通过 `lib/i18n` 统一选择 `*_cn` / `*_en` 字段；英文为空时由同一辅助函数回退中文。页面分别输出 canonical、`hreflang`、Open Graph locale、产品/FAQ/Organization JSON-LD，sitemap 同时列出中英文 URL。

中文和英文分别使用独立根布局输出 `lang="zh-CN"` 与 `lang="en"`。公共数据读取不依赖 cookies，继续使用 300 秒 ISR；不会因为判断语言而把全部前台强制改成动态渲染。

Demo 模式同样支持 `/en` 页面、英文产品/类目/证书/首页/联系内容和英文 SEO。语言路由不需要新增环境变量，`NEXT_PUBLIC_SITE_URL` 必须填写不带 `/en` 的站点根地址。

## 采购资料与应用案例

- `product_assets` 统一管理站点级目录与产品级资料，类型包含 catalog、datasheet、installation、certificate、packaging、other。前台只读取已发布资料，并提供 PDF/图片在线预览、复制链接和微信内“在浏览器中打开”提示。
- `/projects`、`/projects/[slug]` 与对应 `/en/projects` 路由展示已发布案例；首页只读取已发布且主推的案例。无真实案例时显示空状态，不创建示例项目或 AI 图片。
- 后台 `/admin/product-assets` 管理资料；`/admin/projects` 管理案例、多图、关联产品、发布/主推/排序和 SEO。
- 证书页和产品详情使用轻量全屏查看器，支持键盘切换、ESC、拖动与双指缩放，不新增图片查看依赖。
- 已部署项目必须执行 `supabase/migrations/20260714084116_procurement_assets_and_projects.sql`。该功能不新增环境变量，公开文件仍上传到 `public-assets`，且只能使用展示版或水印版。

## 产品搜索与询盘清单

产品中心的 `q` query string 由服务端数据库函数搜索，覆盖中英文名称、slug/型号、摘要、材质、尺寸、应用、搜索别名和中英文关键词。搜索会统一大小写、空格及常见中英文标点，分页、分类和语言切换都会保留查询条件；页面不会把全部产品加载到浏览器搜索。

`20260714032351_b2b_product_search_and_inquiry_items.sql` 新增 `products.search_document`、`pg_trgm` 索引和参数化 `search_published_products` RPC。RPC 使用调用者权限，继续受产品 RLS 约束，不把用户输入拼入 PostgREST 表达式。

询盘清单是 B2B 产品选择工具，不是购物车，不包含价格、支付、库存或下单。匿名用户的清单只保存在浏览器 `localStorage`，键名为 `kzq.inquiry-list.v1`，仅包含产品 ID、slug、中英文名称、封面 URL 和需求数量，不保存联系人信息。提交时服务端会按产品 ID读取最新产品资料，并由受限的 `create_inquiry_with_items` 数据库函数在同一事务中写入 `inquiries` 与 `inquiry_items`；手工填写且没有清单的旧询盘流程继续兼容。

KZQ 品牌对外展示站点 + 后台内容管理系统（CMS）。基于 Next.js App Router + TypeScript + Tailwind CSS + Supabase 构建。

## 项目定位

- **手机端**：微信小程序风格 H5，可嵌入微信公众号菜单，可通过二维码在浏览器访问
- **PC 端**：正式企业产品目录网站，响应式自适应桌面宽屏
- **GEO 内容底座**：产品详情、FAQ、关键词、SEO metadata 同时服务于生成式引擎优化
- **多入口**：支持微信公众号菜单、二维码、浏览器直接访问

## 技术栈

- **前端框架**：Next.js 14 App Router
- **语言**：TypeScript
- **样式**：Tailwind CSS（自定义 graphite / steel / gold 配色）
- **数据库 / 认证 / 文件存储**：Supabase (PostgreSQL + Auth + Storage)
- **图标**：lucide-react
- **部署**：Vercel（推荐）/ Cloudflare Pages（备选，需额外适配）

## 项目结构

```
/app
  /(public)                    # 前台 H5 + PC 响应式
    /page.tsx                  # 首页
    /products/page.tsx         # 产品中心
    /products/[slug]/page.tsx  # 产品详情
    /certificates/page.tsx     # 资质证书
    /about/page.tsx            # 公司介绍
    /contact/page.tsx          # 联系询盘
    /layout.tsx
  /admin
    /login/page.tsx            # 管理员登录
    /(protected)/              # 受保护后台
      /page.tsx                # Dashboard
      /site-settings/page.tsx  # 站点设置
      /homepage/page.tsx       # 首页内容管理
      /pages/page.tsx          # 页面内容管理
      /categories/page.tsx     # 类目管理
      /products/page.tsx       # 产品列表（搜索/筛选/分页/批量）
      /products/new/page.tsx   # 新增产品
      /products/[id]/edit/page.tsx  # 编辑产品
      /certificates/page.tsx   # 证书管理
      /company/page.tsx        # 公司信息
      /inquiries/page.tsx      # 询盘管理
      /layout.tsx              # 鉴权布局
  /api/inquiries/route.ts      # 询盘提交 API（service_role 写入 + 反滥用）
  /sitemap.ts /robots.ts       # SEO
/components
  /admin                       # 后台组件（AdminLayout / Toast / ImageUpload / ProductForm / Modal）
  /public                      # 前台组件（BottomNav / DesktopHeader / ProductCard / ImageCarousel / InquiryForm 等）
  /ui                          # 通用 UI（Button / Input）
/lib
  /queries/cms.ts              # CMS 内容读取（site_settings / homepage_content / page_content）
  /supabase                    # server.ts / admin.ts / client.ts / storage.ts
  /utils.ts                    # cn / generateSlug / formatDate / siteUrl / normalizeSearchTerm
  /demo.ts                     # Demo 模式判断
  /mock-data.ts                # Demo 模式 mock 数据
/supabase
  schema.sql                   # 基础表 + 索引 + 触发器
  policies.sql                 # RLS 权限策略 + Storage buckets
  seed.sql                     # 基础种子数据（类目/产品/证书/公司/站点设置）
  cms_seed.sql                 # CMS 种子数据（site_settings 扩展字段 / homepage_content / page_content / 产品 GEO 字段）
  migrations/cms_upgrade.sql   # CMS 升级迁移（新增表与字段）
/types/database.ts             # 类型定义
docs/LAUNCH_CHECKLIST.md       # 交付前检查清单
.env.example
```

## 本地运行

### 1. 准备 Supabase 项目

1. 访问 https://supabase.com 注册并创建一个新项目。
2. 在项目 **Settings → API** 中获取：
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY`（仅在服务端使用）
3. 在 **SQL Editor** 中按顺序执行：
   - `supabase/schema.sql`
   - `supabase/policies.sql`
   - `supabase/seed.sql`（基础种子数据）
   - `supabase/cms_seed.sql`（CMS 内容 + 产品 GEO 字段）
4. 在 **Storage** 中确认已创建两个 bucket：
   - `public-assets`（公开读，管理员写）
   - `private-assets`（预留，前台不可访问）

   `policies.sql` 已包含 bucket 创建与策略语句，正常情况下执行 SQL 后即自动创建。

### 2. 创建管理员账号

1. 在 Supabase **Authentication → Users** 中点击 **Add user**，填写邮箱与密码。
2. 切换到 **Table Editor → `admin_profiles`**，新增一行：
   - `id`：粘贴上一步创建用户的 UUID
   - `email`：与登录邮箱一致
   - `role`：`admin`

> 只有 `admin_profiles` 中存在的用户才能登录后台。

### 3. 配置环境变量

复制 `.env.example` 为 `.env.local` 并填入：

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOi...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
NEXT_PUBLIC_SITE_URL=http://localhost:3000
# 可选：企业微信机器人通知
# INQUIRY_WECOM_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
# 可选：Resend HTTP API 邮件通知（不使用 SDK）
# RESEND_API_KEY=re_...
# INQUIRY_NOTIFICATION_FROM=KZQ Website <inquiries@example.com>
# INQUIRY_NOTIFICATION_TO=sales@example.com
# 可选：开启 Demo 模式（前台使用 mock 数据，不请求 Supabase）
# NEXT_PUBLIC_DEMO_MODE=true
```

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` 仅在服务端使用，绝不能写入 `NEXT_PUBLIC_*` 前缀变量，也不可提交到 Git。

已部署过数据库的项目还需按时间顺序执行 `supabase/migrations`。依次执行 `20260713181111_upgrade_inquiries.sql`、`20260714032351_b2b_product_search_and_inquiry_items.sql` 与 `20260714084116_procurement_assets_and_projects.sql`；不要修改或重跑历史迁移。全新项目执行基础 SQL 后也要执行这些迁移，再按需加载 seed/demo 数据。

### 4. 安装依赖并启动

```bash
npm install
npm run dev
```

打开 http://localhost:3000 查看前台，http://localhost:3000/admin 登录后台。

### 5. 常用脚本

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 生产构建 |
| `npm run start` | 启动生产服务器 |
| `npm run lint` | ESLint 检查 |
| `npm run typecheck` | TypeScript 类型检查 |

## 部署

详细步骤见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

## 生产稳定性、第一方统计与微信分享

- 全站提供双语错误、404、加载与断网提示；公开查询异常进入可重试错误边界，产品/案例真实不存在仍返回 404。
- `/api/analytics/events` 是唯一统计写入入口。服务端校验事件白名单、字段长度与 UUID，并做短时限流；`analytics_events` 不向 `anon` 或 `authenticated` 开放直接读写，不保存 IP、指纹、User-Agent 或表单个人内容。
- 后台 `/admin/analytics` 提供 7/30/90 天及自定义时间范围的页面、产品、搜索、联系、询盘、来源和 UTM 汇总。生产数据库必须执行 `supabase/migrations/20260714125149_production_stability_analytics_wechat.sql`。
- 普通网页分享始终使用 canonical、双语 title/description 和 OG 图片。产品与案例详情优先使用各自封面；无封面时使用站点生成的 KZQ 分享图。
- 微信 JS-SDK 是可选增强。仅当服务端同时配置 `WECHAT_APP_ID`、`WECHAT_APP_SECRET` 时启用；密钥不会进入客户端。access token 与 jsapi ticket 通过 `lib/services/wechat/cache.ts` 的可替换缓存接口保存，默认实现为进程内缓存。

微信公众号正式启用仍需人工完成：在公众号后台配置并验证 JS 接口安全域名，保证正式域名 HTTPS 可访问，将正式域名写入 `NEXT_PUBLIC_SITE_URL`，在部署平台安全配置两项微信变量，并用公众号测试账号在微信内验证分享卡片。没有可靠凭据与已验证域名时不要配置这两项变量。

## 安全策略

详细说明见 [SECURITY.md](./SECURITY.md)。

## 核心特性

- **响应式**：手机端微信小程序风格 H5（底部 Tab 导航固定为：首页 / 产品 / 资质 / 询盘），PC 端企业目录网站（DesktopHeader 顶部导航可包含关于我们）
- **CMS 化**：站点设置、首页内容、页面内容、产品 GEO 字段均可在后台维护
- **双语字段**：所有内容表均预留中英文字段，便于海外 GEO 优化
- **RLS 权限**：前台匿名只能读已发布内容；询盘提交必须通过 `/api/inquiries` 路由（服务端 `service_role` 写入），不开放 anon 直接 insert `inquiries`；后台需登录 + admin_profiles 校验
- **SEO / GEO**：每页 metadata、产品 JSON-LD、Organization JSON-LD、FAQ JSON-LD、sitemap.xml、robots.txt
- **双语询盘**：中文要求姓名、感兴趣产品及手机号/微信号之一；英文要求姓名、感兴趣产品及 Email/WhatsApp 之一。提交记录产品 ID/slug、来源页面、referrer 与 UTM。
- **询盘管理**：后台支持未读角标、筛选、分页、状态、备注、负责人和带 UTF-8 BOM/公式注入防护的筛选结果 CSV 导出。
- **询盘安全与通知**：提交必须通过 `/api/inquiries`，服务端做 honeypot、可替换限流边界、垃圾内容和字段校验；写入后可选发企业微信/邮件通知，通知失败不影响提交，Demo 模式不写库也不发送。
- **图片上传**：基于 Supabase Storage，5MB 限制，仅上传展示版/水印版图片

## 业务口径

- 品牌以 KZQ 为主
- 所有产品统一 B级防火
- 所有产品统一 E0级环保
- 价格统一为"请联系销售获取报价" / "Contact for quotation"
- 证书只使用展示版/水印版
- 不出现实木、A1、B1、ISO9001、CARB P2 等未确认口径
- 不写入成本价、底价、内部价等敏感信息

## 默认值

- 产品防火等级：`B级`
- 产品环保等级：`E0级`
- 价格展示：`请联系销售获取报价` / `Contact for quotation`
- 站点默认语言：`zh`
