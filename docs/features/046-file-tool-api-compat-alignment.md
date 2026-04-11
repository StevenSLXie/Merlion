# Feature 046: File Tool API Compatibility Alignment

Status: `done`  
Type: `P1 tools`

## Goal

进一步对齐 free-code 的文件工具调用形态，降低模型从其他 coding-agent 生态迁移到 Merlion 时的提示与工具参数不兼容成本。

## Changes

### `read_file`

- 新增 `file_path` 参数别名（兼容 `path`）
- 新增 `offset` + `limit` 行窗口语义（兼容 `start_line/end_line`）

### `write_file`

- 新增 `file_path` 参数别名（兼容 `path`）

### `edit_file`

- 新增 `file_path` 参数别名（兼容 `path`）
- 新增 `replace_all`，支持多处替换
- 默认仍保持安全模式：未显式 `replace_all=true` 时，要求 `old_string` 唯一匹配

## Compatibility Notes

- free-code 的写入前“必须先 read”与并发冲突检查依赖更复杂的 runtime file-state；Merlion 当前尚未引入该状态机，因此只做输入层语义兼容，不做 1:1 强制前置读取。

## Files

- `src/tools/builtin/read_file.ts`
- `src/tools/builtin/write_file.ts`
- `src/tools/builtin/edit_file.ts`
- `tests/read_file.test.ts`
- `tests/edit_file.test.ts`
- `tests/tools_fs_pack.test.ts`

## Verification

- `npm run typecheck`
- `node --experimental-strip-types --test tests/read_file.test.ts tests/edit_file.test.ts tests/tools_fs_pack.test.ts`
