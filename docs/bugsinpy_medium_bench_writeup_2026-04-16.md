Status: `writeup`
Date: `2026-04-16`

# BugsInPy Medium Bench Writeup (thefuck 1-8)

## Purpose

记录这轮基于真实开源 bug 的 agent 修复回路：

1. case 是什么
2. baseline 结果是什么
3. 我们一开始如何分析失败
4. 后来如何修正判断
5. runtime 具体改了什么
6. 改完后的回测结果是什么

这份文档用于：

1. 后续版本发布说明
2. 下一轮 medium bench 扩容的参考
3. 避免以后重复踩同样的分析误区

## Case Pool

这轮使用的是 `BugsInPy` 中本地可稳定运行的一组 `thefuck` case：

1. `bug 1`: `thefuck/rules/pip_unknown_command.py`
2. `bug 2`: `thefuck/utils.py`
3. `bug 3`: `thefuck/shells/fish.py`
4. `bug 4`: `thefuck/shells/fish.py`
5. `bug 5`: `thefuck/rules/git_push.py`
6. `bug 6`: `thefuck/rules/git_branch_exists.py`
7. `bug 7`: `thefuck/rules/php_s.py`
8. `bug 8`: `thefuck/rules/dnf_no_such_command.py`

这些 case 的共同特征：

1. 都是已有行为 regression / bug fix
2. 都有明确 failing tests
3. 都能在当前本机完成 `checkout -> compile -> relevant test -> regression`
4. 任务形态很接近真实 coding agent 的主战场：读 test、读实现、最小 source patch、回归验证

## Fixed Baseline Validation

先做的是 fixed-baseline probe，确认这些 case 在本机真的是“可验证”的。

相关脚本：

1. [scripts/bench_medium/bugsinpy/probe.ts](/Users/xieshuanglong/Documents/Code/Merlion/scripts/bench_medium/bugsinpy/probe.ts)
2. [scripts/bench_medium/bugsinpy/analyze_runs.ts](/Users/xieshuanglong/Documents/Code/Merlion/scripts/bench_medium/bugsinpy/analyze_runs.ts)

相关 spec：

1. [083-bugsinpy-medium-bench-bootstrap.md](/Users/xieshuanglong/Documents/Code/Merlion/docs/features/083-bugsinpy-medium-bench-bootstrap.md)
2. [084-bugsinpy-validated-case-curation.md](/Users/xieshuanglong/Documents/Code/Merlion/docs/features/084-bugsinpy-validated-case-curation.md)
3. [085-bugsinpy-fixed-baseline-probe-and-gap-analysis.md](/Users/xieshuanglong/Documents/Code/Merlion/docs/features/085-bugsinpy-fixed-baseline-probe-and-gap-analysis.md)
4. [086-bugsinpy-venv-bootstrap-and-probe-observability.md](/Users/xieshuanglong/Documents/Code/Merlion/docs/features/086-bugsinpy-venv-bootstrap-and-probe-observability.md)

最终保留下来的 validated pool 是：

1. `thefuck 1-8`

## Baseline Agent Run

第一次真实 agent 跑的是两批：

1. [20260416-084736](/Users/xieshuanglong/Documents/Code/Merlion/bench_medium/bugsinpy/probe_results/20260416-084736)
2. [20260416-085451](/Users/xieshuanglong/Documents/Code/Merlion/bench_medium/bugsinpy/probe_results/20260416-085451)

baseline 结果：

| Bug | Baseline Result | Notes |
| --- | --- | --- |
| 1 | passed | regex widening |
| 2 | passed | path separator |
| 3 | passed | fish version parsing |
| 4 | passed | fish alias parsing |
| 5 | passed | git push match narrowing |
| 6 | failed | `agent failed` |
| 7 | failed | `acceptance failed` |
| 8 | passed | bytes/string handling |

汇总：

1. baseline pass rate: `6/8`
2. baseline failure set: `6, 7`

## Initial Failure Hypothesis

第一次看 `6/7` 失败时，一个很自然的判断是：

1. workspace 里出现了 `tests/**` 的 diff
2. 所以 agent 可能“先改了测试”

这个判断后来被证明 **不够严谨**。

## Important Correction: Why The First Diagnosis Was Wrong

`BugsInPy checkout` 本身会把 benchmark 对应的 failing tests materialize 到 workspace。

也就是说：

1. 在 agent 开始前，workspace 里就可能已经有 `tests/**` 的 diff
2. 单看 `git diff tests/**`，不能直接证明这是 agent 自己写进去的

