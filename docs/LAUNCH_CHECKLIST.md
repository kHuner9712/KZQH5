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
- [ ] `20260714032351_b2b_product_search_and_inquiry_items.sql` 已执行（搜索索引/RPC + inquiry_items + 原子写入函数）
- [ ] `20260714084116_procurement_assets_and_projects.sql` 已执行（采购资料 + 案例 + 多图 + 产品关联 + RLS）
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
- [ ] 中文、英文、slug/型号、材质、尺寸、应用、别名和关键词搜索正常；大小写、空格、常见标点不影响结果
- [ ] 搜索 query string 可分享，分类、分页和中英文切换后仍保留 `q`
- [ ] `/products?page=999` 越界页码重定向到合法页
- [ ] `/products/[slug]` 产品详情正常（轮播图、规格表、FAQ、CTA）
- [ ] `/certificates` 资质证书列表展示正常
- [ ] 证书可全屏查看，支持上一张/下一张、ESC、键盘切换、拖动和双指缩放
- [ ] 产品资料只显示已发布内容；PDF/文件有在线预览、复制链接和微信内提示
- [ ] `/projects`、`/projects/[slug]`、`/en/projects` 与英文详情正常；无案例时显示空状态
- [ ] `/about` 公司介绍内容完整
- [ ] `/contact` 联系询盘表单可提交
- [ ] 产品卡与详情页可加入询盘清单；重复加入不产生重复项，数量角标正确
- [ ] 清单支持多个产品、修改需求数量、删除、清空；刷新和中英文切换后仍保留
- [ ] 提交成功后清空已提交清单并显示产品数量；提交失败时清单保持不变
- [ ] 移动端 BottomNav 正常切换，固定显示"首页 / 产品 / 资质 / 询盘"（不出现"关于"）
- [ ] 产品详情页移动端 BottomNav 隐藏，底部询盘 CTA 正常
- [ ] 产品详情页点击"立即询盘"后，联系页表单"感兴趣产品"字段自动带入当前产品名
- [ ] 产品详情进入询盘后同时写入 product_id / product_slug / 产品显示名称 / 当前语言 / 来源页面
- [ ] 中文：姓名 + 手机可提交；姓名 + 微信可提交；手机和微信都空时拒绝
- [ ] 英文：Email 可作为唯一联系方式提交；WhatsApp 可作为唯一联系方式提交；两者都空时拒绝
- [ ] 首页来源参数进入详情再进入询盘后仍保留，source/channel/UTM/referrer/page_url 正确写入
- [ ] `/privacy` 和 `/en/privacy` 内容完整；表单隐私同意项默认未选中且未同意时拒绝
- [ ] PC 端 DesktopHeader 正常显示
- [ ] 响应式布局正常（375px / 390px / 414px / 768px / 1024px / 1440px）
- [ ] 图片加载失败有 onError fallback（渐变占位 / KZQ 占位）
- [ ] PC 端 Footer 显示 site_settings.footer_text_cn（无配置时显示默认文案）

---

## 4. 后台检查

- [ ] `/admin` 未登录跳转到 `/admin/login`
- [ ] 登录 / 退出正常
- [ ] 登录错误不显示 Supabase 原始英文报错（仅显示固定中文文案）——KZQ-P1-020
- [ ] 同 IP 连续超过 5 次登录尝试后，页面显示固定限流文案且不再发起 Auth 调用——KZQ-P1-021
- [ ] 启用 MFA 的管理员：密码登录后跳转 `/admin/mfa/challenge`，输入身份验证器验证码后进入后台——KZQ-P1-022
- [ ] 未绑定 MFA 的管理员登录后直接进入后台（不锁死未启用账号）——KZQ-P1-022
- [ ] `/admin/security` 可查看 MFA 状态、绑定 TOTP 因子；绑定后状态显示"已启用"——KZQ-P1-022
- [ ] aal1 会话（登录后未完成 MFA challenge）调用敏感 API（如询盘导出）返回 401 + 固定码 `ADMIN_WRITE_MFA_REQUIRED`；完成 challenge 后同一接口返回 200——KZQ-P1-022
- [ ] **平台侧（人工验收）**: Supabase Auth Dashboard → Authentication → Multi-factor Authentication 已启用 TOTP（Enrollment 策略明确为 Optional/Required）——KZQ-P1-022
- [ ] **平台侧（人工验收）**: `npm run test:e2e:staging` 的 `staging-mfa.spec.ts` 全部通过（测试账号已绑定因子且提供 `STAGING_MFA_SECRET`）——KZQ-P1-022-f
- [ ] **平台侧（人工验收）**: Supabase Auth Dashboard 已配置登录限流（Auth → Rate Limits，按 IP / 邮箱），直接调用 Auth API 超限返回 429——KZQ-P1-021
- [ ] **平台侧（人工验收）**: EdgeOne WAF 已为 `/api/admin/login-guard` 与 `/admin/login` 配置限流规则（见 `docs/EDGEONE_WAF_RULES.md` §2.12）——KZQ-P1-021
- [ ] `/admin/site-settings` 站点设置可保存
- [ ] `/admin/homepage` 首页内容可编辑
- [ ] `/admin/pages` 页面内容可编辑
- [ ] `/admin/categories` 类目管理（新增/编辑/删除/启停）
- [ ] `/admin/products` 产品列表（搜索/筛选/分页/批量操作）
- [ ] `/admin/products/new` 新增产品
- [ ] `/admin/products/[id]/edit` 编辑产品
- [ ] `/admin/certificates` 证书管理
- [ ] `/admin/product-assets` 可新增、编辑、删除、发布、排序站点级和产品级资料
- [ ] `/admin/projects` 可新建、编辑、发布/下架、主推、排序、多图上传、关联产品和维护 SEO
- [ ] `/admin/company` 公司信息可保存
- [ ] `/admin/inquiries` 未读数/新询盘角标/打开自动已读/手动未读正常
- [ ] 状态、语言、来源、日期筛选与分页正常
- [ ] 备注和负责人可保存；电话、mailto、WhatsApp、复制微信号可用
- [ ] CSV 导出当前筛选结果，中文 Excel 可打开且公式注入被防护
- [ ] 询盘详情与 CSV 均显示多产品清单、各产品数量和名称快照；产品删除后历史询盘仍可理解
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

