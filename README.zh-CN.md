# Merlion

[English](README.md)

一个能跑的 CLI coding agent，也是一份可以直接拿来读的代码。

做这个项目，不是为了和 Claude Code 比，也不是为了做一个覆盖面很大的产品。现在这类工具已经很多了。Merlion 要解决的不是“再做一个”，而是“把它做清楚”。

我想把一个 coding agent 拆开来看。上下文怎么组织，工具怎么接进来，session 怎么延续，一轮 verification 怎么回到主循环，这些事情在成熟产品里通常都被封装得很好。用的时候当然方便，但如果你想自己做一个，或者想认真理解它的结构，就会发现可参考的实现并不多。大的项目太重，读起来成本高；小的 demo 太轻，很多关键问题根本没有展开。

Merlion 想放在这两者之间。

## 里面有什么

- 一个完整的主循环，planning、tool execution、retry、guardrails、verification 都在里面
- 一套面向代码仓库的 context 系统：orientation、compact summary、path guidance，以及分层的 `AGENTS.md` 和 `MERLION.md`
- 一组够用的 builtin tools：文件、搜索、shell、git、config，还有基于 LSP 的编辑
- 两个入口：终端 REPL 是主入口，微信是额外接上的 transport
- 一些 bench 和回归测试，用来检查这个 runtime 现在还能不能正常工作

## 为什么做得这么薄

Merlion 有意不往“大而全”上走。

功能不是越多越好，抽象也不是越多越好。一个系统大到你只能理解局部的时候，阅读和学习这件事就会变得很被动。你不是在看它怎么工作，而是在试图穿过一层又一层包装。

所以这里的做法一直比较收：代码量控制在还能通读的范围，依赖能少就少，抽象能省就省，Node.js 起起来就能跑。产品层也尽量压薄，不去叠太多额外结构。

这样做的直接好处是，代码里看到的东西，大体就是系统真正依赖的东西。中间层少，判断也更容易落到具体实现上。

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
```

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

微信里没法做交互式审批，所以默认走 `--auto-allow`。如果你不想放开高风险工具，可以改成 `--auto-deny`。

## 它不是什么

它不是一个拿来和成熟产品分高下的项目。不是完整产品。不是稳定的 SDK。不是给不写代码的人准备的。也不是一个把关键决定都藏在黑盒里的系统。

它就是一个 runtime。能跑，能改，也能拿来说明一个 coding agent 大致是怎么长出来的。
