# Feature 058: Runtime Tool Loop Guardrails

Status: `done`  
Type: `P0 Runtime`

## Goal

降低模型在工具执行阶段“盲重试”和“建删来回振荡”导致的死循环风险。

## Spec

- 在 `runLoop` 的 tool batch 后增加两类自动防护：
  - `No progress`: 连续 N 个 tool batch 全失败时，插入强制重规划提示。
  - `Mutation oscillation`: 成功的文件变更操作出现互逆振荡（如 `create/delete` 同路径，`move A->B` 后 `move B->A`）时，插入刹车提示。
- 两类提示都应有次数上限，避免提示本身造成上下文膨胀。

## Implementation

- `src/runtime/loop.ts`
  - 新增连续全失败批次计数与提示注入（默认阈值 3，最多 2 次）。
  - 新增成功变更历史追踪与振荡检测提示（最多 2 次）。
  - 对工具参数进行轻量解析并做路径标准化后再判定振荡。

## Tests

- `tests/runtime_loop.test.ts`
  - 新增连续 3 批全失败后出现 `No progress detected` 提示。
  - 新增 `create_file -> delete_file` 同路径振荡触发提示。
