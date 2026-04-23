# 100 Local Sandbox Modes And Approval Policy

Status: `proposed`  
Type: `P1 Runtime Security`

## Goal

为 Merlion 增加第一版**本地真实 sandbox**，把当前“permission gate + workspace path guard”的安全模型升级为：

1. 明确区分 `sandbox_mode` 和 `approval_policy`
2. 对 shell / process 类工具施加真实执行边界
3. 让 main runtime、subagent、WeChat 共用同一套权限语义
4. 保留 `danger-full-access` 作为显式无 sandbox 模式
5. 用应用层 fs 闸门补齐 `read-only` 语义
6. 用 git checkpoint + undo 提供本地回滚兜底

这份 spec 的目标不是做远端执行平台，也不是做 microVM；目标是把 Merlion 做成一个本地 CLI coding agent 应有的 sandbox 形态。

## External Reference Points

### Codex Sandboxing Model

Codex 官方文档明确把两件事拆开：

- `sandbox mode`: 技术边界
- `approval policy`: 是否为越界动作请求确认

并使用稳定、可解释的几档模式：

- `read-only`
- `workspace-write`
- `danger-full-access`

以及独立的 approval 语义：

- `untrusted`
- `on-failure`
- `on-request`
- `never`

Merlion 本次设计直接对齐这个概念模型。

其中：

- `on-failure` 是 Merlion 在该双轴模型上的本地 UX 扩展
- 它不改变 sandbox / approval 分离这一核心结构

Reference:

- <https://developers.openai.com/codex/concepts/sandboxing>

### free-code / sandbox-runtime Lessons

`free-code` 的价值不在 UI，而在于它已经证明：

1. shell sandbox 应是 runtime first-class primitive
2. permission rules 可以映射成 filesystem / network sandbox config
3. sandbox 与 permission prompt 不应混成一个概念

Merlion 不会照搬其复杂系统，但会吸收这些结构性经验。

References:

- <https://github.com/paoloanzn/free-code/blob/main/src/tools/BashTool/shouldUseSandbox.ts>
- <https://github.com/paoloanzn/free-code/blob/main/src/utils/sandbox/sandbox-adapter.ts>
- <https://github.com/paoloanzn/free-code/blob/main/src/utils/permissions/permissions.ts>

### Non-Reference: zeroboot

`zeroboot` 不纳入本 spec 的 backend 选型。

原因：

- 它更像 remote microVM snippet executor，不是本地 workspace agent sandbox
- Linux/KVM/Firecracker 前提过重
- 当前 fork 明确缺少 networking
- 不适合作为 Merlion 默认本地执行主线

Reference:

- <https://github.com/zerobootdev/zeroboot>

## Why Now

Merlion 当前已有：

- `permissionMode`
- 文件工具 workspace path guard
- `bash` 风险命令 warn/block
- subagent tool allowlists

但这些仍然不是 sandbox。

当前缺口在于：

1. `bash` / `run_script` 仍在宿主环境直接执行
2. `permissionMode` 同时承担“审批”和“安全边界”的语义，概念混乱
3. WeChat / subagent 还没有统一到一套能力边界模型
4. 文件工具和 shell 工具之间的安全语义并不一致

如果不补这层，Merlion 后续越往 coding-agent 方向走，风险会越大：

- 更多 shell 验证
- 更多自动修复
- 更多 subagent delegation
- 更多长会话自治

## Current State

### What Exists Today

- [src/bootstrap/cli_args.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/bootstrap/cli_args.ts:1)
  - `permissionMode = interactive | auto_allow | auto_deny`
- [src/permissions/store.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/permissions/store.ts:1)
  - 交互式 allow / deny / allow_session
- [src/tools/builtin/fs_common.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/tools/builtin/fs_common.ts:1)
  - workspace boundary 校验
- [src/tools/builtin/bash.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/tools/builtin/bash.ts:1)
  - 风险模式检查后直接 `spawn('bash', ...)`
- [src/tools/builtin/run_script.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/tools/builtin/run_script.ts:1)
  - 在宿主环境直接 `npm run`
- [src/runtime/subagents.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/runtime/subagents.ts:1)
  - 角色工具白名单
