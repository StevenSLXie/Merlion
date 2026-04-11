# Feature 024: Orientation Assembly (M4-06)

Status: `done`  
Type: `P0 context engine`

## Goal

在新会话首轮注入稳定的项目导向上下文，避免“每次从零摸仓库”。

## Inputs

- AGENTS guidance（M4-03）
- progress artifact（M4-04）
- codebase index（M4-05）

## Assembly Rules

1. 固定顺序：`AGENTS -> Progress -> Codebase Index`
2. 预算控制：
   - 默认总预算：1200 tokens
   - section 预算：500/300/400
3. 超预算按优先级截断低优先 section（先裁 index，再 progress）

## Runtime Integration

- 仅新会话注入（`--resume` 不重复注入）
- 作为系统消息附加在基础 system prompt 之后
- 将该消息写入 transcript，确保 resume 行为一致

## Test Plan

- 组装结果包含三个 section 且顺序正确
- 预算约束生效
- 空仓库/缺文件场景可用（非失败）

## Exit Criteria

- 新会话首轮具备 orientation 注入
- 单测与 typecheck 通过
