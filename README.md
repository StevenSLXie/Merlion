# Merlion

Merlion is a terminal coding agent focused on two goals:
- high coding quality (benchmarking Claude Code / Codex style workflows)
- lower token cost through practical context + tool design
- provider-agnostic OpenAI-compatible runtime (`openrouter` / `openai` / custom URL)

## Quick Start (Recommended)

### Option A: Install from npm (recommended)

```bash
npm install -g merlion
# first run will guide provider/key/model setup interactively
merlion --repl
```

If you prefer local install in a project:

```bash
npm install merlion
# first run will guide provider/key/model setup interactively
npx merlion --repl
```

### Option B: Run from source

```bash
git clone https://github.com/StevenSLXie/Merlion.git
cd Merlion
npm install
# first run will guide provider/key/model setup interactively
npm run merlion -- --repl
```

Optional non-interactive env configuration:

```bash
export MERLION_PROVIDER=openrouter   # openrouter | openai | custom
export MERLION_API_KEY=your_key_here
export MERLION_MODEL=qwen/qwen3-coder
export MERLION_BASE_URL=https://openrouter.ai/api/v1
merlion --repl
```

## Common Usage

```bash
# one-shot task
merlion "read src/index.ts and summarize architecture"

# interactive mode
merlion --repl

# continue previous session
merlion --resume <session-id>
```

## AGENTS Map Automation

Merlion supports layered `AGENTS.md` maps with commit-time auto maintenance.

```bash
# enable repository hooks once
npm run hooks:install

# update AGENTS AUTO blocks from staged files
npm run agents:update:staged

# validate AGENTS contract (MANUAL/AUTO markers + required auto fields)
npm run agents:lint
```

---

# Merlion（中文）

Merlion 是一个终端代码代理，核心目标是：
- 代码质量对标 Claude Code / Codex 这类工程化工作流
- 通过上下文与工具设计尽量节省 token，从而降低成本
- 支持 OpenAI-compatible provider（`openrouter` / `openai` / 自定义 URL）

## 快速开始（推荐）

### 方式 A：从 npm 安装（推荐）

```bash
npm install -g merlion
# 首次运行会交互引导 provider/key/model 配置
merlion --repl
```

如果你更希望在项目内本地安装：

```bash
npm install merlion
# 首次运行会交互引导 provider/key/model 配置
npx merlion --repl
```

### 方式 B：拉源码运行

```bash
git clone https://github.com/StevenSLXie/Merlion.git
cd Merlion
npm install
# 首次运行会交互引导 provider/key/model 配置
npm run merlion -- --repl
```

也可以用环境变量非交互配置：

```bash
export MERLION_PROVIDER=openrouter   # openrouter | openai | custom
export MERLION_API_KEY=your_key_here
export MERLION_MODEL=qwen/qwen3-coder
export MERLION_BASE_URL=https://openrouter.ai/api/v1
merlion --repl
```

## 常用命令

```bash
# 单次任务
merlion "read src/index.ts and summarize architecture"

# 进入交互模式
merlion --repl

# 恢复历史会话
merlion --resume <session-id>
```

## AGENTS 地图自动维护

Merlion 支持分层 `AGENTS.md` 地图，并可在提交时自动更新 `AUTO` 区块。

```bash
# 首次启用仓库 hooks
npm run hooks:install

# 根据 staged 改动更新 AGENTS AUTO 区块
npm run agents:update:staged

# 校验 AGENTS 协议（MANUAL/AUTO 标记 + 必填自动区块）
npm run agents:lint
```
