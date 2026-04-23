# How Sandboxing Actually Works in a Coding Agent

The first time people hear "sandbox" in the context of a coding agent, they often think it just means "the agent is somewhat restricted." That is too vague to be useful.

A sandbox is not a vibe. It is an execution boundary.

It says: if the agent runs a command, where can that command read, where can it write, and can it reach the network at all? If the answer depends only on the model behaving well, you do not really have a sandbox. You have a policy request.

That distinction matters because coding agents are unusual systems. We are asking a language model to inspect source code, run tools, edit files, and sometimes execute arbitrary shell commands. That is exactly the sort of system where "please be careful" is not a serious security story.

If you want an agent to be autonomous enough to do real work, you need two things at the same time:

1. a policy layer that decides what the agent should be allowed to attempt
2. an enforcement layer that makes sure a bad decision does not immediately become a full system compromise

That second layer is what sandboxing is for.

## What a sandbox is

In plain English, a sandbox is a set of hard boundaries around a process.

For a coding agent, the important boundaries are usually:

- filesystem access
- network access
- process execution and child-process behavior

If the agent runs `npm test`, a real sandbox can decide whether that command may write only inside the current repository, whether it may read some protected path, and whether it may open outbound connections. If the command tries to step outside those boundaries, the operating system blocks it.

That last sentence is the important part.

The model does not need to notice the problem first. The runtime does not need to parse the command perfectly first. The command simply fails because the boundary is enforced underneath it.

That is why sandboxing matters in agent systems more than it does in ordinary CLIs. A normal CLI is used directly by a human who already intends to run a command. A coding agent is a system that proposes commands, revises them, retries them, and sometimes receives adversarial or misleading input through the codebase itself. The chance of accidental overreach is much higher.

## Why permission prompts are not enough

A lot of early agent systems started with a simpler model: ask the user before risky actions.

That helps, but it breaks down quickly.

First, constant prompting is tiring. If the user has to approve every shell command, they stop reading carefully. The interface still looks safe, but the human part of the control loop gets weaker over time.

Second, prompts only help before execution. Once a command is approved and launched, a prompt system by itself does not stop that process from reading or writing more than expected.

Third, approval logic lives at the same level as the rest of the runtime. If the runtime makes a bad classification, or if the model finds a way to route around a specific check, the protection can disappear all at once.

This is why modern coding-agent systems increasingly treat sandboxing and policy as separate layers instead of one combined feature.

## Sandbox vs. policy control

This is the distinction I think is worth making explicit.

Policy control answers questions like:

- Should this tool be allowed at all?
- Should this file be readable?
- Should this write require approval?
- Should this network request be blocked?

Sandboxing answers a different question:

- If a subprocess runs anyway, what can it physically reach?

You want both.

Policy is broad. It can apply to every tool, not just shell commands. It can express ideas like "deny reads to `.env`" or "never allow editing this directory" or "ask before using the network."

Sandboxing is narrower but stronger. It usually applies to actual commands and child processes, not to every tool. But where it applies, it gives you operating-system-level enforcement instead of runtime goodwill.

That is why "sandbox vs. policy" is the wrong framing. The real answer is "sandbox plus policy."

Policy tells the agent what should happen. Sandbox limits what can happen even if the first layer gets something wrong.

## How Claude Code approaches it

Claude Code is unusually explicit about this split in its docs.

Anthropic describes permissions and sandboxing as complementary layers. Permissions apply across tools like Bash, Read, Edit, and WebFetch. Sandboxing applies to the Bash tool and its child processes, using OS-level filesystem and network isolation. The point is defense in depth, not choosing one mechanism over the other.

That design has a few important consequences.

First, Claude Code does not treat all actions as the same kind of risk. Read-only operations are handled differently from Bash commands and file edits. That matches how developers actually work. Most of the time, you want the agent to inspect code freely and to face stronger control only when it starts changing the system.

Second, sandboxing is there partly to reduce approval fatigue. Claude Code's docs make this very clear: if Bash can run safely inside a defined sandbox, the system can avoid prompting for every single command. That is not just a convenience feature. It is a usability response to the fact that too many prompts make the safety model worse, not better.

Third, Claude Code keeps permission rules as a first-class system of their own. You can deny reads, deny edits, or scope tool access with explicit rules. In other words, the sandbox does not replace fine-grained policy. It backs it up.

The clean mental model is:

- permissions decide what Claude should try
- sandboxing limits what Bash can actually do

That is a strong model because it is honest about the limits of each layer.

## How Codex approaches it

Codex presents the same basic idea through a different interface.

In the maintained Rust CLI, OpenAI exposes explicit sandbox modes such as `read-only`, `workspace-write`, and `danger-full-access`. The documentation also makes the boundary concrete: `workspace-write` allows writes inside the current workspace while still blocking network access by default, and `danger-full-access` removes filesystem sandboxing entirely.

That is already a useful design choice. Instead of hiding the autonomy model behind one fuzzy "safe mode," Codex asks you to pick the boundary directly.

Codex also separates sandboxing from approvals. In practice, that means there are two different questions:

- what boundary should commands run inside?
- when should the user be asked before widening that boundary?

That split matters for the same reason it matters in Claude Code. A sandbox mode is about the default cage. Approval is about whether the agent may step outside it.

The Codex docs and CLI surface make this especially legible because the modes are named in terms developers can reason about:

- `read-only` for investigation
- `workspace-write` for normal local coding work
- `danger-full-access` for already-isolated environments

That is not just a UX choice. It is a way of making the system architecture visible to the user.

## What Merlion is trying to do

Merlion follows the same broad lesson, but in a much smaller codebase.

The goal is not to invent a brand-new security model. The goal is to make the layers readable.

Merlion separates three things:

