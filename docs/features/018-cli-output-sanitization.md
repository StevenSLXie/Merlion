# Feature 018: CLI Output Sanitization

Status: `done`  
Type: `P1 ux`

## Goal

终端输出默认可读、可复制，避免被 ANSI 噪声和超长 token 破坏。

## Scope

1. 清理 ANSI 转义序列
2. 移除不可见控制字符（保留 `\n`, `\r`, `\t`）
3. 对超长、非路径类 token 做分段显示（不改路径/URL）
4. 在 CLI 最终输出与关键状态文案上启用

## Benchmarks (local)

- `openclaw/src/tui/tui-formatters.ts` 的 `sanitizeRenderableText`
- `openclaw/src/terminal/table.ts` 的超长 token 处理思路

## Test Plan

- `tests/cli_sanitize.test.ts`:
  - ANSI 清理
  - 控制字符清理
  - 长 token 断行
  - 路径/URL 不拆分

## Exit Criteria

- 默认 CLI 输出没有 ANSI 污染
- 极长 token 不会撑爆单行显示
