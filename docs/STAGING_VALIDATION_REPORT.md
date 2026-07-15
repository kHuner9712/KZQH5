# EdgeOne Staging 验证报告

日期：2026-07-15。分支：`codex/edgeone-staging-validation`。基线：`51a3073167ed722f53d2aab9158ce14cf43c6a71`。

## 已实际执行

| 命令 | 结果 | 证据摘要 |
| --- | --- | --- |
| `npm ci` | 通过，exit 0 | 按 lockfile 安装 521 packages；npm 报告 1 moderate / 4 high 的现有审计项，未运行破坏性 `audit fix --force` |
| `npm run check` | 通过，exit 0 | typecheck、lint、73 unit tests、Demo production build 全部通过；41 个静态页面生成完成 |
| `npm run test:e2e:demo` | 通过，exit 0 | 6 passed、2 个按 viewport/project 设计 skip；覆盖 390×844 与 1440×1000 截图以及 360/430/768/1024 响应式矩阵 |
| `npm run test:database` | 通过，exit 0 | 临时 PostgreSQL 16 容器；fresh install、incremental upgrade、RLS permission matrix、旧数据哨兵、原子写入/回滚通过；容器已停止并自动删除 |
| `node --check scripts/*.mjs` | 通过 | 所有 `.mjs` 语法检查通过 |
| 当前文件与 Git 历史 secret 模式扫描 | 通过 | 未发现 Supabase service role、EdgeOne token、CloudBase secret、私钥或管理员密码候选；仅 `.env.example` / `.env.demo.example` 被 Git 跟踪 |

第一次受限环境中的 `npm ci` 因 npm 无法写本机 cache 而报 npm 自身错误；在允许访问 cache 后对同一 lockfile 重跑成功，最终结果以上表 exit 0 为准。Demo build 的 webpack cache snapshot 警告不影响构建 exit 0。

## 未执行 / 被阻塞

| 项目 | 状态 | 阻塞原因 |
| --- | --- | --- |
| EdgeOne Makers Demo/全栈部署 | 被阻塞 | 无 EdgeOne 登录/项目权限和部署 URL |
| `npm run test:smoke` 对真实 Staging | 被阻塞 | 无已确认的独立 Supabase Staging URL/anon key |
| 写入 Smoke | 被阻塞 | 无 Staging service role 与写入授权 |
| `BASE_URL=... npm run check:deployed` | 被阻塞 | 无 EdgeOne Staging URL |
| `PLAYWRIGHT_BASE_URL=... npm run test:e2e:staging` | 被阻塞 | 无 EdgeOne Staging URL |
| 真实 Storage、管理员、CSV | 被阻塞 | 无 Staging Storage 资源与真实测试管理员账号 |
| WeCom / Resend / 微信 JS-SDK | 被阻塞 | 无 Staging 第三方凭据、公众号安全域名与测试账号 |
| GitHub `staging` Environment | 被阻塞 | 无仓库 Environment/Secrets 管理权限 |
| 中国移动/联通/电信/家庭宽带与微信真机 | 被阻塞 | 无部署 URL 和当地真机测试人员 |

本报告没有用 Demo 结果替代真实 Staging，也没有将任何被阻塞项目标为通过。

## 新增环境变量

- 部署可选：`STAGING_DIAGNOSTICS_ENABLED`、`STAGING_DIAGNOSTICS_TOKEN`。
- 本机初始化：`DATABASE_STAGING_URL`、`KZQ_STAGING_PROJECT_REF`、`KZQ_STAGING_CONFIRMATION`。
- 明确写入开关：`SMOKE_TEST_ALLOW_WRITES`、`STAGING_E2E_ALLOW_WRITES`。
- 部署探测：`BASE_URL`、可选 `EXPECT_DEMO_MODE`。
- Staging E2E：`PLAYWRIGHT_BASE_URL`。

## 安全与回滚

- 健康接口不访问数据库、不输出 URL/key/user/stack，响应 `Cache-Control: no-store`。
- 诊断未启用时 404；启用后要求 Bearer token，只读且只返回成功状态/耗时。
- 远程初始化要求确认串、项目 ref 匹配和空 `public` schema；不提供 reset/drop/delete-all。
- 写入测试只清理由本次创建的明确 UUID 与 `[REGRESSION TEST]` 标记。
- 默认 Smoke 中的 anon 写权限拒绝性断言使用 PostgREST `tx=rollback`，即使策略异常也请求事务回滚。
- 代码回滚：回退本 PR/部署到 EdgeOne 上一个 deployment；关闭两个诊断变量即可让诊断恢复 404。
- 本阶段没有修改任何远程数据库、Storage、DNS 或正式域名，因此不存在远程数据回滚操作。以后若执行 migration，按数据库 Runbook 的备份与停止点处理，不运行 seed 回滚已有库。
