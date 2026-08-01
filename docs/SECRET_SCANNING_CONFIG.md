# Secret Scanning 配置与验收（KZQ-P2-012-b）

> 供应链安全 workstream 子任务 b。本文档如实说明 GitHub Secret Scanning /
> Push Protection 的启用边界：**该能力由 GitHub 平台设置（UI/API）控制，
> 仓库内没有标准配置文件**（不像 `dependabot.yml` / `CODEOWNERS`）。因此
> 本任务在仓库内的可交付物是：启用步骤文档 + 发布验收项 + 治理契约测试；
> **不得在仓库中伪造 `secret-scanning.yml` 等不存在的配置文件来假装已启用**。

## 1. 现状审计（真实事实）

- GitHub Secret Scanning 与 Push Protection 的开关位于仓库
  `Settings → Code security and analysis`（以及组织级
  `Organization settings → Code security` 策略），**不是**仓库文件。
- 仓库现有 `.github/dependabot.yml`（npm + github-actions，每周）已启用；
  CodeQL 分析已由 `docs/../.github/workflows/codeql.yml`（KZQ-P2-012-a）覆盖。
- Secret Scanning 启用状态**无法**由应用代码自动验证（需要带
  `repo` scope 的 GitHub Token 查询 REST API；CI 不持有该 Token），
  因此按"平台人工配置"处理，与 KZQ-P1-011-c（EdgeOne WAF 证据门控）
  同一模式：提供人工验收步骤，不虚假标记已部署。

## 2. 人工启用步骤（GitHub UI）

1. 打开仓库 `Settings → Code security and analysis`。
2. 确认 **Secret scanning** 为 **Enabled**（公开仓库默认启用；如需自定义
   扫描模式/排除规则，展开 `Custom patterns` 按需添加）。
3. 确认 **Push protection** 为 **Enabled**——推送时若提交包含已识别的
   密钥格式（Supabase service role、npm token、GitHub PAT 等），GitHub
   会直接阻止推送并提示处理方式。
4. （可选，推荐）组织级：`Organization settings → Code security` 中
   将 Push Protection 设为 **Enabled by default**，使新仓库自动继承。
5. （可选）若希望把扫描模式扩展为自定义密钥类型，在 `Custom patterns`
   中按项目密钥格式（如 `KZQ_STAGING_CONFIRMATION=KZQ-STAGING-ONLY` 等
   标记型变量）添加 pattern——注意 pattern 越宽越易误报，需测试。

## 3. 验收方法（人工）

- **Push Protection**：在本地新建分支，提交一个含测试密钥的文件
  （例如 `supabase_service_role_key = "sb_publishable_secret_test_123"`），
  `git push` 应被 GitHub 拒绝并给出"secret detected"提示；随后按提示
  移除该密钥再推送成功。
- **Secret Scanning 警报**：`Security → Secret scanning` 页面应显示
  扫描历史；对仓库历史提交中的已泄露密钥（如历史 `Import .env` 文件）
  应能定位到对应 alert。
- **正则确认**：`Security → Secret scanning` 无"未启用"提示。
- 全部通过后，在 `docs/LAUNCH_CHECKLIST.md` 第 10 节勾选对应项。

## 4. 失败 / 未启用时的处置

- 若 Push Protection 未启用：不能依赖历史保护；发布前在 Ledger 中
  记录为阻塞项，并提醒提交者避免 `git add .`（防止误提交密钥）。
- 若发现历史提交已含真实密钥：按 GitHub 提示**轮换该密钥**（而不是仅
  删除提交历史），并在 `docs/CODE_FINALIZATION_REPORT.md` 记录轮换时间。

## 5. 关联任务

- `docs/TRAE_UPGRADE_LEDGER.md` → KZQ-P2-012（workstream）子任务 b。
- 前置：KZQ-P2-012-a（CodeQL workflow）。
- 后续：KZQ-P2-012-c（SBOM）、d（license audit）。
