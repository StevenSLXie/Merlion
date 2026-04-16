Status: `implemented`
Type: `P1 Runtime Quality`

# 088 Source-First Bug-Fix Guardrails

## Goal

把真实 bug-fix 场景里“先改测试、后找实现”的常见偏移，收敛成通用 runtime 规则，而不是对具体 benchmark case 做特判。

目标是让 Merlion 在 bug-fix / regression-repair 类任务里更稳定地：

- 把 failing tests / logs 当作 specification
- 优先修改 implementation / source files
- 只有在用户明确要求，或有强证据证明测试错误时，才先改测试

## Background

在本地可稳定运行的 `BugsInPy thefuck 1-8` 样本里，baseline agent 能修过 `1,2,3,4,5,8`，但 `6,7` 都失败。

失败模式不是“不会定位 repo”，而是更具体的 harness/runtime 偏移：

1. agent 能读到 failing tests
2. 但第一批 mutation 落在 `tests/**`
3. 没有足够强的 runtime 提示把它拉回 implementation

这说明问题不在单个 tool，而在 bug-fix loop 的优先级和 guardrail。

## Non-Goals

- 不根据 benchmark 的项目名、bug id、文件名做任何分支
- 不禁止编辑测试
- 不把所有任务都强行当成 bug-fix
- 不把“通过 benchmark”当作唯一目标

## Design

### 1. System Prompt: Conditional Bug-Fix Discipline

在全局 system prompt 中补一段条件化原则：

- 当任务是 bug-fix / regression repair 时
- failing tests / logs / repro steps 应视为 specification
- 优先 implementation/source edits
- 除非用户明确要求，或强证据表明测试错误，否则不要先改测试

这里不直接绑定具体 benchmark 文案，只补通用 coding-agent 纪律。

### 2. Intent Contract: Bug-Fix Source-First Guidance

在 `buildIntentContract()` 中增加 bug-fix task 检测。

当 user prompt 呈现以下信号时，追加 bug-fix contract：

- `bug / buggy / fix / broken / failing / regression / error / traceback / exception`
- 对应中文：`修复 / bug / 缺陷 / 报错 / 异常 / 回归 / 失败`

但如果 prompt 明确是在“写/补/改测试”，则不进入 source-first guardrail。

追加 contract 内容：

- use failing tests/logs to localize
- inspect nearest implementation before broad edits
- prefer source edits before test edits
- only edit tests first when user asked or evidence is strong

### 3. Loop Guardrail: First Test-Only Mutation Hint

在 `runLoop()` 的 mutation tracking 上增加一个轻量动态 guardrail。

条件：

- 当前任务被识别为 bug-fix/source-first mode
- 尚未出现任何非测试文件 mutation
- 当前成功 mutation batch 只触达 test-like paths

动作：

- 注入一条 corrective user message
- 明确提醒“tests are spec, source first”
- 不 hard-block，不撤销 mutation，不终止 loop

这样设计的原因：

- 对真正需要改测试的任务，模型仍可继续
- 对偏移到测试文件的 bug-fix 任务，会在第一时间被拉回实现层

### 4. Loop Guardrail: Bug-Fix Convergence Hint

真实 case 里更常见的问题并不是立即改错文件，而是：

- 连续多轮 search/read/bash
- 已经读过 failing tests 和相关实现
- 仍迟迟不进入 first mutation

因此还需要一个更强的 bug-fix-specific no-mutation hint。

条件：

- 当前任务处于 bug-fix/source-first mode
- 连续多个 tool batch 没有任何成功 file mutation

动作：

- 比普通 `No material progress detected` 更早触发
- 明确要求停止 broad exploration
- 要求从已读 tests/logs 收敛到一个最可能的 implementation file
- 做一个最小 source edit，或明确说明 blocker

这条 guardrail 解决的是“迟迟不收敛”的通用 runtime 问题，不依赖具体 benchmark。

### 5. Test-Like Path Heuristic

首版只做通用、保守匹配：

- `/test/`
- `/tests/`
- `/spec/`
- `/specs/`
- `*.test.*`
- `*.spec.*`
- `*_test.*`
- `test_*.py`

这不是完美识别，但足够作为 runtime nudge 的触发器。

## Files

- `src/prompt/system_prompt.ts`
- `src/runtime/intent_contract.ts`
- `src/runtime/loop.ts`
- `tests/prompt_sections.test.ts`
- `tests/intent_contract.test.ts`
- `tests/runtime_loop.test.ts`

## Expected Impact

这项改动应该带来的是“通用 bug-fix discipline”提升：

- 降低 test-first patch drift
- 提高 implementation-first 修复率
- 不依赖项目语言或具体 benchmark

Secondary impact:

- 减少无效 test rewrites
- 让 loop 在失败测试驱动场景下更像一个 coding agent，而不是 patch-anything agent

## Validation

### Unit / Local

- intent contract 在 bug-fix prompt 下追加 source-first guidance
- test-writing prompt 不应误触发 bug-fix source-first mode
- loop 在 first mutation is test-only 时注入一次 corrective hint
- loop 在 source file first mutation 时不应注入该 hint
- bug-fix prompt 下，连续无 mutation batch 更早收到 convergence hint

### Bench

复跑当前 validated `BugsInPy thefuck 1-8`：

- baseline: `6/8`
- target: 重点观察 `6,7`

改进标准：

- 至少一个失败 case 转为通过，且
- 没有引入明显的非 bug-fix 退化

Observed outcome on `2026-04-16`:

- rerun result: `8/8`
- `6` 从 `agent failed` 改为 source patch + full pass
- `7` 从 `acceptance failed` 改为 source patch + full pass
