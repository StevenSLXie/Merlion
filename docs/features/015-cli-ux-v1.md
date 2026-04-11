# Feature 015: CLI UX V1 (Claude-like Interaction Baseline)

Status: `todo`  
Type: `P1 ux`

## Goal

把当前“纯文本回显”升级成可持续使用的开发者 CLI 交互体验，同时不引入重型依赖。

## Scope (Phase 1.5)

1. 状态区：
   - 连接/运行状态
   - 当前模型
   - token 累计
2. 工具执行可视化：
   - tool 开始/结束
   - 成功/失败标记
   - 关键参数摘要（如 path/command）
3. 输出可读性：
   - ANSI 控制符清理
   - 超长 token 断行（避免终端挤爆）

## Benchmark References (local code study)

- `openclaw/src/tui/components/chat-log.ts`
- `openclaw/src/tui/components/tool-execution.ts`
- `openclaw/src/tui/tui-event-handlers.ts`
- `openclaw/src/tui/tui-waiting.ts`
- `free-code-main/src/ink/*`（renderer/event 模式）

## Non-goals

- 本阶段不做完整 TUI 框架迁移
- 不做图形化 diff viewer
- 不做多 pane 布局

## Implementation Notes

- 在 `runLoop`/`executor` 增加轻量事件 hooks，CLI 负责渲染
- 先做 line-based renderer，后续再评估是否引入 TUI 库

## Exit Criteria

- 工具执行过程可见
- 会话状态有持续反馈
- 输出明显优于当前 baseline，且不影响自动化测试
