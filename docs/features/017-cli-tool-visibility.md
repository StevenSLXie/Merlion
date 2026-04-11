# Feature 017: CLI Tool Visibility Hooks

Status: `done`  
Type: `P1 ux`

## Goal

让 CLI 在执行中可见“正在做什么”，避免用户只看到最终答案。

## Scope

1. `runLoop` 暴露 turn/assistant/tool 事件 hooks
2. `executor` 在每个 tool call 前后触发事件（含耗时）
3. CLI 输出事件日志：
   - `turn start`
   - `assistant requested N tools`
   - `tool start`
   - `tool done (ok/error, duration)`

## API sketch

- `RunLoopOptions.onTurnStart`
- `RunLoopOptions.onAssistantResponse`
- `RunLoopOptions.onToolCallStart`
- `RunLoopOptions.onToolCallResult`

## Test Plan (TDD)

- `tests/executor.test.ts`: 验证 tool start/result hooks 被触发
- `tests/runtime_loop.test.ts`: 验证 runLoop 将 hooks 透传到 executor 分支
- `tests/cli_render.test.ts`: 验证渲染文案基础格式

## Exit Criteria

- CLI 在工具执行过程有可见反馈
- 所有测试通过，且不影响已有行为
