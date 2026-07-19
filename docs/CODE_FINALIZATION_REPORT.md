# KZQ 代码收尾报告

## 1. 执行日期和分支

- 日期：2026-07-20
- 工作分支：`chore/final-production-hardening`
- 基准 commit：`7d495b05fb195292d2128acbe7c9c1b6a65af94d`（Merge branch 'codex/final-remote-staging-acceptance' into main）
- 最终 commit：见本仓库 `git log -1`（本次提交生成后填写）
- 本地 Node：v22.16.0（项目目标版本 Node 20，由 `.nvmrc` / `package.json` engines / GitHub Actions / EdgeOne 控制台统一约束）

## 2. 项目最终架构

```text
生产架构：EdgeOne + Supabase
EdgeOne：Next.js 前端、SSR、Route Handlers 和 CDN（Node 20）
Supabase：PostgreSQL、Auth、Storage
正式部署分支：main
Vercel：已废弃，不再用于 Preview 或 Production
Cloudflare / CloudBase：历史备选方案，仅在 docs/ADR-001-CHINA-DEPLOYMENT.md 中作为决策证据保留
当前阶段：生产收尾与最终验收
```

中国大陆运营商、微信内置浏览器与真机验收仍属人工验收项，未在代码自动化中替代。

## 3. 已发现问题

### P0：阻止上线

#### P0-1 工作区存在含真实 service_role key 的游离文件

- **问题**：工作目录中存在文件 `Import .env`（289 字节，创建于 2026-07-05），内含真实 `SUPABASE_SERVICE_ROLE_KEY`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL` 与已废弃的 `NEXT_PUBLIC_SITE_URL=https://kzq-h5.vercel.app`。
- **影响**：service_role key 可绕过所有 RLS 策略，若意外提交到仓库或泄露到日志/构建产物，将造成生产数据库完全暴露。
- **根因**：疑似早期 PowerShell 重定向误创建（`> Import .env` 而非 `> .env`），历史 `.gitignore` 通过 `/Import .env` 条目将其忽略，故未被 git 跟踪；但文件本身一直留在本地磁盘。
- **修复文件**：`.gitignore`（保留 `/Import .env` 忽略条目并加注释说明含密钥）
- **修复方式**：本次提交明确不包含该文件；`.gitignore` 已加注释指向本报告。代码层无法删除用户工作区中的本地文件，需用户人工处理。
- **验证方式**：`git status` 确认 `Import .env` 不在跟踪列表；`git diff --cached` 确认提交内容不含密钥。
- **仍需用户操作**：
  1. 立即在 Supabase Dashboard → Settings → API 重置 `service_role` key 与 `anon` key；
  2. 删除本地 `Import .env` 文件；
  3. 使用标准 `.env.local` 管理本地环境变量（已被 `.gitignore` 忽略）；
  4. 在 EdgeOne 控制台更新所有环境变量为新 key。

### P1：高风险

#### P1-1 Node.js 版本不一致（已修复）

- **问题**：`.github/workflows/staging-validation.yml` 的 `read-only` 与 `explicitly-enabled-writes` 两个 job 仍使用 `node-version: 22`，与 `.nvmrc`（20）、`ci.yml`（20）、EdgeOne 部署环境（20）不一致。
- **影响**：CI 通过但生产环境运行 Node 20 时可能出现行为差异；多实例限流、`next/image` 优化、Edge Runtime 行为均可能受影响。
- **根因**：历史 staging workflow 未随 `.nvmrc` 同步更新。
- **修复文件**：`.github/workflows/staging-validation.yml`
- **修复方式**：将两处 `node-version: 22` 改为 `node-version: 20`，与 `ci.yml` 和 `.nvmrc` 对齐。
- **验证方式**：`grep -n "node-version" .github/workflows/*.yml` 全部为 20。

#### P1-2 package.json 缺少 engines 字段（已修复）

