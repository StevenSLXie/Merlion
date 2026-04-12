# Feature 051: Path-Guided Context Loading

Status: `done`  
Type: `P0 Runtime`

## Goal

在新 session 中减少“全仓搜索”，把上下文加载改为“按路径逐层挂载”：

- 基于工具结果提取候选路径。
- 按 `root -> ... -> target` 加载新增 `AGENTS.md`。
- 仅注入 guidance delta，避免重复注入。

## Implementation

- 新增 `src/context/path_guidance.ts`：
  - 从工具参数/输出提取路径信号。
  - 计算目录链并加载未加载的 `AGENTS.md`。
  - 支持 token/file budget 截断。
- `src/runtime/loop.ts` 新增 `onToolBatchComplete` 回调注入点。
- `src/index.ts` 接入 path guidance state，并在每个工具批次后注入增量 system guidance。

## Files

- `src/context/path_guidance.ts`
- `src/runtime/loop.ts`
- `src/index.ts`
- `tests/path_guidance.test.ts`
- `tests/runtime_loop.test.ts`

## Verification

- `node --experimental-strip-types --test tests/path_guidance.test.ts tests/runtime_loop.test.ts`
- `npm run typecheck`
