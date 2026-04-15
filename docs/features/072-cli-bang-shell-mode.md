# Feature 072: REPL Bang Shell Mode

Status: `in_progress`
Type: `P1 CLI/UX`

## Goal

在 REPL 中支持 `! ` shell escape：

- 用户输入 `! ` 后面的内容直接作为 shell command 执行
- 不经过大模型
- 复用现有 `bash` tool 的权限和风控

## UX

- `! echo ok`
  - 直接执行 shell
  - 输出结果直接回显
- `!`
  - 不视为 shell mode
- `!rm -rf /`
  - 仍按现有 `bash` 风控阻止

## Design

- 解析规则：
  - 只有 `! ` 加至少一个非空命令才视为 shell mode
- 执行规则：
  - REPL 直接走本地 shell 快捷路径
  - 复用 `bashTool.execute(...)`

## Scope

- In:
  - REPL only
  - 输出直接渲染到 CLI
- Out:
  - one-shot 模式不支持
  - 不做 notebook history / cell abstraction

## Acceptance Criteria

1. `! ` 能在 REPL 直接执行 shell command。
2. 不经过 agent loop。
3. 复用现有 permission/risk guard。

## Verification

- `node --experimental-strip-types --test tests/repl.test.ts`
