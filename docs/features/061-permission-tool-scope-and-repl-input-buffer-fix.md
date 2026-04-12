# Feature 061: Permission Tool-Scope Remember + REPL Input Buffer Fix

Status: `done`  
Type: `P0 Runtime/UX`

## Goal

修复两类交互问题：

1. `yes and do not ask again` 应按工具维度生效，而不是仅同一条请求描述。  
2. REPL 场景下权限输入 `y/n/a` 不应污染后续用户输入缓冲。

## Implementation

- `src/permissions/store.ts`：
  - 交互模式下的 remember 缓存从“`tool+description`”改为“仅 `tool`”。
  - 提示文案改为 “do not ask again for this tool in this session”。
  - 默认读入方式改为短生命周期 `readline`，避免裸 `stdin.once('data')` 带来的输入竞争。
- 新增 `src/cli/ask.ts`：
  - 提供短生命周期提问 helper（每次提问创建并关闭一次 interface）。
  - 提供可注入工厂的函数，便于单测覆盖 close/异常路径。
- `src/index.ts`（REPL 与 auth 询问）：
  - 改为使用短生命周期提问 helper，移除常驻 `readline` 实例。
  - 避免权限输入被常驻 REPL listener 误吸收并堆积成后续 prompt。

## Files

- `src/permissions/store.ts`
- `src/cli/ask.ts`
- `src/index.ts`
- `tests/permissions_store.test.ts`
- `tests/cli_ask.test.ts`

## Verification

- `node --experimental-strip-types --test tests/permissions_store.test.ts tests/cli_ask.test.ts`
- `npm run typecheck`