这轮最重要的方法论修正就是：

1. 失败分析不能只看 workspace diff
2. 要优先看：
   - agent stdout
   - tool trace
   - command result
   - source file diff

这个修正已经写回 [085-bugsinpy-fixed-baseline-probe-and-gap-analysis.md](/Users/xieshuanglong/Documents/Code/Merlion/docs/features/085-bugsinpy-fixed-baseline-probe-and-gap-analysis.md)。

## Refined Problem Statement

重新分析后，真实问题更像是：

1. bug-fix 场景下，agent exploration 偏长
2. 已经读到 failing tests / 相关实现后，仍然容易继续 search/read/bash
3. first mutation 收敛得不够快
4. system/runtime 对“bug-fix 时应尽快落到 source patch”这件事约束不够强

所以这次优化目标不是“针对某个 case 写规则”，而是补一层更通用的 bug-fix runtime discipline。

## What We Changed

### 1. System Prompt: Bug-Fix Discipline

文件：

1. [src/prompt/system_prompt.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/prompt/system_prompt.ts)

新增静态段：

1. bug-fix 时把 failing tests / logs / repro 当 specification
2. 优先改 implementation/source
3. 不默认先改 tests

这是最轻的一层，全局建立优先级。

### 2. Intent Contract: Bug-Fix vs Test-Edit Separation

文件：

1. [src/runtime/intent_contract.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/runtime/intent_contract.ts)

新增：

1. `isBugFixPrompt()`
2. `isExplicitTestEditRequest()`

作用：

1. 真正像 bug-fix 的任务，追加 source-first guidance
2. 明确在“补测试/改测试”的任务，不误触发这层 guardrail

这一步很关键，因为我们不想把“新增特性”或“测试开发任务”错误地压成 bug-fix 模式。

### 3. Loop Guardrail: Bug-Fix Convergence

文件：

1. [src/runtime/loop.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/runtime/loop.ts)

新增两类动态提示：

1. `Bug-fix convergence`
   - bug-fix 模式下，连续若干 tool batch 没有成功 file mutation 时，更早提示模型停止 broad exploration
   - 要求收敛到一个最可能的 implementation/source file，并做一个最小 source edit
2. `first test-only mutation hint`
   - bug-fix 模式下，如果第一次成功 mutation 只落在 test-like path，会追加 source-first 提示

另外顺手修了一个 loop 里的小问题：

1. mutation tracking 之前和 oscillation hint 上限耦合过紧
2. 达到上限后会影响后续 mutation 统计
3. 这次一并拆开了

### 4. Bench Observability

为了让这类分析不再靠猜，还补了：

1. probe result per-case 落盘
2. compile wrapper 的兼容处理
3. analysis 脚本和测试

相关文件：

1. [scripts/bench_medium/bugsinpy/probe.ts](/Users/xieshuanglong/Documents/Code/Merlion/scripts/bench_medium/bugsinpy/probe.ts)
2. [scripts/bench_medium/bugsinpy/analyze_runs.ts](/Users/xieshuanglong/Documents/Code/Merlion/scripts/bench_medium/bugsinpy/analyze_runs.ts)
3. [tests/bench_medium_bugsinpy_probe.test.ts](/Users/xieshuanglong/Documents/Code/Merlion/tests/bench_medium_bugsinpy_probe.test.ts)
4. [tests/bench_medium_bugsinpy_analysis.test.ts](/Users/xieshuanglong/Documents/Code/Merlion/tests/bench_medium_bugsinpy_analysis.test.ts)

## Validation After Changes

代码改完后，先过了本地验证：

1. `node --experimental-strip-types --test tests/intent_contract.test.ts tests/prompt_sections.test.ts tests/runtime_loop.test.ts`
2. `npm run typecheck`

然后重新跑了完整 8 case：

1. [20260416-094139](/Users/xieshuanglong/Documents/Code/Merlion/bench_medium/bugsinpy/probe_results/20260416-094139)

结果：

| Bug | Baseline | After Fix | Delta |
| --- | --- | --- | --- |
| 1 | passed | passed | no change |
| 2 | passed | passed | no change |
| 3 | passed | passed | no change |
| 4 | passed | passed | no change |
| 5 | passed | passed | no change |
| 6 | failed | passed | improved |
| 7 | failed | passed | improved |
| 8 | passed | passed | no change |

总结果：

