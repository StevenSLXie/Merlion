# Feature 068: Explicit Path First Guidance

Status: `done`
Type: `P1 Runtime`

## Goal

当用户任务里已经明确给出目标路径时，Merlion 应该优先围绕这些路径行动，而不是先做全局探索。

## Motivation

当前 runtime 已有 path-guided exploration，但它主要依赖：

1. 启动时的 orientation / AGENTS guidance
2. tool 事件后的增量 path guidance

这对“任务里已写明文件路径”的场景不够直接，容易出现：

1. 首轮先扫全局目录或错误绝对路径
2. 反复失败的探索调用
3. 小范围改动任务被拖成长尾时延

## Non-Goals

1. 不按“大任务/小任务”分类
2. 不在本 feature 中实现动态工具池裁剪
3. 不改变现有 verification/fix-round 机制

## Design

### 1. Prompt Path Extraction

从用户 prompt 中提取显式路径信号，优先识别：

1. 反引号包裹的路径，如 ``fixture/src/auth.js``
2. 斜杠路径，如 `src/runtime/loop.ts`
3. 以 `./` 或 `../` 开头的相对路径

只接受看起来像仓库内路径的片段；忽略：

1. URL
2. `~/`
3. 明显的占位符或模板片段

### 2. Intent Contract Upgrade

`intent_contract` 增加显式路径段：

1. `Explicit target paths:`
2. 规则说明：
   - first inspect these paths or their nearest directories
   - do not start with repo-wide recursive exploration unless these paths are insufficient or invalid

### 3. First-Turn Path Guidance Seeding

在进入 `runLoop` 之前，用 prompt 中提取到的路径作为第一批 candidate paths，提前调用 path guidance 构建逻辑。

这样模型首轮就能拿到：

1. 用户明确给出的目标路径
2. 这些路径对应的 root -> target guidance chain

而不是等第一次 tool call 之后才补 guidance。

### 4. Runtime Behavior

如果存在显式路径：

1. 允许首轮围绕这些路径做 `read_file` / `list_dir(<nearest dir>)`
2. 不鼓励首轮直接 `list_dir(".", recursive=true)` 或广域扫描

这一步先通过 prompt / guidance 收敛来实现，不做硬性拦截。

## Implementation Plan

1. 在 runtime 增加 prompt path extraction helper
2. 升级 `buildIntentContract`
3. 在 `runner.ts` 的 `runTurn()` 中加入首轮 path guidance seeding
4. 为路径提取与 guidance seeding 增加测试
5. 更新 bench / findings 文档，并重跑对照 case

## Validation

实现后重跑了以下 bench case：

1. `AP002_HEADER_AUTH_GUARD`
2. `AP004_PAGINATION_OFF_BY_ONE`
3. `RW001_THEME_TOKEN_UPDATE`
4. `RW003_LOADING_STATE_BUTTON`

结果表明：

1. `AP002` 从失败变为 100 分，且首轮不再出现错误绝对路径探索。
2. `RW003` 保持 100 分，并减少了 turn 数和工具调用数。
3. `RW001` 的首轮路径行为更聚焦，但中后期仍出现测试/模块制式相关绕路，说明显式路径优先解决了“起步方向”问题，但没有解决所有长尾来源。
4. 单次 wall-clock 时延仍有较强 provider 抖动，不能只用耗时判断 prompt-path 优化效果，需要结合 turn/tool/error 指标一起看。

## Success Criteria

1. 对显式路径任务，首轮错误绝对路径和全局探索显著减少
2. `AP002_HEADER_AUTH_GUARD` 这类失败 case 不再因路径混乱而无 patch 结束
3. 对照 case 的 median turns / tool calls / latency 有可观察下降
