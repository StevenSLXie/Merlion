# Feature 068: Bootstrap / Runtime Runner / Sinks Decomposition

Status: `in_progress`  
Type: `P1 Architecture`

## Goal

把 `src/index.ts` 从“超大入口编排文件”拆成更清晰的几层：

- `src/bootstrap/cli_args.ts`
- `src/bootstrap/config_resolver.ts`
- `src/runtime/runner.ts`
- `src/runtime/events.ts`
- `src/runtime/sinks/cli.ts`
- `src/runtime/sinks/wechat.ts`

要求：

- 现有 CLI 语义保持不变
- REPL / one-shot / verify / WeChat mode 行为保持兼容
- 以“搬迁职责”为主，不顺手引入新功能

## Scope

- In:
  - 参数解析与 usage/version/help 输出从 `index.ts` 抽离
  - config 合并 / wizard 触发 / 缺省补全从 `index.ts` 抽离
  - `runTurn`、session/orientation/artifact wiring、REPL / one-shot 执行编排抽到 `runtime/runner.ts`
  - CLI 输出能力通过 sink 包装 `CliExperience`
  - WeChat transport 启动入口通过 sink 包装
  - 新增单元测试覆盖 bootstrap / resolver / sink 抽象
- Out:
  - 不改动 runtime loop 协议
  - 不引入 task runtime
  - 不引入 tool pool / MCP / skill runtime
  - 不改变 WeChat transport 内部实现

## Current Pain Points

1. `src/index.ts` 同时负责：
   - 参数解析
   - config 解析
   - mode 分流
   - session 初始化
   - runtime hook wiring
   - artifact 自动维护
   - REPL 与 verify 驱动
2. CLI 输出事件没有统一 sink 抽象。
3. WeChat mode 虽然是独立 transport，但入口接法仍散落在 `index.ts` 和 REPL 回调中。

## Design

### 1. bootstrap/cli_args.ts

职责：

- 定义 `CliFlags`
- 提供 `parseCliArgs(argv)`
- 提供 `createDefaultCliFlags()`
- 提供 `printUsage()`

要求：

- 保持现有 flags 兼容
- help/version/config/wechat/repl 解析规则不变

### 2. bootstrap/config_resolver.ts

职责：

- 处理 env + file config + defaults 的合并
- 在缺配置或 `config` 模式时触发 wizard
- 输出 runner 可直接消费的 `ResolvedCliConfig`

要求：

- 保持 provider 推断逻辑一致
- 保持 custom provider 必填 `baseURL` 的行为
- 支持“只运行 config 然后退出”

### 3. runtime/events.ts

职责：

- 定义 runtime 对 sink 暴露的 typed events
- 提供 `RuntimeSink` 接口

目标：

- 后续 CLI / WeChat / 其他前端都消费同一套运行时事件形状

### 4. runtime/sinks/cli.ts

职责：

- 包装 `CliExperience`
- 适配 `RuntimeSink`

要求：

- 输出风格不变
- detail mode / spinner / usage / phase/map 更新全部透传

### 5. runtime/sinks/wechat.ts

职责：

- 封装 WeChat transport mode 的启动入口
- 让 `index.ts` 和 REPL 不再直接 import `transport/wechat/run.ts`

注意：

- 这里只做入口适配，不改 WeChat transport 内部逻辑

### 6. runtime/runner.ts

职责：

- 统一承载当前单次任务运行的主编排
- 初始化 provider / registry / sessions / orientation / sink
- 维护 `runTurn()`
- 驱动：
  - one-shot
  - REPL
  - verify rounds
  - auth recovery wizard

要求：

- runtime hooks 仍连接到：
  - transcript / usage
  - progress / codebase index / stale guidance / generated maps
  - path guidance delta

## Files

- `src/bootstrap/cli_args.ts`
- `src/bootstrap/config_resolver.ts`
- `src/runtime/events.ts`
- `src/runtime/runner.ts`
- `src/runtime/sinks/cli.ts`
- `src/runtime/sinks/wechat.ts`
- `src/index.ts`
- `tests/bootstrap_cli_args.test.ts`
- `tests/bootstrap_config_resolver.test.ts`
- `tests/runtime_cli_sink.test.ts`

## Acceptance Criteria

1. `src/index.ts` 只保留入口级 wiring，不再承载主要业务编排。
2. `--help` / `--version` / `config` / `wechat` / `--repl` / `--resume` 语义不变。
3. one-shot / REPL / verify 行为保持兼容。
4. 现有测试通过，且新增 bootstrap/sink 测试覆盖拆分后的纯逻辑。

## Verification

- `node --experimental-strip-types --test tests/bootstrap_cli_args.test.ts`
- `node --experimental-strip-types --test tests/bootstrap_config_resolver.test.ts`
- `node --experimental-strip-types --test tests/runtime_cli_sink.test.ts`
- `npm test`
