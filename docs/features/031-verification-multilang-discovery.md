# Feature 031: Verification Multi-Language Discovery (M5-04)

Status: `done`  
Type: `P1 verification`

## Goal

把 verification 从 Node/npm 假设扩展为多语言可用，并提供显式配置入口。

## Scope

1. 自动发现新增生态：
- Python: `python -m pytest -q`, `python -m mypy .`, `python -m ruff check .`
- Java: Gradle/Maven（优先 `./gradlew`，其次 `gradle`，再 `mvn`）
- C/C++: `make test|check`、`ctest`
2. 支持仓库显式配置：
- `.merlion/verify.json`（优先）
- `merlion.verify.json`
3. `VerificationCheck` 增加 `requiresCommands`，runner 缺命令时标记 `skipped`

## Runtime Rules

- 若存在自定义 verify 配置，则直接使用配置 checks
- 缺少 `requiresEnv` -> `skipped`
- 缺少 `requiresCommands` -> `skipped`

## Exit Criteria

- 单测覆盖多语言发现
- 单测覆盖自定义配置优先级
- 单测覆盖缺命令跳过