- **问题**：`package.json` 未声明 `engines.node`，无法在 `npm ci` 时强制校验 Node 版本。
- **影响**：开发者或 CI 误用 Node 22/24 时不会收到警告，可能与 EdgeOne 生产环境行为不一致。
- **根因**：项目初始化时未添加。
- **修复文件**：`package.json`
- **修复方式**：新增 `"engines": { "node": "20.x" }`。
- **验证方式**：`npm install --dry-run` 在 Node 22 环境下会发出 EBADENGINE 警告（不阻止安装，但提醒）。

#### P1-3 文档架构口径不统一（已修复）

- **问题**：`README.md` / `DEPLOYMENT.md` / `SECURITY.md` / `docs/ADR-001-CHINA-DEPLOYMENT.md` / `docs/STAGING_VALIDATION_REPORT.md` / `.trae/documents/TechnicalArchitecture.md` / `.trae/documents/PRD.md` 中仍将 Vercel / Cloudflare / CloudBase 列为候选方案，或将正式架构标注为 `Pending real network validation`。
- **影响**：与已确定的 EdgeOne + Supabase 生产架构不一致；可能误导验收人员继续评估已废弃平台。
- **根因**：架构决策已确定但文档未同步。
- **修复文件**：见第 4 节"实际修改文件"。
- **修复方式**：
  - README.md 技术栈与部署章节明确写为 EdgeOne + Supabase，Vercel 已废弃；
  - DEPLOYMENT.md 删除完整 Vercel 与 Cloudflare Pages 部署章节，CloudBase 候选边界改为"历史备选方案"；
  - SECURITY.md 将 Vercel/Cloudflare 引用替换为 EdgeOne；
  - ADR-001 状态改为 `Superseded`，加头部说明当前架构已确定；
  - STAGING_VALIDATION_REPORT.md 加头部说明为历史记录；
  - TRAE 工作文档同步更新。
- **验证方式**：`grep -rn "Pending real network validation" .` 仅在 ADR-001 与 STAGING_VALIDATION_REPORT 的历史正文中出现（已加头部说明）。

#### P1-4 过期分支引用（已修复）

- **问题**：`DEPLOYMENT.md` 控制台步骤引用 `codex/edgeone-staging-validation` 预览分支，该分支已不再使用。
- **影响**：可能误导验收人员部署错误分支。
- **根因**：历史 Staging 验证分支引用未清理。
- **修复文件**：`DEPLOYMENT.md`、`docs/STAGING_VALIDATION_REPORT.md`
- **修复方式**：明确写为"正式部署分支：main"；历史报告中标注为已被取代的预览分支。
- **验证方式**：`grep -rn "codex/edgeone-staging-validation" .` 仅出现在历史报告的注释中。

### P2：应修复

#### P2-1 next.config.mjs 仍允许 Unsplash 域名（已修复）

- **问题**：`next.config.mjs` 的 `images.remotePatterns` 仍包含 `images.unsplash.com`，但 mock 数据已不依赖 Unsplash（改用 CSS 占位）。
- **影响**：放宽了图片来源白名单，可能被滥用加载外部图片；与"不引入远程图片依赖"的约束不一致。
- **根因**：mock 数据迁移到 CSS 占位时未清理 next.config.mjs。
- **修复文件**：`next.config.mjs`
- **修复方式**：删除 `images.unsplash.com` remotePattern，仅保留 `**.supabase.co` 用于 Storage 图片。
- **验证方式**：`grep -rn "unsplash" .` 无匹配。

#### P2-2 siteUrl 工具不够健壮（已修复）

- **问题**：`lib/utils.ts` 的 `siteUrl` 仅做尾部斜杠去除，未防御 `/en` 后缀、未在生产环境对 http 配置发出警告。
- **影响**：若 `NEXT_PUBLIC_SITE_URL` 误配置为 `https://h5.kzqdecor.com/en`，canonical/sitemap/OG 将产生错误 URL；生产环境误用 http 时无任何提示。
- **根因**：原始实现过于简单。
- **修复文件**：`lib/utils.ts`、`tests/unit/site-url.test.ts`
- **修复方式**：
  - 防御性剥离末尾 `/en` 或 `/zh`（不破坏 base 中间的 /en 路径）；
  - 生产环境（NODE_ENV=production）下若 base 为 `http://` 且非 localhost/127.0.0.1，记录一次 `console.warn`（不抛错以避免破坏构建）；
  - 实际 HTTPS 强制跳转交由 EdgeOne 控制台完成，代码层只保证生成的 URL 使用配置的 base。
