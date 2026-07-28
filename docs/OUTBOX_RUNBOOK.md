# Outbox 运行手册

> 本文档描述 Outbox 通知系统的调度、监控、告警和故障处理流程。

## 1. 架构概述

Outbox 是询盘通知的唯一发送路径：

```
询盘提交 → inquiry_outbox 表 → dispatch API → provider (email/wecom)
                                  ↑
                    GitHub Actions cron 调度
```

**关键设计**：
- 询盘提交只写 `inquiry_outbox` 表，不直接发送通知
- `POST /api/internal/outbox/dispatch` 是唯一发送入口
- `FOR UPDATE SKIP LOCKED` 防止并发重复发送
- Stale-claim recovery（默认 300s）自动恢复卡住的 delivery
- `AbortController` 超时（30s）中止进行中的 provider HTTP 请求

## 2. 调度配置

### 2.1 GitHub Actions 自动调度（默认方案）

仓库使用 GitHub Actions cron 作为默认便携调度器：

- **Workflow**: `.github/workflows/outbox-dispatch.yml`
- **频率**: 每 10 分钟
- **并发控制**: `concurrency` group 防止同 ref 并发运行
- **超时**: 5 分钟
- **权限**: `contents: read`（最小权限）

**所需 Secrets**:

| Secret 名称 | 用途 | 最小长度 |
|-------------|------|----------|
| `KZQ_PRODUCTION_BASE_URL` | 生产站点 HTTPS base URL | N/A |
| `OUTBOX_DISPATCH_SECRET` | Bearer token 认证 | 16 字符 |

**延迟边界**:
- GitHub Actions cron 不保证精确执行时间
- 实际延迟可能 5-15 分钟
- 高负载时可能跳过某次运行
- 路由的 stale-claim recovery 确保不丢失 delivery

### 2.2 外部调度器接口契约

如果 GitHub Actions 的延迟不满足业务需求，可接入更高频的外部调度器：

```
POST https://<production-domain>/api/internal/outbox/dispatch
Authorization: Bearer <OUTBOX_DISPATCH_SECRET>
Content-Type: application/json

{"batchSize": 10}
```

**响应**:
- `200`: `{"ok": true, "processed": true, "result": {...}}`
- `504`: 超时（aborted=true），claimed delivery 由 stale recovery 接管
- `503`: dispatcher 未启用（secret 缺失）
- `401/403`: 认证失败

**外部调度器要求**:
- 不重试 504（stale recovery 会自动接管）
- 不并发调用（FOR UPDATE SKIP LOCKED 会安全处理，但浪费资源）
- 不记录响应体（可能含计数器，虽无 PII）
- 超时设置为 60 秒

## 3. 监控和告警

### 3.1 Outbox 状态监控

- **Workflow**: `.github/workflows/outbox-status-monitor.yml`
- **频率**: 每 5 分钟
- **超时**: 3 分钟

**检查项和阈值**:

| 指标 | 阈值 | 状态 |
|------|------|------|
| `oldest_pending_age_seconds` | > 300 秒 | BLOCK（workflow 失败） |
| `oldest_claimed_age_seconds` | > 600 秒 | BLOCK（workflow 失败） |
| `dead_letter_count` | > 0 | BLOCK（workflow 失败） |

阈值可通过 workflow env 覆盖：
- `OUTBOX_PENDING_AGE_THRESHOLD_SECONDS`（默认 300）
- `OUTBOX_CLAIMED_AGE_THRESHOLD_SECONDS`（默认 600）
- `OUTBOX_DEAD_LETTER_THRESHOLD`（默认 0）

### 3.2 告警渠道

Workflow 失败是最低限度的告警渠道。GitHub 会向仓库 watchers 发送通知。

**接入企业微信告警**（可选，不强制引入新依赖）:
1. 在 GitHub Actions 中添加一个 post-failure step
2. 调用企业微信 webhook 发送告警消息
3. 消息内容只包含固定错误码和粗粒度计数，不包含 PII

**接入邮件告警**（可选）:
1. 配置 GitHub Actions failure notification email
2. 或在 post-failure step 中调用 Resend API 发送邮件

## 4. 故障处理

### 4.1 Dispatch 超时 (504)

**现象**: dispatch API 返回 504 `dispatch_timeout`

**处理**:
1. 无需人工干预 — stale-claim recovery 会在 300s 后自动重新 claim
2. 如果频繁超时，检查 provider（Resend/WeCom）响应时间
3. 降低 `batchSize` 减少单次处理量

### 4.2 Dead Letter 累积

**现象**: `dead_letter_count > 0`

**处理**:
1. 检查 `/api/internal/outbox/status` 获取 `oldest_dead_letter_age_seconds`
2. 登录 Supabase 查询 `inquiry_outbox_deliveries` 表中 `status='dead_letter'` 的记录
3. 检查 `last_error_code` 字段确定失败原因
4. 如果是 `NOTIFICATION_NOT_CONFIGURED`，检查 provider 配置
5. 如果是 provider 永久错误，手动处理或重新初始化 delivery

### 4.3 Pending Age 过长

**现象**: `oldest_pending_age_seconds > 300`

**处理**:
1. 检查 dispatch scheduler 是否正常运行
2. 手动触发 `workflow_dispatch` 执行一次 dispatch
3. 检查 GitHub Actions 是否有未完成的运行（concurrency 阻塞）

### 4.4 Claimed Age 过长

**现象**: `oldest_claimed_age_seconds > 600`

**处理**:
1. 表示有 delivery 卡在 `claimed` 状态超过 10 分钟
2. stale-claim recovery 应在 300s 后自动恢复
3. 如果超过 600s 仍未恢复，检查 stale_timeout_seconds 配置
4. 可能需要手动重置 delivery 状态

## 5. 安全注意事项

- `OUTBOX_DISPATCH_SECRET` 必须通过部署平台 Secret 配置，绝不能写入代码或 `.env` 文件
- Secret 至少 16 字符，生产环境推荐 32+ 字符
- 日志只记录粗粒度计数（initialized/claimed/sent/failed/deadLettered），不记录 inquiry PII
- 响应体不包含 inquiry ID、联系人信息、provider 响应正文
- `/api/internal/**` 路由应通过 EdgeOne WAF IP 白名单限制公网访问
