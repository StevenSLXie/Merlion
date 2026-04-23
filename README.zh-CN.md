# Merlion

[English](README.md)

一个能跑的 CLI coding agent，也是一份可以直接拿来读的代码。

Merlion 是按 reference implementation 来做的：体量收得住，但结构是完整的。context 怎么组织，工具怎么接进来，session 怎么延续，一轮 verification 怎么回到主循环，这些关键环节都在，而且都能顺着代码看明白。

Merlion 要解决的是两件事。第一，它虽然精简，但核心链路并不残缺；主循环、工具、context、guardrails、verification 这些都在，核心实现集中在少数几个文件里。第二，如果 Claude Code 和 Codex 这一类 coding agent 会极大改变软件开发，那我们需要一个 lightweight 的东西，帮助我们真正理解 coding agent 到底是什么，而不是只会使用一个黑盒。

## 里面有什么

- 一个完整的主循环，planning、tool execution、retry、guardrails、verification 都在里面
- 一套面向代码仓库的 context 系统：orientation、compact summary、path guidance，以及分层的 `AGENTS.md` 和 `MERLION.md`
- 一组够用的 builtin tools：文件、搜索、shell、git、config，还有基于 LSP 的编辑
- 一整套真实 sandbox 机制：子进程走 OS 级 sandbox backend，文件 / fetch / approval 走应用层 policy enforcement
- 两个入口：终端 REPL 是主入口，微信是额外接上的 transport
- 一些 bench 和回归测试，用来检查这个 runtime 现在还能不能正常工作

## 为什么做得这么薄

- Merlion 有意不往“大而全”上走，但会把 coding agent 的核心部件放全
- 代码量控制在还能通读的范围，阅读时不用先穿过很厚的产品层
- 本地 Node.js runtime，起起来就能跑，不依赖额外控制平面
- tool layer 够用且收敛，便于理解真实运行时到底靠什么工作
- 抽象有意收紧：中间层少，隐藏系统少，额外 ceremony 少

这里说的 lightweight，不是 demo，也不是阉割版；而是把系统收在一个还能被真正理解的尺度里。你在代码里看到的东西，大体就是这个 runtime 真正依赖的东西。

## 上手

Node.js 需要 `22` 以上。

```bash
npm install -g merlion
merlion
```

也可以装在项目里：

```bash
npm install merlion
npx merlion
```

第一次运行会让你设置 provider、API key 和 model。OpenAI-compatible 的接口都能接，自定义 base URL 也可以。

```bash
# 跑一次
merlion "读一下 src/index.ts，讲讲启动流程"

# 进交互
merlion

# 接上次没聊完的
merlion --resume <session-id>

# 回滚到某个 session 启动前的 git checkpoint
merlion undo <session-id>
```

CLI 默认是：

- `--sandbox workspace-write`
- `--approval on-failure`
- `--network off`

也就是：

- 默认允许改当前工作区
- 默认不允许外网访问
- 只有当命令因为 sandbox / policy 被挡住时，才请求放宽边界

常见覆盖方式：

```bash
# 严格只读
merlion --sandbox read-only --approval never

# 允许联网
merlion --network full

# 本地完全放开
merlion --sandbox danger-full-access --approval never
```

老参数还兼容：

- `--auto-allow` 等价于 `--approval never`
- `--auto-deny` 等价于 `--approval untrusted`

`bash` 和 `run_script` 这类会起子进程的工具，会真正跑进 sandbox backend。`read_file`、`write_file`、`edit_file`、`create_file` 这些文件工具虽然不是走 shell，但会在应用层执行同一套 policy，所以 `read-only`、`deny-read`、`deny-write` 仍然有效。`fetch` 也受 `--network` 约束。

## Sandbox 与审批

sandbox 是 Merlion 的核心 feature，不是后来补上的安全装饰。

Merlion 把两件事拆开：

- `sandbox`：执行边界
- `approval`：什么时候允许放宽边界

主要 sandbox mode：

- `read-only`：不允许文件修改
- `workspace-write`：只能改工作区或显式允许的可写目录
- `danger-full-access`：不做文件系统沙箱

approval policy：

- `untrusted`：拒绝升级
- `on-failure`：只有在 sandbox / policy 失败后才请求升级
- `on-request`：允许交互式升级
- `never`：不询问，始终停留在当前边界内

这套模型会贯穿整个 runtime：

- `bash` / `run_script` 走 sandbox backend
- 文件工具走同一套应用层 policy
- `fetch` 受 network policy 约束
- subagent 继承 parent 的 sandbox，但只能收窄，不能放宽
- WeChat 不支持运行中交互提权

另外，Merlion 会在可写 session 启动时创建 git checkpoint，并提供 `merlion undo <session-id>` 和 `/undo` 作为回滚路径。

## 从哪里开始读

如果你更关心它是怎么做出来的，建议从这些地方看起：

- `src/index.ts`：启动、配置、session 接线
- `src/runtime/loop.ts`：主循环
- `src/runtime/executor.ts`：模型回合和工具执行
- `src/runtime/query_engine.ts`：对话运行时
- `src/context/*`：上下文相关的几块
- `src/tools/*`：工具注册和内置工具
- `src/transport/wechat/*`：微信这条 transport

如果想先看整体图，可以去 [`docs/merlion_runtime_technical_overview.md`](docs/merlion_runtime_technical_overview.md)。

## 微信

Merlion 可以接到微信上，把微信当成 agent 的消息入口。

第一次要登录：

```bash
merlion wechat --login
```

之后直接：

```bash
merlion wechat
```

在 REPL 里也可以，敲 `:wechat` 或 `/wechat`。

凭据放在 `~/.config/merlion/wechat.json`。

默认只回最终结果和简短错误，不会推内部工具日志。想看进度，可以设 `MERLION_WECHAT_PROGRESS=1`；想看更细一点的进度，可以设 `MERLION_WECHAT_PROGRESS_VERBOSE=1`。

微信里没法做交互式审批，所以 WeChat session 固定走 `approval=never`。默认 sandbox 是 `workspace-write`，也就是默认允许改当前工作区，但不能在运行中临时提权。如果你想换边界，可以在启动时显式指定：

```bash
# 更保守
merlion wechat --sandbox read-only

# 完全放开
merlion wechat --sandbox danger-full-access
```

## 它不是什么

它不是一个产品对标项目，而是一个拿来阅读、运行、修改的 runtime。不是去复刻成熟 agent 工具的全部产品层。不是稳定 SDK。不是优先面向非技术用户的入口。也不是一个把关键决定都藏进黑盒里的系统。

它就是一个 runtime。能跑，能改，也能比较完整地说明一个 coding agent 大致是怎么长出来的。
