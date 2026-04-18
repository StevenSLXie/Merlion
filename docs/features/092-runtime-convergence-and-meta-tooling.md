Status: `planned`
Type: `P1 Runtime Quality`

# 092 Runtime Convergence And Meta-Tooling

## Goal

在不引入 benchmark 特判的前提下，把 Merlion 从“能一直调用工具”收敛到“能更稳定地结束搜索、进入改动、做自检和验证”。

重点不是再补底层工具，而是补运行时的收敛层。

## Background

前两轮修正已经证明：

1. 空参数 / 伪路径这类低层错误可以靠 executor validation 明显压下去
2. 压下去之后，主要剩余失败变成：
   - 长时间 `read/search/bash`
   - patch 能产出，但语义浅或方向不对
   - 验证口径偏弱
   - edit 后不自检 diff，容易膨胀

这说明瓶颈已经从“工具调用是否有效”上移到“何时收敛、如何自检”。

## Self-Review Findings

当前 runtime 仍然缺少几类通用机制：

1. exploration budget
2. large-diff self-review
3. verification-strength awareness
4. canonical artifact awareness
5. model-visible verification / planning meta actions

## Non-Goals

- 不引入完整的 planner 子系统
- 不做 benchmark-specific stop rules
- 不禁止长搜索，只在证据充分时收敛
- 不把所有任务都强制变成 plan-first

## Design

### 1. Exploration Budget

当满足以下条件时，应注入更强的收敛提示：

1. 连续多轮 `read/search/grep/glob/list_dir/bash`
2. 没有成功 mutation
3. 已经读过多个候选文件

提示内容应要求模型：

- 停止继续 broad search
- 从已读文件里选一个最可能的目标
- 做一个最小 edit 或说明 blocker

这比当前 generic no-mutation hint 更具体。

### 2. Large-Diff Self-Review

当单次或累计 diff 超过阈值时，应触发 self-review 提示。

目标：

- 防止 patch 意外膨胀
- 防止在一个 issue 上顺手重构太多
- 防止错误生成整段/整文件替换

runtime 可观察信号：

- changed file count
- diff hunk count
- added/removed line count

### 3. Verification Strength

在 runtime 中为 agent 当前验证强度建立分层：

- `none`
- `import_only`
- `repro_script`
- `existing_test`
- `targeted_test`

finish 前如果验证强度过低，而任务看起来是 code-change task，则注入更强提示：

- 不要只说“verified”
- 给出具体命令或证据
- 若无法验证，明确未验证范围

### 4. Canonical Artifact Awareness

当前 agent 虽然少了随机 note 文件，但仍可能生成：

- repo root 临时脚本
- 非 canonical 测试位置
- 与 issue 无关的辅助文件

runtime 需要把这些识别出来，并在 finish 前提醒模型：

- 临时验证脚本应移到 `.merlion/` 或删除
- 新测试应落在 canonical test 目录

### 5. Meta-Tools, But Lightweight

不建议第一步直接复制 `free-code` 的 full plan mode。

Merlion 首版更适合补两个轻量 meta actions：

1. `todo_write` workflow strengthening
2. model-visible verification trigger

第二项可以先不做完整 tool，而是先让 runtime 暴露统一 verification entry 的 contract，再决定是否上独立 tool。

### 6. Free-Code-Inspired But Not Copied

`free-code` 值得借鉴的不是整个模式切换，而是：

- `TodoWriteTool` 会推动 verification
- `EnterPlanMode` 把“何时先规划”显式化
- `FileEditTool` 有更强的 preconditions

Merlion 应先做：

- lightweight convergence
- verification-aware closeout
- search-to-edit budget

而不是直接移植 full plan mode。

## Files

- `src/runtime/loop.ts`
- `src/runtime/executor.ts`
- `src/runtime/tool_batch_milestones.ts`
- `src/tools/builtin/todo_write.ts`
- `src/runtime/runner.ts`
- `tests/runtime_loop.test.ts`
- `tests/executor.test.ts`
- `tests/verification_runner.test.ts`

## Expected Impact

这项改动应该主要改善：

- endless exploration
- shallow patch drift
- overclaimed verification
- oversized patch accidents

并为后续 20-case / 300-case bench 提供更清楚的 failure buckets。

## Validation

### Unit

- repeated read/search without mutation triggers convergence hint
- oversized diff triggers self-review hint
- weak verification before finish triggers verification-strength hint
- non-canonical artifact detection triggers cleanup hint

### Integration

- verify flow can be invoked or surfaced from runtime closeout
- todo closeout can produce verification reminder

### Bench Replay

优先复跑代表性 unresolved 样本：

- `psf__requests-2674`
- `mwaskom__seaborn-2848`
- `matplotlib__matplotlib-18869`
- `sympy__sympy-20590`

观察点：

- tool misuse 是否继续下降
- search turns 是否减少
- empty diff / malformed patch 是否减少
- resolved rate 是否提升

## Acceptance Criteria

1. runtime 能识别“探索过多但没收敛”的状态。
2. finish 前能根据验证强度做差异化提醒。
3. 大 patch / 非 canonical artifact 能触发 self-review。
4. meta-tooling 优先走 lightweight route，而不是直接搬 full plan mode。
