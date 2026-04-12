# Feature 056: Multilingual False-Start Nudge

Status: `done`  
Type: `P0 Runtime`

## Goal

修复模型在中文场景下“口头承诺下一步动作但未调用工具就 stop”导致的卡住问题。

## Implementation

- `src/runtime/loop.ts` 的 `shouldNudge()` 升级：
  - 在英文外新增中文 false-start 模式识别。
  - 移除原先对长文本（>=50）的单一依赖，改为动作承诺模式触发。
  - 新增完成态短语过滤，避免对真正完成回复误触发。
- `tests/runtime_loop.test.ts` 新增中文 false-start 与短回复保护测试。

## Files

- `src/runtime/loop.ts`
- `tests/runtime_loop.test.ts`

## Verification

- `node --experimental-strip-types --test tests/runtime_loop.test.ts`
- `npm run typecheck`
