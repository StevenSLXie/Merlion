# Feature 054: Path-Guided Prompt Policy

Status: `done`  
Type: `P1 Prompt/UX`

## Goal

让模型默认遵循“按图索骥”而不是大范围盲搜，并在地图更新时给用户轻提示。

## Implementation

- `src/index.ts` 的 `systemPrompt` 增加路径导航策略：
  - 先候选目录、后定向搜索、最后扩圈。
  - 规则冲突时近邻目录优先。
- `src/cli/experience.ts` 新增 `onMapUpdated()`：
  - guidance delta 注入时显示简短提示。
  - codebase index 更新时显示简短提示。

## Files

- `src/index.ts`
- `src/cli/experience.ts`

## Verification

- 手动运行 `merlion --repl` 并触发工具调用，观察 `[map] ...` 提示。
- `npm run typecheck`
