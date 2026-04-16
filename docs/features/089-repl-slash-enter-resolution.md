Status: `implemented`
Type: `P2 CLI UX`

# 089 REPL Slash Enter Resolution

## Goal

修复 REPL 中 slash preview 只显示不生效的问题。

当前行为：

1. 输入 `/`
2. REPL 会显示 inline preview，例如 `[slash: /wechat]`
3. 但直接按 Enter 时，提交的仍然是原始 `/`
4. 后续被 runtime 当成普通 prompt，而不是 slash command

目标行为：

1. 如果当前 slash 输入能唯一解析到一个命令
2. 那么 Enter 应该提交解析后的 slash command

## Scope

- `src/cli/input_buffer.ts`
- `tests/input_buffer.test.ts`

## Design

新增一个轻量提交解析步骤：

1. 仅在 REPL raw-mode 输入层生效
2. 当 buffer 以 `/` 开头时，查询 slash suggestions
3. 如果当前输入能唯一映射到一个候选：
   - `/`
   - `/we`
   - `/wechat`
   都应在当前单命令场景下提交为 `/wechat`
4. 如果候选不唯一，则保持原始输入不变

这样做的目的不是实现完整 TUI completion，而是先保证：

1. preview 不是“假 UI”
2. Enter 至少能走通唯一候选

## Non-Goals

- 不在这一步实现上下键选择
- 不在这一步实现 Tab 完整补全
- 不改变非 REPL 模式的输入解析