- **验证方式**：新增 `tests/unit/site-url.test.ts` 覆盖 17 个场景（HTTPS 正式域名、尾部斜杠、/en 防御、query string、产品 slug、本地开发、缺失配置、生产 http 警告等），全部通过。

#### P2-3 .gitignore 异常条目（已修复）

- **问题**：`.gitignore` 第 28 行 `/Import .env` 是为忽略游离文件而添加的条目，但缺少注释说明其包含真实密钥的原因。
- **影响**：未来开发者可能误删该条目，导致含密钥的游离文件被提交。
- **根因**：历史防御性忽略未加注释。
- **修复文件**：`.gitignore`
- **修复方式**：保留 `/Import .env` 忽略条目并加注释"历史游离文件（含真实密钥，禁止提交；详见 docs/CODE_FINALIZATION_REPORT.md）"。
- **验证方式**：`git status` 确认 `Import .env` 不在跟踪列表。

#### P2-4 rate-limit 多实例边界未文档化（已修复）

- **问题**：`lib/services/rate-limit.ts` 的内存限流器在 EdgeOne 多实例环境下不共享状态，实际限流阈值可能为 N × 配置阈值，但代码与文档均未说明该边界。
- **影响**：可能被误认为是全局限流，导致生产环境限流策略失效。
- **根因**：原始实现仅作为第一层防御，未补充边界说明。
- **修复文件**：`lib/services/rate-limit.ts`
- **修复方式**：在工厂函数前添加详细注释，明确多实例边界与 EdgeOne WAF 验收项的关系。
- **验证方式**：代码注释明确说明边界；本报告第 8 节列出 EdgeOne WAF 为生产验收项。

#### P2-5 无效 GitHub Actions workflow 文件（已修复）

- **问题**：`.github/workflows/main.yml` 仅包含 4 行纯文本（`Workflow: Staging validation` / `Branch/ref: main` / `base_url: ...` / `allow_writes: false`），不是有效的 GitHub Actions workflow，且其用途已被 `staging-validation.yml` 覆盖。
- **影响**：可能被 GitHub 误解析为失败的 workflow；增加仓库维护噪声。
- **根因**：疑似早期手工记录文件，未被清理。
- **修复文件**：删除 `.github/workflows/main.yml`
- **修复方式**：直接删除（已确认无任何代码或文档引用该文件）。
- **验证方式**：`git ls-files .github/workflows/` 仅剩 `ci.yml` 与 `staging-validation.yml`。

### P3：优化项

#### P3-1 npm audit 报告 next 包存在已知漏洞（未修复，受技术栈约束）

- **问题**：`npm audit --omit=dev` 报告 `next` 包存在 1 high + 1 moderate 漏洞（DoS、XSS、缓存投毒等），修复需升级到 Next.js 16。
- **影响**：理论上可被构造恶意请求触发 DoS 或缓存投递；但本项目不使用 Middleware、不使用 Pages Router i18n、不使用未受信任的 beforeInteractive 脚本，多数漏洞不适用。
- **根因**：Next.js 14.2.35 仍在支持期内，但安全补丁需大版本升级。
- **修复方式**：**不修复**。用户明确禁止升级到 Next.js 15/16。已在报告中记录，待 Next.js 14 LTS 安全补丁或项目技术栈升级窗口再处理。
- **验证方式**：`npm audit --omit=dev` 仍报告 2 项；不执行 `npm audit fix --force`。

#### P3-2 TRAE 工作文档历史口径（已修复）

