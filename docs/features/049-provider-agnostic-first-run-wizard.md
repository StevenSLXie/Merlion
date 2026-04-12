# Feature 049: Provider-Agnostic First-Run Wizard

Status: `done`  
Type: `P0 UX + compatibility`

## Goal

首次进入 CLI 时，不再只支持 OpenRouter。改为支持三种路径：

- `openrouter`（无需手填 URL）
- `openai`（无需手填 URL）
- `custom`（用户输入任意 OpenAI-compatible `baseURL`）

并统一兼容 `MERLION_*` 与已有 provider-specific 环境变量。

## Implementation

### Wizard flow

- 更新 `src/config/wizard.ts`：
  - provider 选择：`1=openrouter / 2=openai / 3=custom`
  - `custom` 路径强制输入并校验 `http/https` URL
  - 统一 API key 提示（不再写死 OpenRouter）
  - 模型默认值按 provider 选择
- 配置持久化新增 `provider` 字段。

### Config model

- `src/config/store.ts` 新增 `MerlionProvider`：
  - `openrouter | openai | custom`
- `mergeConfig` 支持 `provider` 合并。

### Runtime resolution

- `src/index.ts` 新增 provider/env 解析：
  - 支持 `MERLION_PROVIDER / MERLION_API_KEY / MERLION_MODEL / MERLION_BASE_URL`
  - 保留兼容 `OPENROUTER_API_KEY / OPENAI_API_KEY`
  - 若缺关键配置（如 custom 无 baseURL）自动触发 wizard

### Built-in config tools

- `config / config_get / config_set` 新增 `provider` 键支持。
- provider 写入时做值校验（`openrouter/openai/custom`）。

## Files

- `src/config/wizard.ts`
- `src/config/store.ts`
- `src/index.ts`
- `src/tools/builtin/config.ts`
- `src/tools/builtin/config_get.ts`
- `src/tools/builtin/config_set.ts`
- `tests/config_wizard.test.ts`
- `tests/config_store.test.ts`
- `tests/tools_meta_pack.test.ts`
- `docs/todo.md`
- `docs/tracker.md`

## Verification

- `node --experimental-strip-types --test tests/config_store.test.ts tests/config_wizard.test.ts tests/tools_meta_pack.test.ts`
