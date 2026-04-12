# Feature 062: Shell Tool Exit Settlement for Background Processes

Status: `done`  
Type: `P0 Runtime/Tooling`

## Goal

修复 `bash`/脚本执行在“命令已启动后台进程并完成父进程退出”场景下的卡住问题，避免工具调用长期无返回。

典型复现场景：

- `node -e "setTimeout(()=>{},2000)" & echo started`
- `npm run dev` / `next dev` 这类会再派生进程的命令在超时或退出边缘场景下导致调用不结束

## Root Cause

现有实现只基于 `close` 事件 settle Promise。`close` 需要 stdio 句柄关闭；当后台子进程继承同一 stdio 时，父进程即使已 `exit`，`close` 仍可能延后甚至长期不触发。

## Implementation

- `src/tools/builtin/process_common.ts`
  - 以 `exit` 作为主要完成信号，`close` 作为补充兜底。
  - 超时后仍执行 TERM/KILL，但不再依赖 stdio 完整关闭才能返回。
- `src/tools/builtin/bash.ts`
  - `runBash` 同步采用 `exit` 优先 settle，避免后台继承 fd 导致挂起。
- `src/verification/runner.ts`
  - 校验命令执行路径同样改为 `exit` 优先，避免验证流程在类似场景卡住。

## Files

- `src/tools/builtin/process_common.ts`
- `src/tools/builtin/bash.ts`
- `src/verification/runner.ts`
- `tests/bash_tool.test.ts`
- `tests/process_common.test.ts`
- `tests/verification_runner.test.ts`

## Verification

- `node --experimental-strip-types --test tests/bash_tool.test.ts tests/process_common.test.ts tests/verification_runner.test.ts`
- `npm run typecheck`
