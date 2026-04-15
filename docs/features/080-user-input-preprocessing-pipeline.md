# 080 User Input Preprocessing Pipeline

Status: `implemented`  
Type: `P1 Runtime UX`

## Goal

引入正式的 `processUserInput` pipeline，在用户输入进入主 agent loop 前，先经过命令解析、shortcut、skill/attachment 触发、local-only action、normalization 等统一预处理。

## Why

现在 Merlion 已经有一些输入分流：

- REPL `/wechat`
- REPL `! shell`
- `:help` / `:q`

但这些逻辑主要散落在：

- `src/cli/repl.ts`
- `src/cli/input_buffer.ts`
- 部分 runtime routing

问题是：

1. 输入解析只在 REPL 有，不是统一 runtime capability
2. slash / shell / future skill activation 没有统一 envelope
3. 不是所有输入都应该进模型，但现在缺少正式分流管线

free-code 的关键思路是：

- 用户输入先经过统一 preprocessing
- 解析出“这是 local command / slash / attachment / normal prompt”
- 再决定是否进入模型

参考：

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/QueryEngine.ts`

## Scope

- 新增统一输入 envelope 与 preprocessing pipeline
- 覆盖：
  - REPL slash commands
  - REPL shell escape
  - 普通 prompt
  - 后续 skill activation / attachment 的预留接入点

## Implementation Order

这份 spec 应由 `QueryEngine` 来消费，而不是直接塞回 `runner`。

Phase 1 目标是：

- 先把 REPL 输入解析迁到 runtime input pipeline
- 再让 `QueryEngine.submitUserMessage()` 消费 `UserInputEnvelope`
- one-shot CLI 暂时只走 `prompt` envelope 即可

## Non-Goals

- 这一版不直接实现 skill
- 不做 GUI/TUI 富交互 command palette
- 不改变 one-shot CLI 的现有语义，除非明确接入

## Implemented Files

- `src/runtime/input/types.ts`
- `src/runtime/input/process.ts`
- `src/runtime/input/commands.ts`

现有文件调整：

- `src/cli/repl.ts`
- `src/cli/input_buffer.ts`
- `src/runtime/runner.ts`

## Input Envelope

建议统一输出为：

```ts
type UserInputEnvelope =
  | { kind: 'prompt'; text: string }
  | { kind: 'slash_command'; name: string; raw: string }
  | { kind: 'shell_shortcut'; command: string }
  | { kind: 'local_action'; action: string; payload?: unknown }
  | { kind: 'empty' }
```

后续还能自然扩展：

- `skill_activation`
- `attachment`
- `workflow_launch`

## Pipeline Steps

建议顺序固定：

1. trim / sanitize
2. classify empty input
3. detect shell shortcut
4. detect slash command
5. detect local-only runtime commands
6. normalize as prompt fallback

不要把 UI 输入逻辑和 runtime preprocessing 混成一层。

## Division of Responsibility

### CLI / input buffer

负责：

- 原始字符输入
- completion UI
- 返回 line string

### runtime input pipeline

负责：

- 把 line string 解析成 typed envelope
- 决定是否进入模型

### engine / task runtime

负责：

- 消费 envelope
- 运行 local action 或 submit prompt

## Slash Command Registry

不要让 slash command 再散落在 `if/else`。

建议 registry contract：

```ts
interface SlashCommand {
  name: string
  description: string
  scope: 'repl'
  execute(ctx: RuntimeCommandContext): Promise<CommandResult>
}
```

后续 `/wechat`、`/login`、`/logout`、`/usage` 都从这里进。

## Local Action vs Model Prompt

一个核心规则：

- local-only input 不应该进入模型

例如：

- `/wechat`
- `! npm test`
- 未来 `/usage`

这些要在 preprocessing 后直接 short-circuit。

## Relationship with Skill

这份 spec 先不做 skill，但要预留：

- slash command 可触发 skill activation
- prompt classifier 可在后续判断显式 skill alias

重点是把输入流的“入口控制权”先收回来。

## Free-code Alignment

应借鉴的是：

1. 输入先处理，再决定是否进 loop
2. slash/local command 不与普通 prompt 混流
3. preprocessing 是 runtime layer，不只是 UI layer

而不是照搬 free-code 的 UI 组件实现。

## Tests

- `/wechat` -> `slash_command`
- `! ls -la` -> `shell_shortcut`
- empty line -> `empty`
- 普通句子 -> `prompt`
- local command short-circuit 不进入 engine

## E2E

- REPL slash command path
- REPL shell shortcut path

## Acceptance Criteria

1. 输入在进入 engine 前有统一 preprocessing
2. local-only commands 不再依赖 scattered branching
3. future skill/workflow/attachment 有明确接入点

## Phase 1 Implementation Note

本轮先把 REPL 入口统一到了 runtime input pipeline：

- `:q / :help / :detail`
- `/wechat` 与 `:wechat`
- `! ...`
- 普通 prompt

one-shot CLI 仍保持旧语义，只在 task dispatch 前包装成 `prompt` envelope，没有把 slash/shell 行为扩展到 one-shot。

## Free-code References

- `https://raw.githubusercontent.com/paoloanzn/free-code/main/src/QueryEngine.ts`
