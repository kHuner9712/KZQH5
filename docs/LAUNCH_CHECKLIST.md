# KZQ 交付前检查清单

本文档用于交付前的完整检查。按顺序逐项确认，全部通过后方可上线。

---

## 1. 本地检查

- [ ] `npm ci` 安装依赖无报错
- [ ] `npm run typecheck` 通过（TypeScript 类型检查）
- [ ] `npm run build` 通过（生产构建成功，所有页面生成）
- [ ] `npm run lint` 通过（ESLint 检查；如有非本次引入的历史问题需单独说明）

---

## 2. Supabase 检查

- [ ] `supabase/schema.sql` 已执行（基础表 + 索引 + 触发器）
- [ ] `supabase/policies.sql` 已执行（RLS 权限策略 + Storage buckets）
- [ ] `supabase/seed.sql` 已执行（基础种子数据）
- [ ] `supabase/cms_seed.sql` 已执行（CMS 内容 + 产品 GEO 字段）
- [ ] `public-assets` bucket 可公开读取
- [ ] `private-assets` bucket 不可公开读取
- [ ] `admin_profiles` 已添加管理员账号
- [ ] 非管理员账号无法进入后台（RLS 生效）
- [ ] 种子数据口径正确：所有产品 `fire_rating = 'B级'`、`eco_grade = 'E0级'`
- [ ] 种子数据无实木 / A1 / B1 / ISO9001 / CARB P2 等未确认口径
- [ ] 种子数据无 Unsplash 图片 URL

---

## 3. 前台检查

- [ ] `/` 首页正常加载，Hero / 类目 / 主推产品 / CTA 正常
- [ ] `/products` 产品中心可筛选一级/二级类目，搜索正常
- [ ] `/products?page=999` 越界页码重定向到合法页
- [ ] `/products/[slug]` 产品详情正常（轮播图、规格表、FAQ、CTA）
- [ ] `/certificates` 资质证书列表展示正常
- [ ] `/about` 公司介绍内容完整
- [ ] `/contact` 联系询盘表单可提交
- [ ] 移动端 BottomNav 正常切换（首页/产品/证书/联系）
- [ ] 产品详情页移动端 BottomNav 隐藏，底部询盘 CTA 正常
- [ ] PC 端 DesktopHeader 正常显示
- [ ] 响应式布局正常（375px / 390px / 414px / 768px / 1024px / 1440px）
- [ ] 图片加载失败有 onError fallback（渐变占位 / KZQ 占位）

---

## 4. 后台检查

- [ ] `/admin` 未登录跳转到 `/admin/login`
- [ ] 登录 / 退出正常
- [ ] `/admin/site-settings` 站点设置可保存
- [ ] `/admin/homepage` 首页内容可编辑
- [ ] `/admin/pages` 页面内容可编辑
- [ ] `/admin/categories` 类目管理（新增/编辑/删除/启停）
- [ ] `/admin/products` 产品列表（搜索/筛选/分页/批量操作）
- [ ] `/admin/products/new` 新增产品
- [ ] `/admin/products/[id]/edit` 编辑产品
- [ ] `/admin/certificates` 证书管理
- [ ] `/admin/company` 公司信息可保存
- [ ] `/admin/inquiries` 询盘管理（查看详情/切换状态）
- [ ] 图片上传到 Supabase Storage 正常
- [ ] 批量操作正常（批量上架/下架/设主推/改类目/删除）
- [ ] 产品复制功能正常

---

## 5. SEO / GEO 检查

- [ ] `/sitemap.xml` 返回完整站点地图
- [ ] `/robots.txt` 返回规则
- [ ] 首页 metadata 正确（title / description）
- [ ] 产品详情 metadata 正确（seo_title_cn / seo_description_cn）
- [ ] Product JSON-LD 不输出 `price=0`（价格以"请联系销售获取报价"为准）
- [ ] FAQ JSON-LD 正常输出
- [ ] Organization JSON-LD 正常输出
- [ ] 不出现实木、A1、B1、ISO9001、CARB P2 等未确认口径
- [ ] 产品 keywords_cn / keywords_en 已填充
- [ ] 产品 geo_summary_cn 已填充

---

## 6. 部署检查

- [ ] Vercel 环境变量完整（`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SITE_URL`）
- [ ] `NEXT_PUBLIC_SITE_URL` 是正式域名（非 localhost / 非 vercel.app 临时域名）
- [ ] `SUPABASE_SERVICE_ROLE_KEY` 只在服务端环境变量中（未出现在 `NEXT_PUBLIC_*` 变量中）
- [ ] Preview 部署正常后再上 Production
- [ ] 自定义域名 HTTPS 正常
- [ ] 微信内置浏览器可访问
- [ ] 询盘提交后 Supabase `inquiries` 表有新记录
- [ ] 询盘接口限流生效（频繁提交返回 429）

---

## 7. 安全检查

- [ ] 退出登录后访问 `/admin` 跳转登录页
- [ ] 非管理员账号登录后被拒绝
- [ ] 前台无法直接读取 `/admin` API
- [ ] Storage `private-assets` bucket 无法被前台直接访问
- [ ] 询盘接口 honeypot 触发后返回 success 但不写入数据库
- [ ] 询盘接口 message 含过多 URL 时被拒绝
- [ ] 搜索关键词清洗生效（特殊字符不破坏 Supabase `.or()` 表达式）

---

## 8. 业务口径检查

- [ ] 品牌统一为 KZQ
- [ ] 所有产品 `fire_rating = 'B级'`
- [ ] 所有产品 `eco_grade = 'E0级'`
- [ ] `price_display_cn` 统一为"请联系销售获取报价"
- [ ] `price_display_en` 统一为"Contact for quotation"
- [ ] 证书只使用展示版/水印版
- [ ] 不出现实木相关内容
- [ ] 不出现 A1、B1、ISO9001、CARB P2、CARB Phase 2 等未确认口径
- [ ] 不出现成本价、底价、内部价、最低成交价等敏感信息
- [ ] 不使用旧 Unsplash 图片作为真实数据图源