1. baseline: `6/8`
2. rerun: `8/8`
3. improved cases: `2`

## Runtime / Duration Comparison

耗时也做了对比，但这里需要先强调：

1. 这些 run 依赖真实外部 provider
2. provider 会在不同轮次切换
3. cache 命中率、网络波动、模型端抖动都会影响总时长

所以耗时数据可以当作“执行趋势信号”，不应该被解读为严格性能 benchmark。

按 case 对比：

| Bug | Baseline ms | Rerun ms | Delta ms |
| --- | --- | --- | ---: |
| 1 | 137,048 | 187,690 | +50,642 |
| 2 | 202,368 | 165,805 | -36,563 |
| 3 | 174,404 | 274,911 | +100,507 |
| 4 | 333,868 | 321,792 | -12,076 |
| 5 | 194,391 | 126,585 | -67,806 |
| 6 | 428,439 | 302,854 | -125,585 |
| 7 | 221,855 | 414,601 | +192,746 |
| 8 | 266,549 | 192,658 | -73,891 |

汇总：

1. baseline total: `1,958,922 ms`
2. rerun total: `1,986,896 ms`
3. total delta: `+27,974 ms`

如果只看“通过的工作量”，更有意义的观察是：

1. baseline 最终只完成了 `6` 个 pass
2. rerun 完成了 `8` 个 pass
3. 因此虽然总耗时略高，但单位成功 case 的吞吐其实更好

最值得关注的两个 case：

1. `bug 6`
   - 从失败变成通过
   - 同时耗时从 `428,439 ms` 降到 `302,854 ms`
   - 说明这次改动确实让它更快收敛到正确 source patch
2. `bug 7`
   - 从失败变成通过
   - 但耗时从 `221,855 ms` 升到 `414,601 ms`
   - 说明这题虽然最终修对了，但探索路径仍然偏长，后面还值得继续压缩

所以这轮的结论不是“整体更快”，而是：

1. 整体成功率更高
2. 部分失败 case 的收敛质量明显改善
3. 但 runtime latency 还没有系统性优化完成

## What Actually Improved

最关键的提升不是“碰巧过了两题”，而是：

1. `bug 6`
   - baseline: 失败
   - rerun: 成功改到 [git_branch_exists.py](/Users/xieshuanglong/Documents/Code/Merlion/bench_medium/bugsinpy/probe_results/20260416-094139/PROBE_THEFUCK_6_BUGGY/workspace/thefuck/thefuck/rules/git_branch_exists.py)
   - 结果与 gold patch 语义一致：regex 放宽 + quote escaping
2. `bug 7`
   - baseline: 失败
   - rerun: 成功改到 [php_s.py](/Users/xieshuanglong/Documents/Code/Merlion/bench_medium/bugsinpy/probe_results/20260416-094139/PROBE_THEFUCK_7_BUGGY/workspace/thefuck/thefuck/rules/php_s.py)
   - 结果与 gold patch 语义一致：把匹配条件从 `"php -s"` 收敛到更普适的 `-s`

这说明改动确实把 agent 在 bug-fix 场景里的收敛路径拉正了。

## Takeaways

### 1. 真实 bench 比 fixture 更容易暴露 runtime 优先级问题

当前 Merlion 的能力不是“不会写 patch”，而是：

1. 在真实 repo + failing tests + 历史依赖的压力下
2. 对什么时候停止探索、开始 patch
3. 还需要更强的 runtime guidance

### 2. 分析 agent 失败不能只看 workspace diff

这次最大的经验教训是：

1. benchmark harness 自己也会改 workspace
2. 如果不先理解 harness，就容易把系统性噪音误判成 agent 行为

### 3. 通用 guardrail 比 case-specific fix 更值得保留

这轮的改动没有写任何 `thefuck`、`bug 6`、`bug 7` 的特判。

保留下来的是：

1. bug-fix discipline
2. bug-fix intent classification
3. bug-fix convergence hint

这三样都属于通用 coding agent runtime 能力。

## Release Readiness

从这轮结果看，已经具备准备下一版的条件：

1. 有真实 medium bench writeup
2. 有 baseline 与 rerun 对照
3. 有明确可解释的 runtime 改动
4. 有 `6/8 -> 8/8` 的真实提升

如果下一步发版本，建议在 changelog 里明确写：

1. medium bench / BugsInPy lane 已形成闭环
2. bug-fix runtime 增加 source-first + convergence guardrails
3. `thefuck 1-8` medium bench rerun 达到 `8/8`