- [src/transport/wechat/run.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/transport/wechat/run.ts:1)
  - 目前把 WeChat 简化为 `auto_allow` / `auto_deny`

### What Does Not Exist Yet

- 真正的 sandbox backend abstraction
- `read-only / workspace-write / danger-full-access`
- `approval_policy`
- filesystem deny/allow policy 对 shell 的强制执行
- deny-by-default shell network enforcement
- WeChat / subagent 统一继承 sandbox policy

## Design Principles

1. **Sandbox and approval are separate concepts.**
2. **Shell/process execution is the first-class enforcement point.**
3. **Default behavior should remain practical for coding work.**
4. **Subagents may inherit or narrow policy, never widen it.**
5. **WeChat may run with high privilege, but never with interactive escalation.**
6. **No remote backend in this feature.**
7. **No Docker-first architecture.**
8. **Path validation remains useful, but it is not the sandbox.**
9. **If a capability cannot be enforced cleanly, the spec should not pretend it exists.**

## Non-Goals

- 不做 remote backend
- 不做 Docker backend
- 不做 zeroboot / Firecracker / microVM
- 不在这一版把所有文件工具迁入 sandbox 进程内执行
- 不做 Windows 原生 backend
- 不做复杂 policy DSL
- 不在这一版做 GUI permission dialog redesign

## User-Facing Model

### 1. Sandbox Mode

新增：

```ts
type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
```

语义：

- `read-only`
  - shell/process 只能读，不能写工作区
  - 默认不能联网
- `workspace-write`
  - shell/process 可写当前工作区
  - 可额外开放显式 `writable_roots`
  - 默认不能联网
- `danger-full-access`
  - 不使用 sandbox backend
  - 保持当前宿主执行能力

### 2. Approval Policy

新增：

```ts
type ApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
```

语义：

- `untrusted`
  - 对需要更高权限或越界的动作直接拒绝
- `on-failure`
  - 先在当前 sandbox 内执行
  - 若因 sandbox/policy 拒绝而失败，再请求交互升级
- `on-request`
  - 可以为需要升级的动作请求交互确认
- `never`
  - 不弹交互；要么在当前策略内执行，要么失败

### 3. Network Mode

新增：

```ts
type NetworkMode = 'off' | 'full'
```

语义：

- `off`
  - shell/process 默认不可联网
- `full`
  - 不限制网络

说明：

- `allowlist` 不进入本 feature
- 若未来需要域名级网络策略，应单独走 proxy / broker 子系统

## Configuration Model

新增统一配置：

```ts
export interface MerlionSandboxConfig {
  sandboxMode?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  writableRoots?: string[]
  denyRead?: string[]
  denyWrite?: string[]
  networkMode?: NetworkMode
}
```

建议合入：

- [src/config/store.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/config/store.ts:1)
- [src/bootstrap/config_resolver.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/bootstrap/config_resolver.ts:1)

### Default Values

CLI 默认：

- `sandboxMode = workspace-write`
- `approvalPolicy = on-failure`
- `networkMode = off`

WeChat 默认：

- `sandboxMode = workspace-write`
- `approvalPolicy = never`
- `networkMode = off`

Subagent 默认：

- parent-derived, then role-narrowed

### CLI Surface

新增：

- `--sandbox <read-only|workspace-write|danger-full-access>`
- `--approval <untrusted|on-failure|on-request|never>`
- `--network <off|full>`
- `--allow-write <path>` 可重复
- `--deny-read <path>` 可重复
- `--deny-write <path>` 可重复

兼容迁移：

- `--auto-allow` -> `--approval never`
- `--auto-deny` -> `--approval untrusted`

旧参数可保留一个兼容周期，但帮助文本应转向新模型。

## Runtime Architecture

### New Modules

新增目录：

- `src/sandbox/types.ts`
- `src/sandbox/policy.ts`
- `src/sandbox/backend.ts`
- `src/sandbox/no_sandbox.ts`
- `src/sandbox/bwrap.ts`
- `src/sandbox/macos.ts`
- `src/sandbox/resolve.ts`

### Core Interface

