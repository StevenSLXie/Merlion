# Feature 020: Rich CLI Experience (Free-code style)

Status: `done`  
Type: `P1 ux`

## Goal

把 CLI 从“日志输出器”升级为“终端产品界面”：

- 会话 Banner（模型/会话/模式）
- turn 级动态状态（spinner）
- tool 执行事件（start/result + duration）
- user/assistant 卡片式消息
- REPL 自定义渲染钩子（输入与输出分离）

## Implementation

- `src/cli/experience.ts`
  - 统一渲染层（颜色、卡片、spinner、token 状态）
- `src/index.ts`
  - 全面接入渲染层（one-shot + repl）
- `src/cli/repl.ts`
  - 新增 `onPromptSubmitted` / `onTurnResult` / `startupMessage` 扩展点

## Tests

- `tests/repl.test.ts`
  - 覆盖自定义 turn renderer hooks
- 其余 runtime/executor/cli 渲染测试保持通过

## Notes

这版是“高视觉密度”的终端体验基础层。下一步若要继续贴近 free-code，可再做：

- 全屏 TUI 布局（固定 header/footer + 可滚动消息区）
- tool 输出折叠/展开
- model/context 占用实时进度条
