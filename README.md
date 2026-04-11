# Merlion

Merlion is a terminal coding agent focused on two goals:
- high coding quality (benchmarking Claude Code / Codex style workflows)
- lower token cost through practical context + tool design

## Quick Start (Recommended)

### Option A: Install from npm (recommended)

```bash
npm install -g merlion
export OPENROUTER_API_KEY=your_key_here
merlion --repl
```

If you prefer local install in a project:

```bash
npm install merlion
export OPENROUTER_API_KEY=your_key_here
npx merlion --repl
```

### Option B: Run from source

```bash
git clone https://github.com/StevenSLXie/Merlion.git
cd Merlion
npm install
export OPENROUTER_API_KEY=your_key_here
npm run merlion -- --repl
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

---

# Merlion（中文）

Merlion 是一个终端代码代理，核心目标是：
- 代码质量对标 Claude Code / Codex 这类工程化工作流
- 通过上下文与工具设计尽量节省 token，从而降低成本

## 快速开始（推荐）

### 方式 A：从 npm 安装（推荐）

```bash
npm install -g merlion
export OPENROUTER_API_KEY=your_key_here
merlion --repl
```

如果你更希望在项目内本地安装：

```bash
npm install merlion
export OPENROUTER_API_KEY=your_key_here
npx merlion --repl
```

### 方式 B：拉源码运行

```bash
git clone https://github.com/StevenSLXie/Merlion.git
cd Merlion
npm install
export OPENROUTER_API_KEY=your_key_here
npm run merlion -- --repl
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
