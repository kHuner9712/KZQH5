# KZQ 功能验收清单

验收日期：2026-07-15

## 状态说明

- **通过**：已执行对应自动化检查、构建产物检查或纯逻辑回归，并取得明确通过证据。
- **部分通过**：代码边界与构建产物通过，但受浏览器、本地端口、外网、登录态或第三方配置限制，尚未完成真实交互或外部服务闭环。
- **不通过**：存在尚未落地的修复或明确失败证据。

本次不进行视觉重构。内置浏览器拒绝访问本地 `127.0.0.1`，并禁止换浏览器或地址规避；Supabase 外网访问也被执行沙箱拦截。因此本文不会把编译通过写成真实线上业务通过。

## 核心业务链路结论

| 链路 | 实际结论 | 状态 |
| --- | --- | --- |
| 中英文内容发现：主页 → 产品中心 → 搜索/分类/分页 → 产品详情 | Demo 构建 41/41 路由完成；搜索规范化、分类过滤和分页切片纯逻辑用例通过；动态产品详情路由编译完成。未完成新鲜浏览器点击回归。 | 部分通过 |
| 产品详情：多图/视频 → 加入询盘 → 固定 CTA | 组件、路由与媒体渲染分支通过 typecheck/lint/build；既有 390×844 截图显示产品固定 CTA 未与 Bottom Navigation 重叠。未在真机播放视频。 | 部分通过 |
| 中文/英文询盘：校验 → 来源/UTM → 原子入库 → 成功反馈 | 中英文校验、联系方式、隐私同意、清单去重、伪造 ID 拒绝、UTM 派生均执行通过；数据库函数为单事务写入；通知增加 5 秒超时。未向真实数据库提交测试询盘。 | 部分通过 |
| 新询盘通知 | 企业微信与 Resend 并行、失败隔离且单个适配器最多等待 5 秒；未配置并调用真实 webhook/邮箱。 | 部分通过 |
| 后台询盘管理 → CSV 导出 | 页面/API 编译通过；管理员 JWT 改为 `auth.getUser()` 服务端验证；CSV BOM、公式注入与引号转义用例通过。无管理员登录态，未操作真实询盘。 | 部分通过 |
| SEO：canonical → hreflang → sitemap → JSON-LD → robots | 构建 HTML/XML 已检查：canonical 存在，zh-CN/en/x-default hreflang 已生成，sitemap 32 URL/96 alternate，JSON-LD 可解析且已转义，robots 屏蔽后台/API。生产域名仍需配置。 | 通过（配置后） |
| 来源/UTM → 第一方事件 → 后台统计 | UTM 来源/渠道派生、会话内保留、事件载荷清洗、外部路径拒绝和限流用例通过；未写入真实 analytics_events。 | 部分通过 |
| Demo 模式 | `NEXT_PUBLIC_DEMO_MODE=true npm run build` 无数据请求错误，41/41 页面生成完成。 | 通过 |

## 逐项验收

