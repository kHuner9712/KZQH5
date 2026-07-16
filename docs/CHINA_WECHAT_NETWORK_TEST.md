# 中国大陆与微信真机网络测试

状态：未执行。此表只记录真实设备、真实运营商和真实部署 URL 的结果；Ping 不能替代页面、数据、Storage 与 API 验证。

## 测试 URL

- 微信菜单：`?source=wechat-menu&utm_source=wechat&utm_medium=official-account`
- 微信二维码：`?source=wechat-qr&utm_source=wechat&utm_medium=qr`
- 直接访问：`?source=direct`

每个入口至少覆盖首页、产品列表、一个产品详情、证书、资料、询盘。写入前使用 `[REGRESSION TEST]` 姓名/留言并取得清理授权。

## 可填写矩阵

| 环境 | 入口 URL | 打开/首屏 | 图片 | 搜索 | 详情 | 证书 | 资料预览 | 询盘/耗时 | 白屏/长期 Loading/错误 | HTML 有但数据/图失败 | 证据/时间/测试人 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 微信内置浏览器 + 中国移动 |  | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |  |
| 微信内置浏览器 + 中国联通 |  | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |  |
| 微信内置浏览器 + 中国电信 |  | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |  |
| 微信内置浏览器 + 家庭宽带 |  | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |  |
| iOS Safari |  | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |  |
| Android Chrome |  | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |  |
| 国内 PC 浏览器 |  | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |  |
| 美国或欧洲网络 |  | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 | 未测 |  |

## 故障归因

| 现象 | 优先证据 | 可能边界 |
| --- | --- | --- |
| DNS/HTTPS 失败，HTML 都没有 | DNS 解析、证书链、EdgeOne 自定义域名状态 | DNS / HTTPS / 备案或加速区配置 |
| HTML 快、Server Component 内容慢或 5xx | `/api/health`、EdgeOne Function 日志、诊断 products/search 耗时 | EdgeOne Node Function 或 Supabase 数据读取 |
| 页面有内容但 Supabase 图片失败 | 浏览器 Network 中 Storage URL、诊断 storage、同 URL 外网对比 | Supabase Storage 国内链路 |
| 页面正常但询盘失败 | `/api/inquiries` 状态/耗时、EdgeOne Function 日志、数据库记录 | API Route、Supabase 写入、超时或限流 |
| 只在微信失败 | 同设备 Safari/Chrome 对比、UA、JS-SDK 返回、微信安全域名 | 微信环境、域名拦截或 JS-SDK |
| 所有网络 EdgeOne 错误页 | 部署日志、`check:deployed`、对应 request id | Next.js runtime/函数部署 |

每个失败至少保存：设备/系统/浏览器版本、运营商、时间、URL、录屏或截图、Network 状态、`/api/health` 响应和诊断耗时。不得记录密钥、客户表单或完整内部错误。
# 2026-07-16 Staging preparation note

Automated requests from the current non-China execution environment to the clean
Staging URL received EdgeOne's platform 401 page. This is preview-access evidence,
not carrier performance evidence, and no tokenized preview URL was recorded.

No row in the carrier/device matrix is changed to passed. WeChat embedded
browser, China Mobile, China Unicom, China Telecom, home broadband, iOS Safari,
Android browser, and an overseas comparison still require real devices and
networks. Use only `[REGRESSION TEST]` inquiry data and `regression-test-` files
when those tests are authorized.

# 2026-07-16 stable-domain note

The stable Staging host is reachable from the current non-China automated
execution environment over valid HTTPS and no longer presents EdgeOne preview
authentication. This is **Automated pass** for the overseas automation point
only; it is not evidence for any mainland carrier, WeChat, iOS, Android, or
home-broadband row.

The current deployment is **Blocked** for real-device testing because its SEO
URLs still use the previous project domain and plain HTTP does not redirect to
HTTPS. No test inquiry was submitted, no test file was uploaded, and no matrix
row is promoted to pass.

Still required after redeployment:

- WeChat embedded browser on China Mobile, China Unicom and China Telecom;
- WeChat embedded browser on mainland home broadband;
- iOS Safari and Android browser;
- mainland desktop comparison;
- a separate overseas-network comparison;
- page, data, Storage, search, inquiry and timing evidence for each path.
