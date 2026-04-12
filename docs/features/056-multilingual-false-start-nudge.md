# Feature 056: Multilingual False-Start Nudge

Status: `done`  
Type: `P0 Runtime`

## Goal

修复模型“口头承诺下一步动作但未调用工具就 stop”导致的卡住问题，且避免只对单一措辞/语言过拟合。

## Implementation

- `src/runtime/loop.ts` 的 `shouldNudge()` 升级：
  - 改为“意图信号 + 动作信号 + 完成/结果豁免”的通用判定逻辑。
  - 覆盖英文与中文常见 false-start 场景，但不依赖单一固定短语。
  - 对完成态、ack、具体结果（如路径/代码块）加豁免，减少误触发。
- `tests/runtime_loop.test.ts` 新增中文 false-start 与短回复保护测试。

## Files

- `src/runtime/loop.ts`
- `tests/runtime_loop.test.ts`

## Verification

- `node --experimental-strip-types --test tests/runtime_loop.test.ts`
- `npm run typecheck`
