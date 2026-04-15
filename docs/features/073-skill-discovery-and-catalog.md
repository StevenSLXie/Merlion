# Feature 073: Skill Discovery And Catalog

Status: `todo`
Type: `P1 Skills`

## Goal

建立 skill discovery 和 skill catalog 层，为后续显式/隐式 skill 激活做准备。

## Planned Scope

- 扫描 project/global skill 目录
- 解析 `SKILL.md` frontmatter
- 生成稳定排序的 skill catalog
- catalog 只包含：
  - `name`
  - `description`
  - `path`
  - `scope`
  - `tokenEstimate`

## Open Decisions

- project/global skill 目录优先级
- 是否兼容 `.agents/skills` / `.claude/skills`
- catalog 注入 prompt 的 token 上限
