# Feature 057: Interactive Permission Tri-State And Session Remember

Status: `done`  
Type: `P0 UX/runtime`

## Goal

把交互式权限审批从二元 `yes/no` 升级为三态：

1. `yes`（本次允许）
2. `no`（本次拒绝）
3. `yes and do not ask again for the same request in this session`

减少同一请求反复弹窗，降低工具循环期间的用户打断。

## Spec

- 仅在 `interactive` 模式生效；`auto_allow/auto_deny` 行为保持不变。
- “same request” 定义为：`tool + description` 完全一致（trim 后）。
- 命中“remember”缓存时，直接返回 `allow_session`，不再次读取 stdin。
- CLI 提示必须显式展示三行选项，避免用户不知道存在 remember 模式。

## Implementation

- `src/permissions/store.ts`
  - 新增 `PermissionPromptIo` 抽象，便于注入测试 IO。
  - 交互提示升级为三行选项，支持 `y/n/a`（兼容 `1/2/3`）。
  - 增加会话内 `Set` 缓存，命中同请求后直接 `allow_session`。

## Tests

- `tests/permissions_store.test.ts`
  - 覆盖 `auto_allow/auto_deny`
  - 覆盖 `y/n/a` 三态
  - 覆盖同请求 remember 缓存不重复询问
