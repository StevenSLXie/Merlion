# Feature 075: Implicit Skill Activation And Policy

Status: `todo`
Type: `P1/P2 Skills`

## Goal

支持模型基于 skill catalog 隐式激活 skill，并补齐 policy / trust / token budget。

## Planned Scope

- system prompt 注入轻量 skill catalog
- 模型可调用 `activate_skill`
- trust boundary
- token budget
- compaction 后重附加策略

## Open Decisions

- implicit activation 是否默认开启
- project-local skill 的 trust policy
- skill 激活总预算与单 skill 上限
