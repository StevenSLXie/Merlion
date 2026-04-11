# Feature 014: Token Observability + Cost Tracking (Phase 1)

Status: `done`  
Type: `P0 cost control`

## Goal

围绕“质量不降前提下省成本”，先把 token 和成本变成可观测、可归档、可回归比较的数据面。

## Scope

1. 主程序每轮记录并累计：`prompt_tokens`, `completion_tokens`, `cached_tokens(optional)`
2. CLI 每轮实时显示增量与累计 token（后续可接估算成本）
3. E2E 每次运行自动产出 usage 档案（json），方便追踪回归

## Benchmark References (local code study)

- `free-code-main/src/cost-tracker.ts`: 会话级 token/cost 累计与格式化输出
- `free-code-main/src/query/tokenBudget.ts`: token budget 决策器
- `openclaw/src/tui/tui.ts`: footer 状态聚合（模型/会话/token）
- `openclaw/src/tui/tui-formatters.ts`: token 显示格式

## Design

1. 新增 `usage` 聚合器模块：
   - 输入每轮 usage
   - 输出本轮增量与会话累计
   - 提供统一格式化函数
2. `runLoop` 保持 `onUsage` 回调，扩展到 `cached_tokens?`
3. CLI:
   - one-shot / repl 共用 usage 聚合器
   - 每次模型响应后打印 `[usage] turn +in/+out/+cached | total ...`
4. E2E:
   - `tests/e2e/helpers.ts` 中收集 usage
   - 测试结束写 `.merlion/e2e-usage/*.json`

## Test Plan (TDD)

- 单测：usage 聚合器累计、重置、格式化
- 回归：`runtime_loop.test.ts` 验证 `onUsage` 收到扩展字段
- E2E helper 测试：usage 归档文件结构正确（无 key 场景可用 stub）

## Exit Criteria

- `npm run test:all` 通过
- CLI 可实时看到 token 增量/累计
- `npm run test:e2e` 执行时，产生 e2e usage 档案