1. sandbox mode
2. approval policy
3. tool-specific enforcement

The sandbox mode defines the default execution boundary:

- `read-only`
- `workspace-write`
- `danger-full-access`

The approval policy defines when Merlion may ask to widen that boundary:

- `untrusted`
- `on-failure`
- `on-request`
- `never`

And then the runtime decides how those two settings apply to each kind of tool.

That last part matters because a coding agent is not only a shell wrapper. Some tools launch subprocesses. Others are native file operations in the runtime itself. Others are network requests. If you only sandbox subprocesses and ignore everything else, the agent still has a hole in it.

## Where the real sandbox lives in Merlion

In Merlion, `bash` and `run_script` are the clearest sandboxed tools.

Those tools execute through a sandbox backend in [`src/sandbox/`](../../src/sandbox/). On macOS, Linux, and other supported environments, the backend is the layer that constrains subprocess behavior. This is the closest analogue to what people usually mean by "real sandboxing": the command runs, but inside a boundary the operating system enforces.

That gives Merlion a hard stop for the most dangerous class of actions: arbitrary shell commands and whatever child processes they spawn.

This is also where widening matters. A command may first run inside a restricted mode and fail because it needs more access. At that point, Merlion can decide whether to ask for escalation, deny it, or re-run the command with a wider policy. The key point is that approval is not the sandbox. Approval is the gate that decides whether the sandbox may be widened.

## Why Merlion also needs application-layer policy

Now we get to the part that many runtimes get wrong.

Not every tool in a coding agent is a subprocess.

`read_file`, `write_file`, `edit_file`, `create_file`, `delete_file`, `copy_file`, `move_file`, and `append_file` are not shell commands. They are application-level file operations implemented directly in Node. If those tools ignore the sandbox model, then the system is only half-protected.

That is why Merlion applies the same policy model at the application layer.

The relevant code lives mainly in:

- [`src/tools/builtin/fs_common.ts`](../../src/tools/builtin/fs_common.ts)
- [`src/sandbox/policy.ts`](../../src/sandbox/policy.ts)
- [`src/tools/builtin/bash.ts`](../../src/tools/builtin/bash.ts)
- [`src/tools/builtin/run_script.ts`](../../src/tools/builtin/run_script.ts)
- [`src/tools/builtin/fetch.ts`](../../src/tools/builtin/fetch.ts)

The idea is simple.

- subprocess tools use the sandbox backend
- file tools enforce the same policy in-process
- `fetch` respects network mode
- approvals control escalation, not baseline access

That gives Merlion one policy story across the whole runtime instead of one story for shell and another story for everything else.

## The design details that matter

Once you try to make this real, the boring details turn out to be the important ones.

For example:

- deny-read and deny-write rules must apply across more than one tool, not just one happy-path file reader
- approval caching should be scoped narrowly enough that approving one kind of escalation does not silently approve unrelated ones
- child agents should inherit or narrow a parent sandbox, never widen it
- application-layer file tools have to handle symlinks carefully or they can escape the workspace boundary even if the policy looked correct on paper

That last point is a good example of why sandboxing is not a decorative feature.

If a runtime checks only lexical paths like `workspace/out.log`, but the file is actually a symlink to `/etc/hosts`, the policy can be bypassed unless the runtime resolves the real path and refuses the symlink target. Merlion now does that for its application-level file tools for exactly this reason.

The lesson is broader than the specific bug. A security model is only as good as the seams where different execution paths meet.

## The shape of the system

By this point, the architecture should look less mysterious.

A serious coding-agent runtime needs at least four ideas:

1. tool permissions
2. execution boundaries
3. escalation rules
4. consistent enforcement across tool classes

If any one of those is missing, the model gets weaker fast.

If you have policy but no sandbox, then approved subprocesses can do too much.

If you have sandbox but no policy, then everything outside shell execution becomes the easy bypass.

If you have both but escalation is sloppy, then the user ends up granting much more than they meant to.

If child agents can widen parent limits, then the whole inheritance model breaks.

This is why I think sandboxing is one of the best lenses for understanding a coding agent. It forces you to ask what the runtime actually trusts, where the hard boundaries are, and whether the same security story is true across the whole tool surface.

## Where Merlion sits

Merlion is not trying to out-product Claude Code or Codex.

It is trying to make this architecture legible.

That is why the sandbox model is visible in the CLI, explicit in the runtime, and enforced in both subprocess and application-level paths. It is also why the codebase keeps the policy layer and the backend layer separate. If you want to understand a coding agent instead of only using one, that separation is one of the first things worth seeing clearly.

In that sense, sandboxing is a good example of what Merlion is for.

It is not a giant platform feature here. It is a compact reference implementation of a real constraint system:

- a boundary for commands
- a policy for tools
- a model for escalation
- one runtime that tries to keep all three aligned

That is the level at which a coding agent becomes understandable.

## References

- Anthropic, ["Security"](https://code.claude.com/docs/en/security)
- Anthropic, ["Configure permissions"](https://code.claude.com/docs/en/permissions)
- Anthropic, ["Sandboxing"](https://code.claude.com/docs/en/sandboxing)
- OpenAI Codex, [`codex-rs/README.md`](https://github.com/openai/codex/blob/main/codex-rs/README.md)
- Merlion, [`src/sandbox/policy.ts`](../../src/sandbox/policy.ts), [`src/sandbox/`](../../src/sandbox/), [`src/tools/builtin/fs_common.ts`](../../src/tools/builtin/fs_common.ts), [`src/tools/builtin/bash.ts`](../../src/tools/builtin/bash.ts), [`src/tools/builtin/run_script.ts`](../../src/tools/builtin/run_script.ts), [`src/tools/builtin/fetch.ts`](../../src/tools/builtin/fetch.ts)