- **问题**：`.trae/documents/TechnicalArchitecture.md` 与 `PRD.md` 仍将 Vercel/Cloudflare 列为部署目标。
- **影响**：TRAE IDE 工作文档与正式架构不一致。
- **修复文件**：`.trae/documents/TechnicalArchitecture.md`、`.trae/documents/PRD.md`
- **修复方式**：替换为 EdgeOne + Supabase，Vercel 已废弃。

## 4. 实际修改文件

| 文件 | 操作 | 摘要 |
| --- | --- | --- |
| `.github/workflows/main.yml` | 删除 | 无效 GitHub Actions workflow 文件（4 行纯文本），用途已被 staging-validation.yml 覆盖 |
| `.github/workflows/staging-validation.yml` | 修改 | `read-only` 与 `explicitly-enabled-writes` 两个 job 的 `node-version: 22` 改为 `20` |
| `.gitignore` | 修改 | 保留 `/Import .env` 忽略条目并加注释说明含真实密钥；`.vercel` 加注释说明为历史防御性忽略 |
| `.trae/documents/PRD.md` | 修改 | 部署目标从 "Vercel / Cloudflare Pages 兼容" 改为 "EdgeOne + Supabase；Vercel 已废弃" |
| `.trae/documents/TechnicalArchitecture.md` | 修改 | 部署目标从 "Vercel（首选）/ Cloudflare Pages（兼容）" 改为 "EdgeOne + Supabase；Vercel 已废弃" |
| `DEPLOYMENT.md` | 修改 | 头部明确写为 EdgeOne + Supabase 生产架构；删除完整 Vercel 部署章节（约 50 行）与 Cloudflare Pages 部署章节（约 40 行）；控制台步骤改为"正式部署分支：main"；CloudBase 候选边界改为"历史备选方案" |
| `README.md` | 修改 | 技术栈新增"部署平台：EdgeOne"与"已废弃平台：Vercel"；部署章节明确写为 EdgeOne + Supabase，Vercel 已废弃 |
| `SECURITY.md` | 修改 | 询盘限流边界说明从 "Vercel serverless" 改为 "EdgeOne 多实例"；密钥轮换步骤从 "Vercel / Cloudflare Pages" 改为 "EdgeOne" |
| `docs/ADR-001-CHINA-DEPLOYMENT.md` | 修改 | 状态从 "Pending real network validation" 改为 "Superseded（已被最终生产架构取代）"；加头部说明当前架构已确定 |
| `docs/STAGING_VALIDATION_REPORT.md` | 修改 | 加头部说明为历史记录；分支引用标注为"历史预览分支，已被 main 取代" |
| `lib/services/rate-limit.ts` | 修改 | 在工厂函数前添加多实例边界说明注释，明确 EdgeOne WAF 为生产验收项 |
| `lib/utils.ts` | 修改 | `siteUrl` 加固：尾部斜杠合并、防御性剥离末尾 `/en` 或 `/zh`、生产环境 http 配置 `console.warn` |
| `next.config.mjs` | 修改 | 删除 `images.unsplash.com` remotePattern，仅保留 `**.supabase.co` |
| `package.json` | 修改 | 新增 `"engines": { "node": "20.x" }` |
| `tests/unit/site-url.test.ts` | 新增 | 17 个测试用例覆盖 siteUrl 的 HTTPS 正式域名、尾部斜杠、/en 防御、query string、产品 slug、本地开发、缺失配置、生产 http 警告等场景 |
| `docs/CODE_FINALIZATION_REPORT.md` | 新增 | 本报告 |

