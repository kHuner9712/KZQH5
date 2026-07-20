# Catalog 批量导入

## 文件

- 实际导入清单：`data/catalog-assets.json`
- 格式示例：`data/catalog-assets.example.json`
- 21 项来源台账：`data/catalog-source-ledger.json`
- 下载脚本：`scripts/download-catalog-assets.mjs`
- 导入脚本：`scripts/import-catalog-assets.mjs`

## 下载公开资料

```bash
npm run catalog:download          # dry-run，仅探测清单中的公开 URL
npm run catalog:download:apply    # 真实下载、核验并渲染首页封面
```

下载脚本只采集公开可直链的资料，遇到登录墙、密码保护或平台只读
（如 Scribd）会跳过并记录原因，不会尝试绕过访问控制。脚本默认
dry-run，必须显式 `--apply` 才会写入文件。已下载并通过校验的文件会
被跳过（续传），相同 SHA-256 的文件会被去重。

下载产物：

- `data/catalog-source-files/pdfs/` 下载的 PDF
- `data/catalog-source-files/covers/` 官方封面图
- `data/catalog-source-files/rendered/` 每份 PDF 首页渲染的 JPEG 封面
- `data/catalog-assets.json` 已核验资料清单 + 统计 + 失败原因

## 清单格式

`data/catalog-assets.json` 由下载脚本写入，采用对象格式：

```json
{
  "generated_at": "2026-07-20",
  "tool": "scripts/download-catalog-assets.mjs",
  "mode": "apply",
  "pdfs": [
    {
      "url": "https://baijiaxiang.spb.ru/f/montazhnye_profili_385866.pdf",
      "title": "BAIJAX Aluminum Mounting Profiles",
      "topic_ids": ["aluminum-alloy-profile", "edge-finishing"],
      "primary_catalog_topic_id": "aluminum-alloy-profile",
      "source_origin": "russia_official_representative",
      "access": "public_direct_pdf",
      "local_file": "data/catalog-source-files/pdfs/montazhnye_profili_385866.pdf",
      "sha256": "...",
      "size_bytes": 2162919,
      "mime_type": "application/pdf",
      "http_status": 200,
      "page_count": 12,
      "pdf_valid": true,
      "rendered_cover": "data/catalog-source-files/rendered/montazhnye_profili_385866-page1.jpg",
      "rendered_cover_sha256": "...",
      "downloaded_at": "2026-07-20"
    }
  ],
  "covers": [ { "...": "官方封面图记录" } ],
  "excluded": [ { "reason": "platform_read_only_scribd" } ],
  "failures": [ { "url": "...", "reason": "HTTP 404" } ],
  "stats": { "pdfs_success": 16, "pdfs_failed": 2, "covers_success": 21 }
}
```

导入脚本同时兼容旧的数组格式和上述对象格式：当读取到对象时，会从
`pdfs` 中筛选 `pdf_valid` 为真、主题 ID 合法且不超过 20 MB 上传上限的
条目，映射为导入行；超过 20 MB 的文件仍记录在清单中供参考，但不会
被上传到 Supabase Storage。

空的 `data/catalog-assets.json`（`[]` 或 `{"pdfs":[]}`）会安全退出，
便于 CI 和日常检查。

## 导入默认行为

```bash
npm run catalog:import
```

默认是 **dry-run**：校验清单与 Topic ID、校验文件存在/MIME/大小、计算
SHA-256、输出将要执行的操作，不连接 Supabase、不上传文件、不写数据库。

## 应用导入

先配置仅服务端使用的环境变量：

```bash
NEXT_PUBLIC_SUPABASE_URL=https://project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

然后执行：

```bash
npm run catalog:import:apply
```

只有显式 `--apply` 才会写入。默认不会更新相同哈希的记录；需要更新时显式执行：

```bash
node scripts/import-catalog-assets.mjs --apply --update-existing
```

也可以指定其他清单：

```bash
node scripts/import-catalog-assets.mjs --manifest ./data/my-catalog-assets.json
```

## 导入行格式（数组清单兼容）

当手工维护一份数组清单（或使用 `--manifest` 指定）时，每行格式如下：

```json
[
  {
    "catalog_topic_id": "wpc-wall-panel",
    "title_cn": "WPC 墙板综合目录",
    "title_en": "WPC Wall Panel Catalog",
    "description_cn": "",
    "description_en": "",
    "asset_type": "catalog",
    "source_file": "./catalog-source/wpc-wall-panel.pdf",
    "cover_file": "./catalog-source/wpc-wall-panel-cover.jpg",
    "published_at": "2026-07-01",
    "sort_order": 10,
    "is_published": false
  }
]
```

支持的资料文件：PDF、JPG、PNG、WebP。封面只允许 JPG、PNG、WebP。单个文件最大 20MB。

## Storage 路径

脚本使用 SHA-256 生成稳定路径：

```text
documents/catalogs/{catalog_topic_id}/{sha256}.{ext}
document-covers/{catalog_topic_id}/{sha256}.{ext}
```

文件上传到现有 `public-assets` bucket。脚本不会清空 bucket，不会删除旧文件，也不会覆盖其他对象。

## 去重

- 文件 SHA-256 保存到 `product_assets.content_hash`。
- 数据库已有相同哈希时默认跳过。
- `--update-existing` 只更新命中的资料记录，不删除其他记录。
- 日志不会输出 service role key 或 Authorization Header。

## 发布安全

建议导入清单默认设置：

```json
"is_published": false
```

导入后在后台逐项检查：

- 文件内容；
- KZQ 品牌信息；
- 产品参数；
- 封面；
- 中英文标题；
- 资料来源；
- 是否允许公开。

确认后再发布。

## 来源台账状态

`data/catalog-source-ledger.json` 支持：

- `ready`
- `public-source-found`
- `customer-required`
- `rebuild-required`

没有可核验文件时保持未发布，不创建虚假 PDF。认证资料必须与 KZQ 或其实际供应链产品对应。