- [ ] EdgeOne Demo Preview 使用独立项目且只设置 `NEXT_PUBLIC_DEMO_MODE=true`
- [ ] EdgeOne Supabase Staging 使用独立项目和独立 Supabase，未使用 Production 凭据
- [ ] Makers 配置为 Node 20、`npm ci`、`npm run build`、`.next`
- [ ] `/api/health` 返回 `no-store`、正确 commit/demo/runtime，且不泄露环境信息
- [ ] `npm run check:deployed` 对真实 EdgeOne URL exit 0
- [ ] `npm run test:e2e:staging` 只读流程对真实 EdgeOne URL exit 0
- [ ] `NEXT_PUBLIC_SITE_URL` 是当前 Staging 根 URL（非 localhost，且不附加 `/en`）
- [ ] `SUPABASE_SERVICE_ROLE_KEY` 只在服务端环境变量中（未出现在 `NEXT_PUBLIC_*` 变量中）
- [ ] 远程写入仅在 `ALLOW_WRITES=true` 且 `KZQ_STAGING_CONFIRMATION=KZQ-STAGING-ONLY` 时执行
- [ ] GitHub `staging` Environment Secrets 已配置，PR/fork 不会获得 Secrets
- [ ] 自定义域名/DNS/HTTPS 未在本阶段擅自变更
- [ ] 微信与三大运营商结果已填写 `CHINA_WECHAT_NETWORK_TEST.md`；未测项保持“未测”
- [ ] 询盘提交后 Supabase `inquiries` 表有新记录
- [ ] 询盘接口限流生效（频繁提交返回 429）
- [ ] 未配置通知变量时正常提交；通知接口失败时询盘仍成功
- [ ] Demo 模式不写数据库、不发送真实通知
- [ ] **EdgeOne WAF 请求体上限**: `/api/admin/storage/upload` 路径上限不得高于 6MB（EdgeOne Cloud Functions 平台硬限制）。应用层 `MAX_REQUEST_BYTES=5MB` / `MAX_FILE_BYTES=4.5MB` / per-MIME 4MB。**此前 21MB WAF 配置已废弃**（Review #2 WP7 修正：EdgeOne Cloud Functions 平台请求体 6MB 是硬限制，WAF 配置无法突破）
- [ ] **EdgeOne WAF 限流**: `/api/admin/storage/upload` 设为 20 次/5 分钟/IP（叠加进程内限流）
- [ ] **EdgeOne WAF 并发限制**: 上传路径并发连接数 ≤ 5/IP（防止单 IP 同时打开多个上传消耗内存）
- [ ] **Node.js `--max-old-space-size`**: 至少 256MB（容许 5 并发 × 5MB 峰值 + 基础进程内存；此前 512MB 基于 21MB 上限已不再需要）
- [x] **两阶段上传已实现**: 客户端直传 Supabase Storage（`/api/admin/storage/upload/authorize` → 浏览器直传 → `/api/admin/storage/upload/finalize`），绕过 EdgeOne 6MB 平台限制。PDF 上限 20MB，图片上限 5MB。Admin UI 组件（`FileUpload`、`ImageUpload`、项目图片上传）已全部接入两阶段上传路径。**部署前提**: Supabase Storage bucket 必须配置 CORS 允许浏览器 PUT（详见 `docs/TWO_PHASE_UPLOAD_DESIGN.md` 第 4.1 节）。
- [ ] **匿名分析接口限流生效**（频繁提交返回 429）
- [ ] **未知 IP 时使用稳定 fallback bucket**（生产 `RATE_LIMIT_FALLBACK_SECRET` ≥ 32 字符已配置；缺失时使用 `fallback:global` 单桶，不产生随机 key）
- [ ] **`TRUSTED_PROXY_HEADER` 已正确配置**（EdgeOne 设为 `eo-connecting-ip`；未配置或非法值时所有代理 Header 不可信）
- [ ] **`OUTBOX_DISPATCH_SECRET` 已配置**（≥ 16 字符；缺失时 `/api/internal/outbox/dispatch` 返回 503，询盘提交仍写表但通知不投递）
- [ ] **`x-forwarded-for` 永远不被信任**（不再有 `TRUST_X_FORWARDED_FOR` 开关）
- [ ] **KZQ-P1-011-a: 分布式限流边界已验证**：应用层 `MemoryRateLimiter` 仅单进程一致，EdgeOne 多实例部署时实际阈值为 N×配置值。生产环境必须按 `docs/EDGEONE_WAF_RULES.md` 第 1 节配置 EdgeOne WAF / Rate Limiting 规则作为跨实例 floor，执行第 5 节全部验收测试并归档证据后，设置 `WAF_RATE_LIMIT_VERIFIED=true`（仅接受精确字符串 `"true"`）
- [ ] **CSP Reporting 已接通**：浏览器 DevTools Network 可观察到 `/api/csp-report` 的 POST 请求；`Reporting-Endpoints` 响应头包含 `csp-endpoint`；CSP `report-to csp-endpoint` 与 `report-uri /api/csp-report` 同时存在（兼容现代 Reporting API 与 legacy `report-uri`）。当前公开站点保持 Report-Only，本阶段不要求 enforcing
- [ ] **CSP 日志无敏感信息**：`/api/csp-report` 日志不包含 query string、`script-sample`、完整 `blocked-uri` 或完整请求体（仅记录固定错误码、route、计数）
- [ ] **`npm run check:release-readiness:staging` 在 Staging 通过**（exit 0；任何 BLOCK 必须修复后方可发布；staging 环境 `WAF_RATE_LIMIT_VERIFIED` 未设置时仅 WARN）
- [ ] **`npm run check:release-readiness -- --mode=production` 在正式发布前通过**（exit 0；TRUSTED_PROXY_HEADER / RATE_LIMIT_FALLBACK_SECRET / OUTBOX_DISPATCH_SECRET / BUILD_MOCK_BACKEND / loopback Site URL / loopback Supabase URL / DEMO_MODE / service role 暴露 / WAF_RATE_LIMIT_VERIFIED 等 BLOCK 条件全部满足。注：CSP_ENFORCING=true 不是 BLOCK 条件——admin 路由始终 Report-Only，public 路由在 CSP_ENFORCING=true 时执行 img-src/connect-src/frame-ancestors 等指令，script-src 保留 'unsafe-inline' 以兼容 ISR）
- [ ] **Readiness Canary Provision 已部署**：在 Supabase Storage `public-assets` bucket 上传 1×1 占位 PNG 到固定路径 `canary/canary-1x1.png`（路径硬编码在 `app/api/readiness/route.ts`，不可通过环境变量修改以防止误指向私有对象）。`/api/readiness` 的 storage 子检查会 GET 此对象；非 200 即视为 storage 不可用并返回 503。部署步骤：
  1. 在 Supabase Dashboard → Storage → `public-assets` 中新建目录 `canary`
  2. 上传任意 1×1 像素 PNG（建议 ≤ 100 字节）并命名为 `canary-1x1.png`
  3. 通过 `curl -I https://{project}.supabase.co/storage/v1/object/public/public-assets/canary/canary-1x1.png` 验证 HTTP 200（public bucket 无需 Authorization）
  4. 部署后访问 `/api/readiness` 验证 `ready=true`；如配置 `READINESS_TOKEN`，可通过 Bearer Token 查看 `storage` 子检查详情
  5. 此对象不含 PII，仅用于 readiness 探测，不得删除或改为私有

