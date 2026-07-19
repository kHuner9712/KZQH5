# Catalog 批量导入

## 文件

- 实际导入清单：`data/catalog-assets.json`
- 格式示例：`data/catalog-assets.example.json`
- 21 项来源台账：`data/catalog-source-ledger.json`
- 导入脚本：`scripts/import-catalog-assets.mjs`

## 默认行为

```bash
npm run catalog:import
```

默认是 **dry-run**：

- 校验清单；
- 校验 Topic ID；
- 校验文件存在、MIME 和大小；
- 计算 SHA-256；
- 输出将要执行的操作；
- 不连接 Supabase；
- 不上传文件；
- 不写数据库。

空的 `data/catalog-assets.json` 会安全退出，便于 CI 和日常检查。

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

## 清单格式

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
