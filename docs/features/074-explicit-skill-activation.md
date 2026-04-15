# Feature 074: Explicit Skill Activation

Status: `todo`
Type: `P1 Skills`

## Goal

支持显式 skill 激活：

- 用户输入 `/some-skill`
- runtime 激活 skill
- skill 进入当前会话上下文

## Planned Scope

- `activate_skill` 专用工具
- skill body 作为按需注入内容，而不是 session 启动全量注入
- 同一 session 同名 skill 去重

## Open Decisions

- 是否直接用 `/some-skill` 作为唯一入口，还是同时支持 `/skills some-skill`
- skill 激活后是否显示显式提示
- 激活后的 skill 内容是否包裹 `<skill>` tag