---

## 7. 安全检查

- [ ] 退出登录后访问 `/admin` 跳转登录页
- [ ] 非管理员账号登录后被拒绝
- [ ] 前台无法直接读取 `/admin` API
- [ ] Storage `private-assets` bucket 无法被前台直接访问
- [ ] **匿名用户不能直接 insert inquiries**（用 anon key 直接写 Supabase 应被 RLS 拒绝）
- [ ] 询盘提交必须通过 `/api/inquiries` 路由（service_role 写入）
- [ ] 询盘接口 honeypot 触发后返回 success 但不写入数据库
- [ ] 询盘接口 message 含过多 URL 时被拒绝
- [ ] 搜索关键词清洗生效（特殊字符不破坏 Supabase `.or()` 表达式）
- [ ] 搜索通过参数化 RPC 执行，不把用户输入拼接到 PostgREST 表达式
- [ ] `create_inquiry_with_items` 仅 `service_role` 可执行，明细写入失败时主询盘同时回滚

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
# 中英文前台发布检查

- [ ] 中文 `/`、`/products`、产品详情、`/certificates`、`/about`、`/contact`、`/privacy` 可访问
- [ ] 英文 `/en`、`/en/products`、英文产品详情、`/en/certificates`、`/en/about`、`/en/contact`、`/en/privacy` 可访问
- [ ] Header 与“更多”中的语言切换保留当前 slug、产品筛选和 query string
- [ ] 页面 HTML lang、canonical、Open Graph locale 和 `hreflang` 与当前语言一致
- [ ] 产品与 FAQ JSON-LD 使用当前语言，sitemap 同时包含中英文 URL
- [ ] Demo 模式的英文产品、类目、证书、首页与联系页无空白关键文案
## 生产稳定性、统计与微信分享补充检查