| 功能 | 测试步骤 | 预期结果 | 实际结果 | 是否通过 | 仍需人工配置/验证 |
| --- | --- | --- | --- | --- | --- |
| 中文首页 | Demo 模式构建 `/`；检查构建 HTML、首页 JSON-LD 和 390×844/1440×1000 基线截图 | 页面可生成，中文内容与入口存在，无固定导航遮挡 | `/` 静态生成；JSON-LD 可解析；既有两档截图无明显遮挡 | 部分通过 | 真实浏览器 360/390/430/768/1024/1440 点击与新截图 |
| 英文首页 | Demo 模式构建 `/en`；检查 canonical/hreflang/JSON-LD | 英文路由独立、SEO 指向 `/en` | `/en` 静态生成；canonical 为 `/en`；三组 hreflang 与 JSON-LD 存在 | 部分通过 | 浏览器确认头部语言切换与实际文案；无 JS 场景复核根 `html lang` |
| 中英文产品中心 | 构建 `/products` 与 `/en/products`；检查共享组件与同一数据源 | 两种语言使用相同产品数据与不同本地化文案 | 两条路由均生成；共享 `ProductsPageContent` | 部分通过 | 真实 Supabase 公开读取与浏览器空状态 |
| 搜索 | 对尺寸、别名、英文关键词执行纯逻辑回归；检查 RPC 授权 | 忽略空白/标点/×/* 差异，返回已发布产品 | `search-normalization`、`search-exact` 用例通过；RPC 显式授予 anon/authenticated execute | 部分通过 | 部署迁移后执行真实 `search_published_products` RPC |
| 一级/二级分类 | 执行 categoryId/subcategoryId 过滤逻辑；检查二级类目从一级类目限定查询 | 分类组合只返回匹配产品 | 一级分类用例通过；二级类目查询按活动一级类目限定 | 部分通过 | 用真实 CMS 数据点击全部组合及无数据类目 |
| 分页 | 测试产品分页切片、后台 page/pageSize 上下界；检查禁用链接 a11y | 页码稳定，越界纠正，禁用链接不可聚焦 | 产品分页、后台分页用例通过；前后页增加 aria-disabled 与 tabIndex | 通过 | 真实产品数超过 24 时点击前后页 |
| 产品详情 | 构建中英文动态详情路由；审计产品、类目、证书和资料查询 | 已发布产品可打开；无产品返回 404 | 两条动态路由编译完成；查询错误进入公开错误边界；缺失产品调用 notFound | 部分通过 | 用真实 slug 打开并核对 CMS 字段 |
| 多图和视频 | 审计 ImageCarousel 图片、视频、触摸滑动、控件分支 | 图片保持比例；视频可播放且 playsInline | `next/image`/视频控件/playsInline/海报逻辑存在并编译 | 部分通过 | iOS、Android、微信内真机播放与滑动 |
| 询盘清单 | 测试去重、数量、刷新、删除/下架清理和 localStorage 异常 | 清单最多 30 项、去重、过期项移除、存储失败不崩溃 | 去重与伪造 ID 用例通过；刷新会移除 API 未返回项；写存储已捕获异常 | 部分通过 | 浏览器跨刷新、跨标签、存储配额和下架产品场景 |
| 中文询盘 | 执行姓名、手机/微信、产品、隐私、邮箱格式校验 | 至少手机或微信；其他规则正确提示 | 有效/缺失联系方式用例均通过 | 部分通过 | Demo 页面真实提交一次；生产库使用明确测试标记提交一次 |
| 英文询盘 | 执行姓名、Email/WhatsApp、产品、隐私、邮箱格式校验 | 至少 Email 或 WhatsApp；港口/贸易条款进入留言 | 有效英文与无效邮箱用例通过；拼接逻辑审计通过 | 部分通过 | Demo 页面与生产测试询盘各一次 |
| 新询盘通知 | 审计 WeCom/Resend 并行发送、失败处理与超时 | 入库成功不因第三方长期挂起而产生前端歧义 | 新增 5 秒 fetch 超时；失败只记录适配器名/错误，不记录密钥 | 部分通过 | 配置 webhook/Resend 后分别模拟成功、4xx、超时 |
| 后台询盘管理 | 检查保护布局、GET/PATCH API、状态白名单、字段长度 | 非管理员拒绝；管理员可筛选、已读、状态、备注、负责人 | 保护布局改为 `auth.getUser()`；API 每次调用再次验证管理员；输入有白名单/长度 | 部分通过 | 管理员与普通账号各登录一次并验证 401/权限隔离 |
| CSV 导出 | 执行 BOM、公式注入、引号转义；审计批量与上限 | Excel 打开中文正常；无公式注入；筛选一致；最多 10000 行 | 所有 CSV 纯逻辑用例通过；批量 500、总上限 10000；响应 no-store | 部分通过 | 真实后台下载并用 Excel/WPS 打开；验证日期/筛选一致 |
| 证书查看器 | 审计全屏、键盘、焦点陷阱、缩放、拖动、上一张/下一张 | 可键盘关闭/切换，可触控缩放，证书仅展示版 | 逻辑、焦点陷阱与 display version 标识编译通过 | 部分通过 | 移动端双指缩放、桌面滚轮/方向键实测 |
| 产品资料下载 | 审计已发布资料查询、预览、外部打开、复制、事件 | 只展示已发布资料；可预览或明确 fallback | RLS 仅允许 published；PDF/图片 iframe 与 fallback 均存在 | 部分通过 | 真实 PDF/图片/未知格式各一份；跨域响应头确认 |
| 微信内下载提示 | 检查 MicroMessenger UA 分支 | 微信内显示“在浏览器打开/复制链接”提示 | UA 检测与提示分支存在并编译 | 部分通过 | 微信真机内置浏览器验证打开与复制 |
| 应用案例 | 构建中英文列表/动态详情；审计 published RLS | 列表与详情可打开，未发布不可见 | 四条路由编译；公开 RLS 限定 published；首页失败为可选降级 | 部分通过 | 真实项目数据、关联产品、详情 404 |
| 隐私政策 | 构建 `/privacy`、`/en/privacy`；检查联系信息来自 CMS | 中英文可访问，不含伪造联系信息 | 两页静态生成；联系信息来自 company_profile | 通过 | 业务方确认最终法务文案和数据保留期限 |
| SEO | 检查 title/description/canonical/OG/Twitter/robots | 各页本地化元数据完整，后台/API 不索引 | 构建 HTML 有 canonical/OG/Twitter；robots 屏蔽后台/API | 通过（配置后） | 生产设置 `NEXT_PUBLIC_SITE_URL` 为 HTTPS 正式域名；Search Console 复核 |
| hreflang | 检查中英首页与 sitemap alternate | zh-CN/en/x-default 双向一致 | HTML 生成三组 alternate；sitemap 每 URL 生成三组 alternate | 通过 | 部署后抓取线上 HTML 再核对一次 |
| sitemap | 检查静态、产品、项目 URL、lastmod 和失败降级 | 只含公开 URL；动态内容用真实 updated_at | Demo 产物 32 URL；静态页无伪造 lastmod；产品/项目使用 updated_at | 通过 | 生产数据网络可用后核对 URL 总数；提交搜索引擎 |
| JSON-LD | 解析首页/关于页产物；测试 `</script>` 转义；审计产品 JSON-LD | JSON 可解析、无注入、无虚假价格/库存声明 | 4 个静态 JSON-LD 解析通过；转义用例通过；移除未确认 InStock | 通过 | 用真实产品详情跑 Schema Validator/Rich Results Test |
| 来源和 UTM | 模拟 utm_source/utm_medium 与 referrer；二次导航再读取 | 来源不丢失，显式 source 优先，direct 可被非直接来源替换 | UTM 派生 source/channel 与会话保留用例通过 | 通过 | 广告链接、二维码、外部 referrer 各做一次线上询盘 |
| 第一方事件统计 | 验证事件名、页面路径、实体 UUID、referrer 清洗、限流 | 只记录允许字段，不记录 IP/表单个人内容 | 有效载荷、外部路径拒绝、限流用例通过；RLS 禁止 anon 直接写 | 部分通过 | 部署 analytics migration；查看后台聚合与事件数量 |
| Demo 模式 | `NEXT_PUBLIC_DEMO_MODE=true npm run build` | 不依赖 Supabase，所有公开路由可生成 | 41/41 页面完成，无数据请求错误 | 通过 | 浏览器完成一遍 Demo 搜索、详情、清单、询盘提交 |
| 404 | 构建中英 catch-all/not-found；检查返回内容组件 | 未知路径显示对应语言 404 | 中英 catch-all 与 not-found 路由编译；静态 `_not-found` 生成 | 部分通过 | 浏览器请求未知中英文 URL 并确认 HTTP 404 |
| 错误页 | 构建全局、中英 error boundary；审计 retry | 数据错误显示本地化提示与重试，不泄露异常详情 | 全局/中文/英文错误边界编译；生产构建网络失败走公开降级日志 | 部分通过 | 浏览器模拟 Supabase 失败并点击 Retry |
| 弱网和断网提示 | 审计 online/offline 监听、表单 15 秒超时、通知 5 秒超时 | 断网提示可读；提交可恢复且不无限等待 | OfflineNotice 与清理监听存在；表单/通知均有超时 | 部分通过 | DevTools Offline/Slow 3G，恢复网络后再提交 |
| 移动端 Bottom Navigation | 审计 safe-area、main padding、详情页隐藏；复核 390 基线截图 | 不遮挡内容，详情页不与固定 CTA 重叠 | main 预留 safe-area；产品详情隐藏 BottomNav；既有截图无重叠 | 部分通过 | 360/390/430 与 iPhone 安全区新截图 |
| 产品详情固定 CTA | 审计 3 个入口与详情页底部间距；复核基线截图 | 联系/加入询盘/立即询盘均可用且不遮挡 | 固定 CTA 路由分支编译；390 基线截图显示正常 | 部分通过 | 真机点击电话、加入清单、询盘跳转 |
| PC Header | 审计主导航、active 状态、语言切换、询盘计数；复核 1440 截图 | 桌面导航完整，活动项正确，移动端隐藏 | Header 组件编译；1440 基线截图显示完整 | 部分通过 | 1024/1440 键盘 Tab 与所有链接点击 |
| 手机缩放和可访问性 | 检查 viewport、无 maximumScale/userScalable 禁用；审计焦点、aria、触控尺寸 | 用户可缩放；交互可键盘操作；触控目标实用 | viewport 为 device-width/initialScale=1；分页禁用态已补；对话框焦点陷阱存在 | 部分通过 | VoiceOver/TalkBack、200% 页面缩放、键盘全流程 |

## 安全与数据库修复

| 优先级 | 问题 | 修复结果 |
| --- | --- | --- |
| P0 | 2026 年新 Supabase 项目不再默认授予 Data API 表权限，核心公开读取会 42501 | 新增 `20260715090000_security_hardening_explicit_grants.sql`；公开表仅 anon/authenticated select，管理写入由 authenticated + RLS，敏感表仅 service_role/管理员策略 |
| P0 | `public.is_admin()` 为公开 schema 的 SECURITY DEFINER，默认可被 PUBLIC 执行且 search_path 可变 | search_path 固定为空；显式撤销 public/anon/authenticated 后仅授予 authenticated/service_role |
| P0 | 后台保护布局使用未向 Auth 服务验证的 `getSession()` | 改为复用 `getVerifiedAdmin()`，先 `auth.getUser()` 再检查 admin_profiles |
| P0 | 根目录 `Import .env` 含 service-role 配置且未忽略 | `.gitignore` 新增精确规则；文件未删除、未读取或输出密钥值 |
| P1 | 通知服务无超时，可能在已入库后让前端超时并诱发重复提交 | WeCom/Resend 单次请求增加 5 秒超时，仍保留失败隔离 |
| P1 | UTM 访问仍被 source 记为 direct | source/channel 从显式 source/channel 或 utm_source/utm_medium 派生，并保留首次非 direct 来源 |
| P1 | 清单保留已下架/删除产品 | 刷新 API 未返回的产品会从本地清单移除 |
| P1 | sitemap 静态页每次生成都写当前时间 lastmod，且 sitemap 无语言 alternate | 静态页省略虚假 lastmod；产品/项目使用 updated_at；所有 URL 增加中英/x-default alternate |
| P1 | Product JSON-LD 声明未确认的 InStock | 移除 Offer/InStock；保留已确认产品数据与询价页面 URL |
| P2 | JSON-LD 直接 JSON.stringify CMS 文本可闭合 script | 增加 `<` 转义并执行注入用例 |
| P2 | localStorage 写失败会进入运行时错误 | 捕获隐私模式/禁用存储/配额异常，清单仍保留在内存 |
| P2 | 分页禁用链接只靠 pointer-events | 增加 aria-disabled 与 tabIndex=-1 |

## 验证命令与结果

| 命令/检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过，0 warning / 0 error |
| `npm run build` | 退出码 0，41 条路由产物完成；同时记录到 Supabase `fetch EACCES`，所以不能据此宣称真实数据链路通过 |
| `NEXT_PUBLIC_DEMO_MODE=true npm run build` | 通过，41/41 页面生成，无数据请求错误 |
| 询盘/CSV/来源纯逻辑回归 | 12 项通过 |
| 搜索/分类/分页/事件/限流纯逻辑回归 | 7 项通过 |
| 构建产物 SEO 检查 | canonical、hreflang、sitemap alternates、robots、JSON-LD 解析通过 |
| `git diff --check` | 通过，仅有现有 Windows LF/CRLF 提示 |

## 发布前必须人工完成

1. 在目标 Supabase 项目应用 `supabase/migrations/20260715090000_security_hardening_explicit_grants.sql`，再分别以 anon、普通 authenticated、管理员、service_role 验证表权限和 RLS。
2. 当前 Next.js 为 14.2.15。官方安全公告要求 14.x 升级到 14.2.35；本环境因 npm 外网审批/额度限制无法安装。执行：`npm install --save-exact next@14.2.35 eslint-config-next@14.2.35`，然后重新跑三项验证命令。
3. 设置生产 `NEXT_PUBLIC_SITE_URL` 为正式 HTTPS 域名；当前本地构建产物使用 localhost，不能提交搜索引擎。
4. 配置并实测 `INQUIRY_WECOM_WEBHOOK_URL` 和/或 Resend 三个变量，确认成功、失败和超时行为。
5. 使用管理员与普通账号完成后台权限、询盘更新和 CSV 下载；CSV 用 Excel/WPS 打开复核。
6. 在真实微信、iOS Safari、Android Chrome 和桌面浏览器完成 360/390/430/768/1024/1440 视口矩阵，并补拍新的 390×844、1440×1000 截图。
7. 用带明确“回归测试”标记的数据各提交一条中文、英文生产询盘，确认入库、清单快照、来源/UTM、通知、后台和导出全链路后删除测试数据。
