# Feature 035: CLI Markdown Rendering (M6-04)

Status: `done`  
Type: `P1 ux`

## Goal

assistant 常返回 markdown，CLI 直接按 markdown 结构渲染（标题、列表、代码块等），减少“读起来像一坨纯文本”的体验问题。

## Design

- 新增轻量 markdown 渲染器（无第三方依赖）：
  - `looksLikeMarkdown`: 快速检测是否启用 markdown 渲染路径
  - `renderMarkdownLines`: 解析为终端行级语义
- 支持的块级元素：
  - heading / list / quote / code fence / rule / table-row / plain
- inline 规范化：
  - link: `[text](url)` -> `text <url>`
  - 去除常见强调与 inline code 包裹符号
- 失败回退：
  - 若非 markdown 内容，仍走原纯文本卡片。

## Implementation

- `src/cli/markdown.ts`
  - markdown 检测与行级渲染
- `src/cli/experience.ts`
  - `renderAssistantOutput` 自动分流 markdown/纯文本
  - 增加 markdown 卡片输出配色
  - `MERLION_CLI_MARKDOWN=0` 可关闭 markdown 渲染

## Token Policy

- markdown 渲染发生在 CLI 展示层，不改变模型侧消息，不增加上下文 token。

## Tests

- `tests/cli_markdown.test.ts`
  - 覆盖 markdown 检测、主要块级元素解析、inline link/inline code 处理
