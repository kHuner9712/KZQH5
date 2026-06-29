# 部署指南

本文件说明 KZQ H5 项目部署到 Vercel 或 Cloudflare Pages 的完整步骤。

## 前置条件

1. GitHub / GitLab 仓库（已推送项目代码）
2. Supabase 项目（已完成 schema.sql / policies.sql / seed.sql 部署）
3. 管理员账号已创建（详见 [README.md](./README.md) 第 2 节）

## 必填环境变量

| 变量名 | 说明 | 示例 |
|-------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL | `https://xxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key | `eyJhbGci...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key（仅服务端） | `eyJhbGci...` |
| `NEXT_PUBLIC_SITE_URL` | 站点正式域名 | `https://kzq.example.com` |

⚠️ `NEXT_PUBLIC_SITE_URL` 必须填写正式域名，影响 sitemap.xml、JSON-LD、SEO 分享卡片。

---

## 方案一：部署到 Vercel（推荐）

Vercel 是 Next.js 官方部署平台，零配置支持 App Router、ISR、Edge Functions。

### 步骤

1. **导入项目**
   - 访问 https://vercel.com → New Project
   - 选择你的 Git 仓库 → Import

2. **配置项目**
   - Framework Preset: `Next.js`（自动识别）
   - Root Directory: `./`
   - Build Command: `next build`（默认）
   - Output Directory: `.next`（默认）

3. **配置环境变量**
   - 在 Environment Variables 中逐个添加：
     ```
     NEXT_PUBLIC_SUPABASE_URL
     NEXT_PUBLIC_SUPABASE_ANON_KEY
     SUPABASE_SERVICE_ROLE_KEY
     NEXT_PUBLIC_SITE_URL
     ```
   - 勾选 Production / Preview / Development 三个环境

4. **部署**
   - 点击 Deploy
   - 等待构建完成（约 2-3 分钟）
   - 部署成功后会得到 `xxx.vercel.app` 临时域名

5. **绑定自定义域名**
   - 进入项目 Settings → Domains
   - 添加你的域名（如 `kzq.example.com`）
   - 按提示在域名服务商处添加 CNAME 记录
   - 等 DNS 生效后即可通过自定义域名访问

6. **更新 NEXT_PUBLIC_SITE_URL**
   - 将环境变量改为正式域名
   - 触发一次 Redeploy

### Vercel 优势

- 自动 HTTPS
- 全球 CDN
- 自动部署（push 即发布）
- Preview 部署（每个 PR 一个预览环境）

---

## 方案二：部署到 Cloudflare Pages

Cloudflare Pages 适合希望使用 Cloudflare 全球网络的项目。

### 步骤

1. **安装 Wrangler CLI**（可选，用于本地预览）
   ```bash
   npm install -g wrangler
   ```

2. **构建项目**
   - 访问 https://dash.cloudflare.com → Pages → Create a project
   - 选择 Connect to Git → 关联仓库
   - 配置：
     - Framework preset: `Next.js`
     - Build command: `npx @cloudflare/next-on-pages`
     - Build output directory: `.vercel/output/static`
   - Environment variables：添加上述 4 个环境变量

3. **首次构建**
   - 点击 Save and Deploy
   - 等待构建完成

4. **绑定自定义域名**
   - 进入 Pages 项目 → Custom domains
   - 添加域名，按提示配置 CNAME

### Cloudflare Pages 注意事项

- 需要安装 `@cloudflare/next-on-pages` 适配器
- 部分 Next.js 功能（如 ISR）在 Cloudflare 上支持有限
- Edge Runtime 兼容性需测试
- 建议在 `package.json` 中添加：
  ```json
  "scripts": {
    "build:cf": "npx @cloudflare/next-on-pages"
  }
  ```

---

## 部署后验证清单

部署完成后，按以下清单逐项验证：

### 前台验证

- [ ] 首页 `/` 正常加载，Logo 与品牌展示
- [ ] 产品中心 `/products` 可筛选一级/二级类目
- [ ] 产品详情 `/products/[slug]` 轮播图、视频、规格表正常
- [ ] 资质证书 `/certificates` 列表展示
- [ ] 公司介绍 `/about` 内容完整
- [ ] 联系询盘 `/contact` 表单可提交，提交后 Supabase `inquiries` 表有新记录
- [ ] 移动端体验（Chrome DevTools 设备模拟）
- [ ] 桌面端不崩坏
- [ ] 底部 Tab 导航可正常切换

### 后台验证

- [ ] `/admin` 未登录跳转到 `/admin/login`
- [ ] 登录后进入 Dashboard，统计数字正确
- [ ] 类目管理可新增/编辑/删除/启停
- [ ] 产品管理可新增/编辑/发布/删除/设主推
- [ ] 产品图片可上传到 Supabase Storage
- [ ] 证书管理可新增/编辑/删除
- [ ] 公司信息可保存
- [ ] 询盘管理可查看详情、切换状态

### SEO 验证

- [ ] 访问 `/sitemap.xml` 返回完整站点地图
- [ ] 访问 `/robots.txt` 返回规则
- [ ] 产品详情页查看源码包含 JSON-LD Product 结构化数据
- [ ] 首页查看源码包含 Organization JSON-LD
- [ ] 浏览器标签显示正确 title

### 安全验证

- [ ] 退出登录后访问 `/admin` 跳转登录页
- [ ] 非管理员账号登录后被拒绝
- [ ] 前台无法直接读取 `/admin` API
- [ ] Storage 私有 bucket 无法被前台直接访问

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

---

## 域名与 SSL

- Vercel / Cloudflare Pages 自动提供 HTTPS
- 微信公众号菜单绑定 H5 时要求 HTTPS
- 海外客户通过二维码访问时，HTTPS 是必须的
- 建议使用顶级域名（如 `kzq.com`）或二级域名（如 `catalog.kzq.com`）

## 性能优化

项目已内置以下优化：
- 图片懒加载（Next.js Image）
- ISR 静态再生成（产品详情页 60 秒）
- 移动端优先 CSS
- Tailwind CSS purge
- 数据库索引（见 schema.sql）

如需进一步优化：
- 在 Vercel 中开启 Edge Functions
- 配置 Cloudflare CDN 缓存策略
- 图片使用 Supabase Image Transformations