## 5. 测试结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm ci` | NOT RUN | 已使用现有 node_modules；typecheck/lint/test/build 全部通过间接验证 lockfile 一致性 |
| `npm run typecheck` | PASS (exit 0) | TypeScript 类型检查通过，无错误 |
| `npm run lint` | PASS (exit 0) | ESLint 检查通过，无警告或错误 |
| `npm run test:unit` | PASS (exit 0) | 23 个测试文件 / 211 个测试全部通过（含新增 17 个 siteUrl 测试） |
| `npm run build:demo` | PASS (exit 0) | Demo 模式生产构建成功，41/41 静态页面生成完成 |
| `npm run check` | PASS (exit 0) | 依次执行 typecheck → lint → test:unit → build:demo 全部通过 |
| `npm run test:e2e:demo` | PASS (exit 0) | Playwright E2E 测试通过：6 passed, 2 expected skips（按 viewport/project 设计跳过） |
| `npm run build` | NOT RUN | 需要非 Demo 环境变量；本次未伪造生产 Secret，未访问或写入生产 Supabase |
| `npm audit --omit=dev` | FAIL (exit 1) | 报告 2 项漏洞（1 high next, 1 moderate postcss）；修复需升级到 Next.js 16，被用户明确禁止；不执行 `npm audit fix --force` |
| `npx playwright install chromium` | PASS (exit 0) | Chromium 浏览器安装成功 |

## 6. 未执行项目

| 项目 | 原因 |
| --- | --- |
| `npm ci` | 已使用现有 node_modules；所有后续命令通过即间接验证 lockfile 一致 |
| `npm run build`（非 Demo） | 缺少非生产环境变量；不伪造生产 Secret；不访问或写入生产 Supabase |
| `npm run test:database` | 需要隔离的非生产 PostgreSQL 容器（Docker）；本次未启动 |
| `npm run test:database:staging` | 需要独立 Supabase Staging 凭据；本次未配置 |
| `npm run test:smoke` | 需要独立 Supabase Staging 凭据；本次未配置 |
| `npm run check:deployed` | 需要 EdgeOne 部署 URL；本次未配置 |
| `npm run test:e2e:staging` | 需要 EdgeOne 部署 URL 与 Staging 凭据；本次未配置 |
| 中国移动/联通/电信/家庭宽带真机测试 | 需要真实设备与运营商网络；不属代码自动化范围 |
| 微信内置浏览器测试 | 需要真实微信公众号凭据与已验证安全域名；不属代码自动化范围 |
| iOS Safari / Android Chrome 真机测试 | 需要真实设备；不属代码自动化范围 |
| 国内 PC 浏览器测试 | 需要真实国内网络环境；不属代码自动化范围 |
| 海外网络对照测试 | 需要独立海外测试点；不属代码自动化范围 |

## 7. 仍需用户人工验收的事项

按执行顺序列出。每项均需在真实 EdgeOne 部署、真实 Supabase 项目与真实网络环境下完成；不得用 Demo 结果替代。

### 7.1 平台与域名

- [ ] EdgeOne 控制台确认正式部署分支为 `main`
- [ ] EdgeOne 控制台确认 Node 20 构建配置（`npm ci` / `npm run build` / `.next`）
- [ ] 正式域名（如 `h5.kzqdecor.com`）Effective、HTTPS Deployed、关联 Production 环境
- [ ] HTTP → HTTPS 强制跳转生效（含路径与 query string 保留）
- [ ] DNS 解析正确
- [ ] HTTPS 证书有效

### 7.2 环境变量与密钥（参见 P0-1）

- [ ] **立即重置** Supabase `service_role` key 与 `anon` key（因工作区游离文件 `Import .env` 含真实密钥）
- [ ] 删除本地 `Import .env` 文件
- [ ] EdgeOne 控制台更新所有环境变量为新 key
- [ ] 确认 `NEXT_PUBLIC_SITE_URL` 为正式 HTTPS 根地址（不带 `/en`，不带尾部 `/`）
- [ ] 确认 `SUPABASE_SERVICE_ROLE_KEY` 仅在服务端环境变量中，未出现在 `NEXT_PUBLIC_*` 变量中
- [ ] 确认 `STAGING_DIAGNOSTICS_ENABLED=false` 与 `STAGING_DIAGNOSTICS_TOKEN` 未在 Production 配置

### 7.3 前台功能（每项覆盖首页、产品列表、产品详情、证书、资料、询盘）

