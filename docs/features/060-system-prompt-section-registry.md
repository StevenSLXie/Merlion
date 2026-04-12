# Feature 060: System Prompt Section Registry

Status: `done`  
Type: `P0 Prompt/Runtime`

## Goal

把 system prompt 从“单段硬编码字符串”升级为“可分段、可缓存”的结构，便于后续扩展并降低动态上下文抖动带来的不稳定性。

## Implementation

- 新增 `src/prompt/sections.ts`：
  - 定义 section 规格（`id/resolve/cachePolicy`）。
  - 支持 `session` 与 `volatile` 两类缓存策略。
  - 支持按顺序解析并输出 `fromCache` 元信息。
  - 提供 `joinPromptSections()` 统一拼接规则。
- 新增 `src/prompt/system_prompt.ts`：
  - 维护 Merlion 的静态 section（身份与路径探索策略）。
  - 维护动态 section（workspace scope、tool call contract）。
  - 通过 section cache 生成最终 system prompt。
- `src/index.ts` 接入：
  - 启动时创建 section cache。
  - 使用 builder 产出 system prompt，替代原先硬编码拼接。

## Files

- `src/prompt/sections.ts`
- `src/prompt/system_prompt.ts`
- `src/index.ts`
- `tests/prompt_sections.test.ts`

## Verification

- `node --experimental-strip-types --test tests/prompt_sections.test.ts`
- `npm run typecheck`