```ts
export interface SandboxCommand {
  command: string
  argv?: string[]
  cwd: string
  timeoutMs: number
}

export interface SandboxViolation {
  kind: 'fs-read' | 'fs-write' | 'network' | 'policy' | 'backend'
  detail: string
}

export interface SandboxRunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  violation?: SandboxViolation
}

export interface SandboxBackend {
  name(): string
  isAvailable(): Promise<boolean>
  run(command: SandboxCommand, policy: ResolvedSandboxPolicy): Promise<SandboxRunResult>
}
```

### Policy Resolution

需要一个 runtime-resolved policy：

```ts
export interface ResolvedSandboxPolicy {
  mode: SandboxMode
  approvalPolicy: ApprovalPolicy
  cwd: string
  writableRoots: string[]
  denyRead: string[]
  denyWrite: string[]
  networkMode: NetworkMode
}
```

`resolveSandboxPolicy()` 负责：

1. 把 CLI / config / defaults 合并
2. 归一化相对路径到绝对路径
3. 自动加入 cwd 到 `writableRoots` when `workspace-write`
4. 加入 runtime 固定保护路径
5. 为 child runtime 派生 narrowed policy
6. 为应用层 fs gate 生成同语义的 allow/deny 视图

## Backend Selection

### Linux / WSL

首选 backend：

- `bubblewrap`

原因：

- 用户态可用
- 对本地 CLI coding agent 成本低
- 适合 `read-only` / `workspace-write`
- 比 Docker 更贴近 Codex-style local sandbox

### macOS

首选 backend：

- Seatbelt / `sandbox-exec` 风格 backend

要求：

- 封装为与 Linux 相同的 `SandboxBackend`
- 提供 filesystem/network policy enforcement
- 若宿主环境能力有限，应 fail closed，不 silently downgrade

### Fallback

对于：

- `danger-full-access`
- backend unavailable 且 mode 本就要求无 sandbox

使用：

- `NoSandboxBackend`

对于：

- `read-only`
- `workspace-write`

若 backend unavailable：

- CLI / WeChat 启动失败
- 不允许 silently 降为宿主直跑

### Future Linux Expansion Point

虽然 Linux v1.5 首选 `bubblewrap`，但 backend interface 必须允许未来增加：

- `LandlockSandboxBackend`

原因：

- 某些环境里 `bubblewrap` 可用性受限
- Landlock 更接近内核级路径约束能力
- 这不进入本 feature 的实现范围，但不应被接口设计堵死

## Enforcement Scope

### In Scope For This Feature

必须接入 sandbox 的工具：

- [src/tools/builtin/bash.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/tools/builtin/bash.ts:1)
- [src/tools/builtin/run_script.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/tools/builtin/run_script.ts:1)

以及未来所有：

- 直接 `spawn` 子进程的 built-in 工具

### Out Of Scope For This Feature

以下工具继续保留当前 guardrail：

- `read_file`
- `write_file`
- `edit_file`
- `create_file`
- `delete_file`
- 其他直接通过 Node fs API 操作的文件工具

注意：

这不是说文件工具不重要，而是本次 feature 的技术边界首先要兜住“最危险的宿主 shell 路径”。

## Application-Layer Filesystem Gate

仅有 shell sandbox 还不够，因为 Merlion 仍有大量直接通过 Node fs API 生效的工具：

- `write_file`
- `edit_file`
- `create_file`
- `delete_file`
- `move_file`
- `copy_file`
- `mkdir`
- `append_file`

因此本 feature 必须同步增加应用层 fs gate。

### Rule

所有文件类 mutation tool 在真正写入前，都必须经过统一 policy 检查：

- `read-only` 下直接拒绝所有 mutation
- `workspace-write` 下仅允许：
  - cwd
  - `writableRoots`
  - 且不得命中 `denyWrite`
- `danger-full-access` 下保持现状

### Scope

这层 gate 不替代现有：

- workspace path validation
- placeholder / malformed path validation

而是在它们之上再加一层与 sandbox 对齐的 policy enforcement。

### Why This Is Required

没有这层，`read-only` 只对 shell 成立，不对文件工具成立；这会让产品语义出现明显漏洞。

