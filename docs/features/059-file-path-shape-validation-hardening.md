# Feature 059: File Path Shape Validation Hardening

Status: `done`  
Type: `P0 Tools`

## Goal

在文件类工具入口拦截“明显不是路径”的参数，避免模型把占位符/转义序列/模板残留当成路径执行，从而触发无意义写删循环。

## Spec

- 在统一路径校验层增加“path shape”检查，拒绝如下输入：
  - 仅由符号组成的占位符样式（如 `:=`）
  - 控制字符或 ANSI 终端转义序列
  - `~/` 家目录简写（shell 才会展开，工具层不应默默接受）
  - 模板残留（`{{...}}`, `${...}`）
- `create_file`/`edit_file` 与其他文件变更工具统一走同一校验逻辑。

## Implementation

- `src/tools/builtin/fs_common.ts`
  - 新增路径形态校验并接入 `validateAndResolveWorkspacePath`。
- `src/tools/builtin/create_file.ts`
  - 改为复用 `validateAndResolveWorkspacePath`。
- `src/tools/builtin/edit_file.ts`
  - 改为复用 `validateAndResolveWorkspacePath`。

## Tests

- `tests/create_file.test.ts`
  - 新增 `:=` 占位符路径拒绝用例。
- `tests/edit_file.test.ts`
  - 新增模板残留路径拒绝用例。
- `tests/tools_fs_pack.test.ts`
  - 新增 `write_file/delete_file` 对 malformed path 的拒绝用例。