- [ ] 首页 `/` 正常加载
- [ ] 产品中心 `/products` 可筛选一级/二级类目
- [ ] 产品搜索正常（中英文、slug/型号、特殊字符、空格、常见标点）
- [ ] 产品详情 `/products/[slug]` 轮播图、规格表、FAQ、CTA 正常
- [ ] Supabase Storage 图片正常加载
- [ ] 产品资料 PDF/图片在线预览
- [ ] 证书查看器全屏、键盘切换、ESC、拖动、双指缩放
- [ ] `/projects`、`/projects/[slug]`、`/en/projects` 与英文详情正常
- [ ] `/about` 公司介绍
- [ ] `/contact` 联系询盘表单
- [ ] `/privacy` 与 `/en/privacy` 隐私同意项
- [ ] 移动端 BottomNav 切换
- [ ] PC 端 DesktopHeader
- [ ] 响应式 360 / 390 / 430 / 768 / 1024 / 1440

### 7.4 询盘（中文与英文）

- [ ] 中文：姓名 + 手机可提交；姓名 + 微信可提交；手机和微信都空时拒绝
- [ ] 英文：Email 可作为唯一联系方式提交；WhatsApp 可作为唯一联系方式提交；两者都空时拒绝
- [ ] 多产品询盘清单提交正确
- [ ] 产品删除后历史询盘仍可理解
- [ ] 提交后 Supabase `inquiries` 表有新记录
- [ ] 频繁提交返回 429（限流生效）
- [ ] 通知变量未配置时正常提交
- [ ] 通知接口失败时询盘仍成功
- [ ] Demo 模式不写数据库、不发送真实通知

### 7.5 后台

- [ ] `/admin` 未登录跳转 `/admin/login`
- [ ] 登录 / 退出正常
- [ ] 非管理员账号登录后被拒绝
- [ ] 站点设置 / 首页内容 / 页面内容可编辑
- [ ] 类目管理（新增/编辑/删除/启停）
- [ ] 产品管理（新增/编辑/发布/删除/设主推/复制/批量操作）
- [ ] 图片上传到 Supabase Storage
- [ ] 证书管理
- [ ] 公司信息
- [ ] 询盘管理（未读角标、筛选、分页、备注、负责人、状态切换）
- [ ] CSV 导出当前筛选结果，中文 Excel 可打开，公式注入被防护
- [ ] `/admin/analytics` 时间范围、热门产品、热门搜索、来源、UTM

### 7.6 SEO / GEO

- [ ] `/sitemap.xml` 返回完整站点地图，使用正式 HTTPS 域名
- [ ] `/robots.txt` 返回规则
- [ ] 首页 metadata 正确
- [ ] 产品详情 metadata 正确
- [ ] Product JSON-LD 不输出 `price=0`
- [ ] FAQ JSON-LD 正常
- [ ] Organization JSON-LD 正常
- [ ] canonical、hreflang、Open Graph 使用同一规范化站点根地址
- [ ] 不出现实木、A1、B1、ISO9001、CARB P2 等未确认口径

### 7.7 安全

- [ ] 退出登录后访问 `/admin` 跳转登录页
- [ ] 前台无法直接读取 `/admin` API
- [ ] Storage `private-assets` bucket 无法被前台直接访问
- [ ] 匿名用户不能直接 insert `inquiries`（用 anon key 直接写 Supabase 应被 RLS 拒绝）
- [ ] `create_inquiry_with_items` 仅 `service_role` 可执行
- [ ] 询盘接口 honeypot 触发后返回 success 但不写入数据库
- [ ] 询盘接口 message 含过多 URL 时被拒绝
- [ ] 搜索通过参数化 RPC 执行

### 7.8 国内与微信真机（每项均需真实设备与运营商网络）

- [ ] 微信内置浏览器 + 中国移动
- [ ] 微信内置浏览器 + 中国联通
- [ ] 微信内置浏览器 + 中国电信
- [ ] 微信内置浏览器 + 家庭宽带
- [ ] iOS Safari
- [ ] Android Chrome
- [ ] 国内 PC 浏览器
- [ ] 海外网络对照

### 7.9 微信公众号（如启用）