## Filesystem Policy

### Default Rules

#### `read-only`

- cwd 可读
- cwd 不可写
- `writableRoots = []`

#### `workspace-write`

- cwd 可读写
- `writableRoots` 追加允许路径
- `denyWrite` 覆盖 allow

#### `danger-full-access`

- 无 sandbox filesystem enforcement

### Protected Paths

无论哪种 mode，只要 backend 生效，默认 deny 写这些控制面路径：

- Merlion config dir
- 当前会话 transcript / usage / state control files
- `.merlion/` 下的 runtime control files

说明：

- 这类路径不应被 shell 命令随意改写
- 文件工具是否允许改写可另行定义；本 feature 只定义 shell sandbox

### Resolution Rules

- `denyWrite` 优先级高于 `writableRoots`
- `denyRead` 可阻断敏感文件读取
- 所有路径在 runtime 进入 backend 前必须被归一化为绝对路径

## Network Policy

### Default

所有 sandboxed mode 默认：

- `networkMode = off`

### Full

仅在显式配置下启用：

- `networkMode = full`

## Approval Semantics

### Core Rule

approval 只处理**策略升级**，不处理“普通命令是否能执行”。

也就是：

1. 命令在当前 sandbox 内可执行 -> 直接执行
2. 命令需要超出当前 sandbox -> 进入 approval decision

### Upgrade Cases

典型升级包括：

- `read-only` 会话试图写文件
- `workspace-write` 会话试图写 protected path / non-writable root
- `networkMode=off` 会话试图联网
- 任何模式试图请求 `danger-full-access`

### Policy Behavior

#### `untrusted`

- 直接拒绝升级

#### `on-failure`

- 命令先按当前 sandbox 执行
- 若失败原因为 sandbox violation / policy denial，并且存在可行 widening path，则再请求交互确认
- 不因为普通业务失败、测试失败、脚本 exit code 非零而触发 approval

#### `on-request`

- 可以交互提示用户批准一次或本 session
- 批准结果应转换为更宽的 **effective policy**
- 但 widening 只影响当前 runtime / session，不回写全局 config

#### `never`

- 不交互
- 越界动作直接失败

## Permission Store Migration

当前的 [src/permissions/store.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/permissions/store.ts:1) 不再代表安全边界，只代表 approval UI / memory。

迁移后：

- `PermissionStore` 保留，但语义收缩为 approval store
- sandbox enforcement 进入独立 `src/sandbox/*`

说明：

- 不重命名 `PermissionStore`
- 避免一次性引入全仓 API rename 噪音

## Tool Context Changes

[src/tools/types.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/tools/types.ts:1) 需要扩展：

```ts
export interface ToolContext {
  cwd: string
  sessionId?: string
  permissions?: PermissionStore
  sandbox?: {
    policy: ResolvedSandboxPolicy
    backend: SandboxBackend
  }
  ...
}
```

这样 shell/process 工具可以拿到：

- 当前 effective policy
- 当前 backend

## `bash` Tool Changes

[src/tools/builtin/bash.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/tools/builtin/bash.ts:1) 的改动原则：

1. 保留 command normalization
2. 保留 warn/block high-risk heuristics
3. 实际执行不再直接 `spawn('bash', ...)`
4. 改为 `ctx.sandbox.backend.run(...)`

### Role Of Existing Bash Guards

现有：

- `WARN_PATTERNS`
- `BLOCK_PATTERNS`

在新模型中仍有价值，但角色改变为：

- UX / policy guardrail
- 模型纠偏
- 明显破坏性命令快速拒绝

不是最终安全边界。

## `run_script` Changes

[src/tools/builtin/run_script.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/tools/builtin/run_script.ts:1) 也必须改为统一走 sandbox backend。

理由：

- `npm run` 最终还是 shell/process 执行
- 如果只 sandbox `bash`，但 `run_script` 仍宿主执行，模型会绕路

## Runner Integration

[src/runtime/runner.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/runtime/runner.ts:1) 负责：

1. 解析 sandbox / approval config
2. 创建 backend
3. 创建 approval store
4. 注入 runtime / QueryEngine / local turn

