# Feature 036: CLI Render Pipeline Unification (M6-05)

Status: `done`  
Type: `P1 ux`

## Goal

把 assistant 输出从“分支渲染逻辑”改成统一内容管线，降低后续加新内容类型（artifact、diff 摘要、rich tool cards）的改动成本。

## Design

- 新增内容规划层 `buildAssistantRenderPlan`：
  - 输入：assistant 文本 + markdown 开关
  - 输出：`mode + lines(tone,text)`
- `CliExperience` 只负责“卡片框架 + tone 上色”，不关心 markdown 解析细节。
- 输入回显去重增强：
  - REPL 清理逻辑从“清上一行”升级为“清当前空行 + 清上一行输入”，减轻输入重复残留。

## Implementation

- `src/cli/message_content.ts`
  - 统一 assistant 渲染计划构建
- `src/cli/experience.ts`
  - `renderAssistantOutput` 改为统一 `printAssistantCard`
  - 新增 tone->color 映射函数
  - `clearTypedInputLine` 增强清理序列

## Tests

- `tests/cli_message_content.test.ts`
  - 覆盖 plain/markdown 分流与 tone 输出
