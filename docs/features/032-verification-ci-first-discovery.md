# Feature 032: Verification CI-First Discovery (M5-05)

Status: `done`  
Type: `P1 verification`

## Goal

避免把 verification 绑定到语言名单，优先采用仓库已有的“项目定义验证命令”。

## Scope

1. 优先级：`custom config > CI workflows > ecosystem fallback`
2. 解析 `.github/workflows/*.yml|yaml` 的 `run` 命令
3. 解析 `.gitlab-ci.yml` 的 `script` 命令
4. 仅保留 verification 信号命令（test/lint/typecheck/check 等）

## Runtime Rules

- 发现 CI checks 后，直接使用 CI checks，不再混入语言兜底探测结果
- 通过 `requiresCommands` 自动生成命令依赖并由 runner 执行前检查

## Exit Criteria

- 单测覆盖 CI one-line `run`
- 单测覆盖 CI block `run: |`
- 单测覆盖 CI 优先于语言探测
