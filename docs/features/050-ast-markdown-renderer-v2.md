# Feature 050: AST Markdown Renderer V2

Status: `done`  
Type: `P1 CLI UX`

## Goal

解决 CLI 中 assistant 输出“原始 Markdown 直出”的体验问题，重点去掉：

- 标题前缀 `###`
- 列表前缀 `-/*`
- 引用原始 `>`
- 代码围栏 ``` 直出

并在不牺牲稳定性的前提下，保留结构化语义（heading/list/quote/code/table）。

## Implementation

### Parser upgrade

- 将 `src/cli/markdown.ts` 从正则逐行解析升级为 `marked` AST 解析。
- 新增 block + inline 渲染函数：
  - inline：text/link/codespan/em/strong/image/html/escape/br
  - block：heading/paragraph/blockquote/list/list_item/code/hr/table

### Render behavior

- Heading：显示纯标题文本（不再保留 `#` 前缀）
- Unordered list：统一为 `•`
- Ordered list：保留数字序号（`1.`, `2.`）
- Blockquote：改为 `│` 左边栏样式
- Code block：输出 `code:<lang>` + 代码行，不显示 fenced markers
- Table：按列宽对齐后输出表格行（table tone）

### Safety & fallback

- 解析失败时回退为 plain line 渲染，避免 CLI 崩溃。
- 所有输出继续经过 `sanitizeRenderableText`。

## Files

- `src/cli/markdown.ts`
- `tests/cli_markdown.test.ts`
- `docs/todo.md`
- `docs/tracker.md`
- `package.json`
- `package-lock.json`

## Verification

- `node --experimental-strip-types --test tests/cli_markdown.test.ts tests/cli_message_content.test.ts`
- `npm test`
- `npm run typecheck`
