# Feature 033: Verification Edge-Case Hardening (M5-06)

Status: `done`  
Type: `P1 verification`

## Goal

修复 verification 配置与执行链中的边界行为，避免“看起来可用但语义不一致”。

## Scope

1. `maxOutputChars` 不再强制最小 500，改为“传入正数即生效”
2. 自定义 `verify.json` 的 `checks: []` 语义改为“显式禁用全部 checks”
3. Python checks 支持 `python3`/`python` 任一可用（`requiresAnyCommands`）
4. 自定义 checks 在未显式声明时自动推断 `requiresCommands`

## Runtime Rules

- `requiresCommands`: 全部必须存在
- `requiresAnyCommands`: 至少一个存在即可
- custom verify 文件存在时（即使空数组）不再回退 auto-discovery

## Exit Criteria

- 单测覆盖低值 `maxOutputChars` 生效
- 单测覆盖 `checks: []` 禁用语义
- 单测覆盖 Python 任一命令依赖
- 单测覆盖 custom check 自动推断命令依赖