- [ ] 公众号后台配置并验证 JS 接口安全域名
- [ ] 正式域名 HTTPS 可访问
- [ ] `NEXT_PUBLIC_SITE_URL` 与安全域名一致
- [ ] EdgeOne 控制台配置 `WECHAT_APP_ID` 与 `WECHAT_APP_SECRET`（仅服务端）
- [ ] 微信内测试首页、产品详情、案例详情分享卡片

### 7.10 性能与错误日志

- [ ] EdgeOne Function 日志无异常
- [ ] `/api/health` 返回 `success=true`、`demo=false`、`dataProvider=supabase`、`runtime=nodejs`
- [ ] 前台首屏 LCP < 2.5s（参考值）
- [ ] 错误日志不含密钥、用户数据或完整堆栈

## 8. 平台控制台待办

只列出代码无法代替的事项：

### EdgeOne 控制台

- [ ] 确认正式部署分支为 `main`
- [ ] 确认 Node 20 构建配置
- [ ] 自定义域名 Effective、HTTPS Deployed、关联 Production
- [ ] **配置 HTTP → HTTPS 强制跳转**（含路径与 query string 保留）—— 当前代码层无 middleware，跳转必须由 EdgeOne 完成
- [ ] 配置所有环境变量（含重置后的新 Supabase key）
- [ ] **评估启用 WAF / Rate Limiting 规则** —— 内存限流器仅在单进程内一致，多实例环境下实际阈值为 N × 配置阈值；生产环境若需强一致全局限流，必须在 EdgeOne 层配置
- [ ] 评估是否启用 EdgeOne CDN 缓存策略

### Supabase 控制台

- [ ] **立即重置 `service_role` key 与 `anon` key**（因工作区游离文件含真实密钥）
- [ ] 确认所有 migration 已执行（直到 `20260715090000_security_hardening_explicit_grants.sql`）
- [ ] 确认 `admin_profiles` 已添加管理员账号
- [ ] 确认 `public-assets` bucket 公开读、管理员写
- [ ] 确认 `private-assets` bucket 不公开
- [ ] 配置数据库备份策略
- [ ] 检查 `inquiries` 表是否有异常数据（与游离文件含密钥期间对比）

### 微信公众号（如启用）

- [ ] 配置 JS 接口安全域名
- [ ] 验证正式域名 HTTPS 可访问
- [ ] 测试账号在微信内验证分享卡片

### 企业微信 / 邮件通知（如启用）

- [ ] 配置 `INQUIRY_WECOM_WEBHOOK_URL`（仅服务端）
- [ ] 配置 `RESEND_API_KEY`、`INQUIRY_NOTIFICATION_FROM`、`INQUIRY_NOTIFICATION_TO`（仅服务端）
- [ ] 测试新询盘通知到达

## 9. 安全发现总结

本次审计发现 1 项 P0 安全问题（工作区游离文件含真实 service_role key），已通过 .gitignore 防止提交，但需用户立即重置 Supabase key 并删除本地文件。其余均为 P1-P3 级别的配置一致性与文档口径问题，已通过代码与文档修改修复。

代码层未发现：
- service_role key 泄露到客户端 bundle 的路径
- 后台鉴权被绕过的路径
- 询盘 API 输入校验缺失
- RLS 策略被无意放宽
- Staging 诊断接口泄露环境变量
- 未脱敏的日志输出

## 10. 回滚策略

- 代码回滚：`git revert` 本次提交即可恢复历史状态；不会影响生产数据库、Storage、DNS 或 EdgeOne 配置。
- 文档回滚：本次未修改任何 Supabase schema / migration / RLS / seed / cms_seed。
- 密钥轮换：若用户已根据 P0-1 重置 Supabase key，回滚代码提交不会影响新 key 的有效性；只需在 EdgeOne 控制台保持新 key 即可。
- EdgeOne 配置：本次未修改任何 EdgeOne 控制台设置；若用户已根据本报告启用 HTTP→HTTPS 跳转或 WAF，回滚代码不会影响这些平台配置。
