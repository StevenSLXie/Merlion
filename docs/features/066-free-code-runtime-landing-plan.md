# Feature 066: Free-code Runtime Landing Plan

Status: `todo`  
Type: `P1 Architecture`

## Goal

参考 `https://github.com/paoloanzn/free-code/tree/main/src` 的组织方式，给 Merlion 制定一套可分步落地的 runtime 重构方案，在不打断现有功能（尤其 WeChat 模式）的前提下，降低入口耦合和执行链路漂移。

## Scope

- In:
  - 入口拆分（bootstrap / mode-router / runtime-runner）。
  - 工具池装配层（catalog + permission/mode filter + stable ordering）。
  - 最小 Task 抽象（覆盖本项目当前真实场景）。
  - CLI/WeChat 统一事件流与输出适配。
  - 回归测试与 E2E 验收门槛。
- Out:
  - 不一次性复制 free-code 全量能力（如 swarms、复杂插件生态、remote 控制面）。
  - 不改变既有用户命令语义（`merlion ...`, `--repl`, `wechat --login`）。

## Current Pain Points

1. `src/index.ts` 过重（当前约 900+ 行），同时承担参数解析、配置、模式分发、runtime 事件绑定、artifact 自动维护。  
2. 工具注册为静态全量注册，缺少“按权限/模式组装工具池”的中间层。  
3. 缺少 Task 层抽象，长流程（WeChat 消息、verify rounds）只能通过 callback 拼接。  
4. CLI 与 WeChat 在 turn/tool 事件处理上存在重复逻辑，扩展点分散。  

## Reference Mapping (free-code -> Merlion)

- `free-code/src/tools.ts` -> Merlion `tools catalog + tool pool assembler`
  - 核心借鉴：统一工具源、按模式过滤、按 deny 规则预过滤、稳定排序。
- `free-code/src/tasks.ts` + `src/Task.ts` -> Merlion `runtime/tasks/*`
  - 核心借鉴：task 类型注册、按 type 分发、统一生命周期状态。
- `free-code/src/Tool.ts` -> Merlion `tools/types.ts` 增强
  - 核心借鉴：补足 tool execution context / progress message 类型边界。
- `free-code/src/main.tsx` -> Merlion `index.ts` 拆层
  - 核心借鉴：入口只做初始化与编排，不承载全部业务分支细节。

## Plan

### PR-1: Index Decomposition (No behavior change)

- 新增：
  - `src/bootstrap/cli_args.ts`
  - `src/bootstrap/config_resolver.ts`
  - `src/bootstrap/mode_router.ts`
  - `src/runtime/turn_runner.ts`
- 目标：
  - `src/index.ts` 降至 `< 250` 行，仅保留 main + wiring。
  - 现有命令与输出行为不变。

### PR-2: Tool Pool Assembly

- 新增：
  - `src/tools/catalog.ts`（全部 builtin tool 定义清单）
  - `src/tools/pool.ts`（mode + permission + env 过滤与排序）
- 调整：
  - `src/tools/builtin/index.ts` 从“直接注册”改为“消费 pool 结果”。
- 目标：
  - 支持在模型看到工具前先过滤（减少无效工具曝光与 token 噪音）。
  - 保证工具顺序稳定，提升 prompt cache 命中稳定性。

### PR-3: Minimal Task Runtime

- 新增：
  - `src/runtime/tasks/types.ts`
  - `src/runtime/tasks/registry.ts`
  - `src/runtime/tasks/handlers/local_turn.ts`
  - `src/runtime/tasks/handlers/wechat_message.ts`
  - `src/runtime/tasks/handlers/verify_round.ts`
- 目标：
  - 定义统一 task 状态：`pending | running | completed | failed | cancelled`。
  - 统一超时、重试、终止逻辑，减少 callback 拼装。

### PR-4: Unified Runtime Events

- 新增：
  - `src/runtime/events.ts`（typed events）
  - `src/runtime/sinks/cli_sink.ts`
  - `src/runtime/sinks/wechat_sink.ts`
- 事件建议：
  - `turn_start`
  - `assistant_response`
  - `tool_start`
  - `tool_result`
  - `turn_complete`
  - `run_terminal`
  - `run_error`
- 目标：
  - CLI 与 WeChat 共享 runtime 事件源，各自只处理显示/推送策略。

### PR-5: Regression + E2E Hardening

- 新增测试重点：
  - tool pool 过滤和排序稳定性。
  - task 生命周期（超时/取消/重试）与 terminal 状态一致性。
  - WeChat 默认“仅最终结果推送”行为不回退。
  - `errcode=-2` 与 `getupdates 524` 场景防风暴与可恢复性。
- 通过门槛：
  - `npm test`
  - `npm run test:e2e`

## Acceptance Criteria

1. `src/index.ts` 行数降至 `< 250`，且命令兼容。  
2. `merlion wechat --login` 与 REPL `:wechat`/`/wechat` 行为保持一致。  
3. WeChat 默认不发逐 turn 进度，仅发最终结果；`MERLION_WECHAT_PROGRESS=1` 才开启进度推送。  
4. 发送限流（`errcode=-2`）不触发重试风暴；长轮询 `524` 不视为异常失败。  
5. 全量测试通过后再发版。  

## Risks & Mitigations

- 风险：拆分期间行为回归（参数解析/会话恢复/权限模式）。  
  - 缓解：PR-1 明确 no behavior change，先补快照测试再搬迁。  
- 风险：Task 层过度设计，反而拖慢迭代。  
  - 缓解：只落地最小三类任务，后续按场景再扩。  
- 风险：WeChat sink 在长文本/频繁更新下再次触发送达问题。  
  - 缓解：默认 final-only，进度推送显式开关 + 配额上限。  

## Notes

- 本方案是架构落地计划文档，不代表已实现。  
- 实施优先顺序：`PR-1 -> PR-2 -> PR-3 -> PR-4 -> PR-5`。  
- 如需快速收益，先做 `PR-1 + PR-2`。  

