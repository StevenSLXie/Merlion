# Feature 031: Verification Multi-Language Discovery (M5-04)

Status: `done`  
Type: `P1 verification`

## Goal

把 verification 从“语言白名单驱动”升级为“配置/CI 优先，语言探测兜底”。

## Scope

1. 优先级：
- `.merlion/verify.json` / `merlion.verify.json`（最高优先）
- CI workflow（`.github/workflows/*`, `.gitlab-ci.yml`）中的 verification 命令
- 语言/生态探测兜底
2. 主流生态探测（兜底）：
- Node: npm/pnpm/yarn/bun scripts
- Python: pytest/mypy/ruff
- Java/Kotlin: Gradle/Maven
- C/C++: make/ctest
- Go: go test / golangci-lint
- Rust: cargo test / cargo clippy
- .NET: dotnet test
- PHP: composer/phpunit
- Ruby: rspec/rake test
- Elixir: mix test
- Swift: swift test
- Dart/Flutter: dart test / flutter test
3. `VerificationCheck` 增加 `requiresCommands`，runner 缺命令时标记 `skipped`
4. CI run 命令只选择 verification 信号命令（过滤 deploy/release/publish）

## Config

- `.merlion/verify.json`（优先）
- `merlion.verify.json`

## Runtime Rules

- 若存在自定义 verify 配置，则直接使用配置 checks
- 若存在 CI checks，则直接使用 CI checks（不再混入语言兜底）
- 缺少 `requiresEnv` -> `skipped`
- 缺少 `requiresCommands` -> `skipped`

## Exit Criteria

- 单测覆盖主流生态发现
- 单测覆盖自定义配置优先级
- 单测覆盖 CI 语言无关发现
- 单测覆盖缺命令跳过
