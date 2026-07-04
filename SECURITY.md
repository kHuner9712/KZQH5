# 安全策略

本文件说明 KZQ 系统中**可以存放**与**禁止存放**的数据范围，以及 Supabase 权限配置注意事项。

## 1. 系统定位

KZQ 是**对外展示型**系统，类似品牌官网 + 海外询盘站。系统不承担 ERP、报价系统、客户管理系统的职责。

## 2. 允许存入系统的数据

| 数据类型 | 存放位置 | 说明 |
|---------|---------|------|
| 公司介绍、品牌介绍 | `company_profile` | 中英文双语 |
| 一级 / 二级类目 | `categories` / `subcategories` | 仅展示信息 |
| 产品名称、描述、规格 | `products` | 中英文双语 |
| 产品图片、视频 URL | `product_images` / `products.video_url` | 视频为外链 |
| **公开展示价格** | `products.price_display_cn/en` | 仅展示用，如 "请联系销售获取报价" |
| 资质证书（展示版/水印版） | `certificates.image_url` | 仅展示版 |
| 联系方式 | `company_profile` | 电话、邮箱、WhatsApp、地址、微信二维码 |
| 询盘表单提交内容 | `inquiries` | 客户主动提交的询价信息 |
| 管理员账号 | `auth.users` + `admin_profiles` | Supabase Auth |

## 3. 禁止存入系统的数据

以下数据**严禁**写入本系统，请使用内部 ERP 或独立安全存储：

- ❌ 成本价、底价、最低成交价
- ❌ 客户名单、客户分级、客户跟进记录
- ❌ 供应商信息、采购价
- ❌ 合同、订单、内部报价单
- ❌ 未公开产品、研发中的产品
- ❌ 生产配方、工艺参数机密
- ❌ **完整高清证书源文件**（系统只允许上传展示版/水印版）
- ❌ 内部物流成本、运费明细
- ❌ 销售提成规则、内部业绩数据
- ❌ 员工薪资、内部人事数据

## 4. Supabase 权限注意事项

### 4.1 Key 的使用规则

| Key | 用途 | 暴露范围 | RLS |
|-----|------|---------|-----|
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 前台匿名访问 | 客户端 + 服务端 | 受 RLS 约束 |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端特权操作 | **仅服务端** | 绕过 RLS |

⚠️ **`SUPABASE_SERVICE_ROLE_KEY` 绝对不能：**
- 写入 `NEXT_PUBLIC_` 前缀的环境变量
- 出现在客户端组件代码中
- 提交到 Git 仓库
- 写入 `next.config.mjs` 等公开配置

### 4.2 RLS 策略要点

- 所有表均开启 Row Level Security
- 前台匿名用户：
  - 可读 `categories` / `subcategories` 中 `is_active = true` 的数据
  - 可读 `products` 中 `is_published = true` 的数据
  - 可读 `product_images` 中所属产品 `is_published = true` 的图片
  - 可读 `certificates` 中 `is_published = true` 的数据
  - 可读 `company_profile` / `site_settings`
  - **不能直接写入任何表**（`inquiries` 也必须通过 `/api/inquiries` 路由提交，由服务端 `service_role` 写入）
- 管理员（`admin_profiles` 中存在的用户）：可对所有业务表 CRUD
- `admin_profiles` 表**完全不开放** RLS 读写，仅通过 `service_role` 在服务端读取校验
- `inquiries` 表**不开放 anon 直接 insert**：询盘提交必须通过 `/api/inquiries` 路由（服务端 `service_role` 写入），Supabase anon key 不能绕过 API 直接写询盘

### 4.3 Storage Bucket 权限

| Bucket | 公开读 | 公开写 | 管理员写 | 用途 |
|--------|-------|-------|---------|------|
| `public-assets` | ✅ | ❌ | ✅ | 产品图、Logo、微信二维码、展示版证书 |
| `private-assets` | ❌ | ❌ | ✅ | 预留（暂未使用） |

### 4.4 询盘写入流程

前台询盘表单**不直接用 anon key 写 `inquiries` 表**。`inquiries` 表不开放 anon insert policy，Supabase anon key 不能绕过 `/api/inquiries` 直接写询盘。流程：

1. 前台表单提交到 `/api/inquiries` 路由
2. 路由使用 `service_role` 在服务端写入 `inquiries`（绕过 RLS）
3. 服务端做多层防滥用检测（见 4.5）
4. 写入成功后返回成功响应

> ⚠️ `supabase/policies.sql` 中已删除 `inquiries_public_insert` policy，重新执行 `policies.sql` 后 anon 将无法直接 insert。

### 4.5 询盘接口防滥用机制

`/api/inquiries` 路由实现了以下多层防滥用保护：

| 层级 | 机制 | 说明 |
|------|------|------|
| 1 | 服务端 honeypot 检测 | 接收 `honeypot` / `company_website` 字段；若有值则返回 `success: true` 但不写入数据库，不暴露"触发反垃圾"提示 |
| 2 | 内存级限流 | 按 IP + User-Agent 做简单内存限流，10 分钟内最多 5 次，超限返回 429 |
| 3 | 字段校验 | name 必填、email 格式校验、email/whatsapp 至少一个、字段长度限制 |
| 4 | message 垃圾内容判断 | message 中 URL 数量 ≥ 3 时拒绝；message 超长截断至 2000 字符 |
| 5 | Demo 模式 | Demo 模式下不写入 Supabase，直接返回成功（用于前端 Mock Preview） |

> ⚠️ Vercel serverless 环境中内存级限流不是强一致（不同实例间不共享状态），仅作为第一层保护。如需更强限流，建议在 Vercel 层面配置 Rate Limiting 或使用 Upstash Redis 等外部存储。

### 4.6 管理员登录流程

1. 用户在 `/admin/login` 输入邮箱密码
2. 调用 Supabase Auth `signInWithPassword`
3. 服务端校验 `auth.users` 中是否存在该用户
4. 服务端用 `service_role` 读取 `admin_profiles` 校验该用户是否为管理员
5. 通过则允许进入后台；否则跳转回登录页并提示无权限

## 5. 证书安全

- 系统只上传证书**展示版/水印版**图片
- 禁止上传完整高清证书源文件
- 上传组件有 5MB 大小限制
- 建议在上传前用图片编辑工具添加 "展示版" 水印

## 6. 密钥轮换

如怀疑 `SUPABASE_SERVICE_ROLE_KEY` 泄露：

1. 立即在 Supabase Dashboard → Settings → API 中重置 service_role key
2. 更新所有部署环境（Vercel / Cloudflare Pages）的环境变量
3. 重新部署应用
4. 检查 `inquiries` 表是否有异常数据

## 7. 数据备份

- Supabase 自动每日备份（免费版保留 7 天）
- 重要数据建议定期导出 SQL 备份
- 询盘数据建议每周导出存档到内部安全存储