新增运行时选项：

```ts
interface CliRuntimeOptions {
  ...
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalPolicy
  networkMode: NetworkMode
  writableRoots: string[]
  denyRead: string[]
  denyWrite: string[]
}
```

## Git Checkpoint And Undo

本 feature 在 Phase 1 必须同步增加最小回滚兜底：

- `git checkpoint`
- `undo`

### Goal

这不是 sandbox 的一部分，而是本地 coding-agent 在高权限执行下的恢复兜底。

它尤其覆盖：

- macOS backend 落地前的过渡期
- `danger-full-access`
- `workspace-write` 下的用户误授权

### Minimum Behavior

1. 在 git repo 中，首次进入可能产生 mutation 的 agent 执行前，runtime 可创建一次 lightweight checkpoint
2. checkpoint 必须是可恢复、可枚举的
3. runtime / CLI 必须提供明确的 undo 路径
4. checkpoint 不应污染正常开发分支语义

实现形态可后续细化，但这项不应等 Phase 4 再补。

## Subagent Policy

[src/runtime/subagents.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/runtime/subagents.ts:1) 需要从“工具 allowlist”升级到“工具 allowlist + sandbox policy narrowing”。

### Parent Rule

child 只能：

- 继承 parent policy
- 或收窄 parent policy

不能：

- 放宽 parent policy

### Role Defaults

#### `explorer`

- 强制 `sandboxMode = read-only`
- 强制 `approvalPolicy = never`
- `networkMode = off` by default

#### `verifier`

- 默认 `sandboxMode = read-only`
- 强制 `approvalPolicy = never`
- `networkMode = off` by default

#### `worker`

- 继承 parent sandbox mode
- 可被 runtime 显式收窄
- 若为 background worker，强制 `approvalPolicy = never`

### Why Tool Allowlist Still Stays

subagent 的工具白名单依旧保留，因为：

- sandbox 控制的是执行边界
- tool allowlist 控制的是能力面

这两层是互补关系，不是替代关系。

## WeChat Policy

[src/transport/wechat/run.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/transport/wechat/run.ts:1) 需要重写其权限模型。

### Rules

- WeChat 不支持 interactive approval
- WeChat 必须运行在 `approvalPolicy = never`
- 默认 `sandboxMode = workspace-write`
- 允许显式配置：
  - `read-only + never`
  - `workspace-write + never`
  - `danger-full-access + never`

### Runtime Behavior

若某命令超出当前 WeChat session sandbox：

- 不弹交互
- 直接返回明确错误

例如：

- `current WeChat session policy does not permit this command`

这符合 WeChat 的异步消息面现实：可以高权限启动，但不能运行中交互提权。

## Sandbox Audit Events

为避免 sandbox 成为黑箱，本 feature 需要新增 audit 事件。

建议事件：

- `sandbox.backend.selected`
- `sandbox.command.started`
- `sandbox.command.completed`
- `sandbox.violation`
- `sandbox.escalation.requested`
- `sandbox.escalation.denied`
- `sandbox.escalation.allowed`

每条事件至少包含：

- session id
- backend name
- sandbox mode
- approval policy
- tool name
- command summary
- violation kind if present

这些事件首先用于：

- 调试
- e2e 断言
- 用户解释“为什么没跑成”

## Context / Trust Policy Migration

[src/context/service.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/context/service.ts:1) 和 [src/context/policies.ts](/Users/xieshuanglong/Documents/Code/Merlion/src/context/policies.ts:1) 当前将 `permissionMode` 映射为 trust level。

迁移后应改为基于：

- `sandboxMode`
- `approvalPolicy`

建议：

- `danger-full-access` -> `trusted`
- `workspace-write` -> `trusted`
- `read-only` + `untrusted|never` -> `untrusted` or `restricted`

具体 trust taxonomy 可继续沿用现有最小版本，但不得继续依赖 `permissionMode`。

## Error Surface

需要新增统一错误语义：

- backend unavailable
- sandbox violation
- policy escalation denied
- network blocked
- protected path blocked

要求：

