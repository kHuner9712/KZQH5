# KZQ 产品目录与色卡中心

## 页面

- 中文：`/documents`
- 英文：`/en/documents`
- 后台：`/admin/product-assets`

页面固定展示 21 个核心产品资料主题。主题定义位于 `lib/catalog-topics.ts`，不要在后台或其他组件中复制维护第二份主题数组。

## 数据模型

`product_assets` 在原有资料字段基础上增加：

- `catalog_topic_id`：绑定核心目录主题；可为空，认证或其他通用资料不必绑定。
- `cover_image_url`：目录卡片封面；为空时使用 KZQ 品牌化默认封面。
- `published_at`：资料版本或发布日期，用于新品排序。
- `content_hash`：批量导入文件的 SHA-256，用于去重。

对应 migration：

```text
supabase/migrations/20260719090000_catalog_center_fields.sql
```

该 migration 只新增可空字段和索引，不删除或重写历史数据。

## 前台行为

1. 优先通过 `catalog_topic_id` 精确匹配主题。
2. 旧记录没有主题 ID 时，使用中英文标题和 alias 兼容匹配。
3. 同一主题有多个文件时，优先显示 `published_at` 最新的版本，再按 `sort_order` 排序。
4. 已发布主题卡片直接打开全屏资料预览。
5. 未发布主题进入联系询盘，并携带主题名称和 `source=document-center`。
6. PDF、JPG、PNG、WebP 和可预览图片使用统一 `ProductAssetViewer`。
7. 微信内置浏览器继续显示浏览器打开提示。

## 后台维护

在“采购资料与目录中心”中可以：

- 搜索中英文标题和描述；
- 按目录主题、资料类型和发布状态筛选；
- 上传 PDF 或图片资料；
- 上传目录封面；
- 选择核心 Catalog 主题；
- 设置发布日期、排序和发布状态；
- 编辑、下架或删除数据库记录。

删除资料记录不会自动删除 Supabase Storage 文件，避免误删被其他记录复用的对象。

## Demo 数据

Demo 模式提供 3 份明确标注的本地示例资料：

- KZQ 综合色卡；
- WPC 墙板综合目录；
- 格栅墙板收边方案。

这些文件位于 `public/demo/catalogs/`，只用于构建和 E2E 验证，不代表真实产品或认证资料。

## 部署顺序

1. 在 Supabase SQL Editor 执行 `20260719090000_catalog_center_fields.sql`。
2. 在后台创建一条草稿资料并确认新增字段可保存。
3. 部署 `feature/catalog-center` 合并后的 `main` 到 EdgeOne。
4. 验收 `/documents` 和 `/en/documents`。
5. 使用后台或批量导入工具上传实际资料。
6. 确认内容后再发布，不要默认将导入文件设为公开。

## 回滚

代码回滚不会删除资料或 Storage 文件。若需要停用目录中心，可回滚应用版本；新增数据库字段保持不动即可，不需要执行破坏性回滚。

## 文档查看器

`ProductAssetViewer` 使用 PDF.js（`pdfjs-dist`）在 Canvas 上渲染 PDF，不依赖浏览器原生
iframe 预览，兼容桌面、iPhone Safari、Android Chrome、微信内置浏览器和企业微信。

架构：

- `components/public/product-asset-viewer/ProductAssetViewer.tsx` — 主入口，决定 PDF / 图片 / 不支持
- `PdfViewer.tsx` — PDF.js Canvas 渲染，翻页、缩放、旋转、适应宽度/页面、全屏、滑动翻页
- `ImageViewer.tsx` — JPG/PNG/WebP/SVG 图片预览，缩放、旋转
- `ViewerToolbar` / `ViewerError` / `ViewerLoading` — 工具栏、错误状态、加载状态
- `hooks/usePdfDocument.ts` — 动态加载 PDF.js（不进入首页 JS 包），文档生命周期管理
- `hooks/useViewerKeyboard.ts` — 键盘快捷键（方向键翻页、+/- 缩放、Esc 关闭）
- `hooks/useViewerDownload.ts` — 下载回退链（blob → anchor → 新窗口）
- `lib/client/viewer-utils.ts` — URL 协议校验、文件名清理、微信检测、页码/缩放边界、错误映射

PDF.js worker 位于 `public/lib/pdfjs/pdf.worker.min.mjs`（legacy 构建，兼容旧浏览器）。
PDF.js 主模块仅在打开 PDF 时通过动态 `import()` 加载，不进入首页初始包。

### 统计事件映射

现有数据库 `analytics_event` 枚举暂未包含 PDF 专用事件名（如 `pdf_open`、`pdf_load_success`
等）。在枚举扩展前，查看器交互统一映射到已有的 `catalog_download` 事件：

| 交互 | 映射事件 |
|------|----------|
| 打开 PDF / 图片查看器 | `catalog_download` |
| PDF 加载成功 / 失败 | `catalog_download` |
| 复制链接 | `catalog_download` |
| 新窗口打开 / 下载 | `catalog_download` |

未来扩展枚举后，可在 `trackAnalyticsEvent` 调用处替换为专用事件名。不记录用户查看的 PDF
文本内容。