- [ ] 已执行 `20260714125149_production_stability_analytics_wechat.sql`
- [ ] `anon` 直接 insert/select `analytics_events` 被拒绝
- [ ] 非法 `event_name` 返回 400，高频事件返回 429，统计失败不影响页面操作
- [ ] `/admin/analytics` 的时间范围、热门产品、热门搜索、来源和 UTM 正常
- [ ] 360/390/430/768/1024/1440 宽度无横向滚动和固定导航遮挡
- [ ] 手机可双指缩放，键盘焦点可见，Dialog 焦点不会逃逸，关闭后焦点返回触发元素
- [ ] 表单错误可被读屏朗读；断网、超时、重复点击、非 JSON 响应和数据库不可用都有双语降级
- [ ] 未配置微信变量时无报错且普通分享 metadata 正常
- [ ] 配置微信变量但微信接口失败时页面仍可浏览和提交询盘
- [ ] 公众号 JS 接口安全域名、HTTPS、正式凭据与微信内分享均已人工验证（如启用）

---

## 9. Vercel 遗留清理（人工操作）

仓库内已无 `vercel.json` 或 `.vercel/` 配置目录，CI workflows 也不引用 Vercel。但 GitHub 仓库可能仍残留 Vercel Integration（GitHub App），无法通过代码删除。以下步骤必须在 GitHub UI 手动完成，不得谎称已通过代码删除：

- [ ] 打开 `https://github.com/settings/installations`（或组织级 `https://github.com/organizations/<org>/settings/installations`），定位 `Vercel` GitHub App
- [ ] 若仍安装：点击 `Configure` → `Uninstall`（或在 Vercel Dashboard → Settings → Git → Disconnect Repository）
- [ ] 若已在 Vercel Dashboard 删除项目：确认 GitHub 仓库 `Settings → Webhooks` 中无残留的 Vercel webhook
- [ ] 若仓库 `Settings → Secrets and variables → Actions` 中残留 `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` 等 Secret，逐项删除
- [ ] 验证 `git log --all --oneline -- 'vercel.json'` 仅出现在历史中，当前工作树无 `vercel.json`
- [ ] 验证 `.github/workflows/*.yml` 中无 `vercel/vercel-action` 等 Vercel Action 引用

---

## 10. 供应链安全（人工操作 + 代码已就绪项）

- [ ] **CodeQL 已配置**：`.github/workflows/codeql.yml` 存在（push/PR/每周调度，security-extended JS/TS 分析）——KZQ-P2-012-a
- [ ] **平台侧（人工验收）**: GitHub 仓库 `Settings → Code security and analysis` 中 **Secret scanning** 为 Enabled——KZQ-P2-012-b
- [ ] **平台侧（人工验收）**: 同一页面 **Push protection** 为 Enabled；推送含测试密钥的 commit 会被 GitHub 拒绝——KZQ-P2-012-b
- [ ] **平台侧（人工验收）**: `Security → Secret scanning` 页面有扫描记录；历史泄露密钥（如 `Import .env`）已定位并轮换——KZQ-P2-012-b
- [ ] 详细步骤见 `docs/SECRET_SCANNING_CONFIG.md`；**不得在仓库中伪造不存在的 secret-scanning 配置文件假装已启用**——KZQ-P2-012-b