- 用户能区分“命令失败”与“sandbox 拒绝”
- 模型也能收到足够清晰的工具错误，知道该换策略或请求更宽权限

## Rollout Plan

### Phase 1

- 新增 config / CLI 参数
- 新增 `src/sandbox/*`
- 接 `NoSandboxBackend`
- 应用层 fs gate
- git checkpoint + undo
- 保持 `PermissionStore` 原名

### Phase 2

- Linux / WSL `bubblewrap`
- `bash` / `run_script` 接入
- CLI / REPL 主链路跑通
- sandbox audit 事件

### Phase 3

- subagent policy narrowing
- WeChat policy cutover
- trust policy migration

### Phase 4

- macOS backend
- live e2e validation

## Files

### New

- `src/sandbox/types.ts`
- `src/sandbox/policy.ts`
- `src/sandbox/backend.ts`
- `src/sandbox/no_sandbox.ts`
- `src/sandbox/bwrap.ts`
- `src/sandbox/macos.ts`
- `src/sandbox/resolve.ts`

### Existing

- `src/bootstrap/cli_args.ts`
- `src/bootstrap/config_resolver.ts`
- `src/config/store.ts`
- `src/index.ts`
- `src/runtime/runner.ts`
- `src/runtime/subagents.ts`
- `src/context/service.ts`
- `src/context/policies.ts`
- `src/tools/types.ts`
- `src/tools/builtin/bash.ts`
- `src/tools/builtin/run_script.ts`
- `src/transport/wechat/run.ts`
- `src/permissions/store.ts`
- `src/tools/builtin/fs_common.ts`
- `src/runtime/events.ts`
- `src/runtime/session.ts`

## Acceptance Criteria

### Config / UX

1. CLI 能显式设置 `sandbox_mode`、`approval_policy`、`network_mode`
2. `--auto-allow` / `--auto-deny` 仍可兼容，但帮助文本转向新参数
3. backend 不可用时，`read-only` / `workspace-write` 启动 fail closed

### Enforcement

4. `read-only` 下真实 `bash` 无法修改 cwd
5. `workspace-write` 下真实 `bash` 只能写 cwd 与显式 `writable_roots`
6. `denyWrite` 能覆盖允许根
7. `networkMode=off` 下 shell 无法联网
8. `run_script` 不再绕过 sandbox
9. `read-only` 下所有文件 mutation tool 都 fail closed
10. `workspace-write` 下文件 mutation tool 与 shell 共享同一写策略

### Runtime Integration

11. `explorer` child 无法写文件
12. `verifier` child 默认不可写
13. child 不能放宽 parent sandbox
14. background child 不会进入 interactive approval
15. WeChat 不支持 interactive approval，但默认可写 workspace
16. `on-failure` 只在 sandbox/policy 失败后请求升级，不因普通命令失败触发
17. sandbox audit 事件能覆盖 backend 选择、执行、violation、escalation

### Validation

18. `tsc --noEmit` 通过
19. 全量 `npm test` 通过
20. 至少 5 个真实 LLM e2e 在 `workspace-write` 下通过
21. 至少 1 个真实 LLM e2e 在 `read-only` 下正确 fail closed
22. git checkpoint + undo 具备最小可用性

## Open Questions

1. macOS backend 最终是直接封装 `sandbox-exec`，还是用更现代的 Seatbelt wrapper
2. `.merlion/` 哪些路径属于“shell 默认 deny 写”保护面
3. approval widening 是否允许“session remember”以及其持久范围
4. git checkpoint 的最小实现是 stash-like、commit-like，还是 patch artifact
5. Linux Landlock backend 是否在后续版本进入正式支持

## Decision Summary

这份 spec 的核心决策是：

1. Merlion 采用 `sandbox_mode + approval_policy` 的双层模型
2. 默认走本地 backend，不做远端执行
3. 优先保护 shell/process execution path
4. `read-only` 语义必须由应用层 fs gate 一起兜住
5. WeChat 默认允许 workspace 写，但不允许交互提权
6. `on-failure` 成为默认 approval 体验
7. subagent 继承并收窄权限边界

这会把 Merlion 从“有权限提示的 agent”推进到“有真实本地执行边界的 agent”。
