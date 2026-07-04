# KZQ 产品展示站

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
# 可选：开启 Demo 模式（前台使用 mock 数据，不请求 Supabase）
# NEXT_PUBLIC_DEMO_MODE=true
```

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` 仅在服务端使用，绝不能写入 `NEXT_PUBLIC_*` 前缀变量，也不可提交到 Git。

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

## 安全策略

详细说明见 [SECURITY.md](./SECURITY.md)。

## 核心特性

- **响应式**：手机端微信小程序风格 H5（底部 Tab 导航固定为：首页 / 产品 / 资质 / 询盘），PC 端企业目录网站（DesktopHeader 顶部导航可包含关于我们）
- **CMS 化**：站点设置、首页内容、页面内容、产品 GEO 字段均可在后台维护
- **双语字段**：所有内容表均预留中英文字段，便于海外 GEO 优化
- **RLS 权限**：前台匿名只能读已发布内容；询盘提交必须通过 `/api/inquiries` 路由（服务端 `service_role` 写入），不开放 anon 直接 insert `inquiries`；后台需登录 + admin_profiles 校验
- **SEO / GEO**：每页 metadata、产品 JSON-LD、Organization JSON-LD、FAQ JSON-LD、sitemap.xml、robots.txt
- **询盘表单**：提交必须通过 `/api/inquiries`，服务端做 honeypot + 内存限流 + 垃圾内容判断 + 字段校验；Supabase anon key 不能绕过 API 直接写询盘
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
