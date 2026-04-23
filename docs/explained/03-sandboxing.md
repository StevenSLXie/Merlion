# How Sandboxing Actually Works in a Coding Agent

A sandbox is not a vibe. It is an execution boundary.

Most discussions of agent safety I see online are actually about permission prompts. That is not nothing, but it is not sandboxing.

A sandbox says: if the agent runs a command, where can that command read, where can it write, and can it reach the network at all? If the answer depends only on the model behaving well, you do not really have a sandbox. You have a policy request.

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

Permissions govern intent. Sandboxes govern physics.

## The first non-obvious problem

The first non-obvious thing here is that not every tool in a coding agent is a subprocess.

People naturally think about sandboxing in terms of shell commands. That makes sense. `bash` looks dangerous, so it gets the attention. But a coding agent also has native file tools, native network tools, and other runtime-level operations that never pass through the shell at all.

If you sandbox shell commands but leave `read_file`, `write_file`, or `fetch` on a separate trust model, you have built a wall with a door next to it.

That is why serious runtimes end up with two related questions instead of one:

- what should the agent be allowed to attempt?
- which execution paths are actually forced to respect that decision?

That split is where a lot of supposedly safe agent systems start to leak.

## What Larger Systems Converged On

Claude Code and Codex differ in product shape, but they converge on the same core lesson: policy and sandboxing are separate layers.

Claude Code documents the split more explicitly. Codex makes it more visible through named modes like `read-only`, `workspace-write`, and `danger-full-access`. But the underlying model is very similar:

- one layer decides what the agent should be allowed to attempt
- another layer constrains what a running process can actually reach

That separation matters for two reasons.

First, it reduces approval fatigue. If safe work can happen inside a boundary, the system does not need to interrupt the user for every small command.

Second, it gives the runtime a more honest security story. Permissions and approvals are about control flow. Sandboxing is about containment.

I think that convergence is the important part, not the product differences. Once you see it, Merlion becomes easier to position: it is trying to make the same architecture readable in a much smaller runtime.

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

## Where the real sandbox lives in Merlion

In Merlion, `bash` and `run_script` are the clearest sandboxed tools.

Those tools execute through a sandbox backend in [`src/sandbox/`](../../src/sandbox/). On macOS, Linux, and other supported environments, the backend is the layer that constrains subprocess behavior. This is the closest analogue to what people usually mean by "real sandboxing": the command runs, but inside a boundary the operating system enforces.

That gives Merlion a hard stop for the most dangerous class of actions: arbitrary shell commands and whatever child processes they spawn.

This is also where widening matters. A command may first run inside a restricted mode and fail because it needs more access. At that point, Merlion can decide whether to ask for escalation, deny it, or re-run the command with a wider policy. The key point is that approval is not the sandbox. Approval is the gate that decides whether the sandbox may be widened.

## Why Merlion also needs application-layer policy

This is the part many runtimes get wrong in practice.

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

One bug like that teaches the bigger lesson. A security model is only as good as the seams where different execution paths meet.

## The shape of the system

By this point, the architecture should look less mysterious.

A serious coding-agent runtime needs a few ideas to stay aligned:

1. tool permissions
2. execution boundaries
3. escalation rules
4. consistent enforcement across tool classes

If you keep policy but drop sandboxing, an approved subprocess can still do too much.

If you keep sandboxing but treat non-shell tools as special cases, the easy bypass moves into the application layer.

And if escalation is sloppy, the user ends up granting far more than they thought they approved.

This is why I think sandboxing is one of the best lenses for understanding a coding agent. It forces you to ask what the runtime actually trusts, where the hard boundaries are, and whether the same security story is true across the whole tool surface.

## Where Merlion sits

Merlion is not trying to out-product Claude Code or Codex.

It is trying to make this architecture legible.

That is why the sandbox model is visible in the CLI, explicit in the runtime, and enforced in both subprocess and application-level paths. It is also why the codebase keeps the policy layer and the backend layer separate. If you want to understand a coding agent instead of only using one, that separation is one of the first things worth seeing clearly.

In that sense, sandboxing is a good lens for what Merlion is trying to be: a compact reference implementation where boundaries, policy, and escalation are visible rather than buried. That is the level at which a coding agent becomes understandable instead of only usable.

## References

- Anthropic, ["Security"](https://code.claude.com/docs/en/security)
- Anthropic, ["Configure permissions"](https://code.claude.com/docs/en/permissions)
- Anthropic, ["Sandboxing"](https://code.claude.com/docs/en/sandboxing)
- OpenAI Codex, [`codex-rs/README.md`](https://github.com/openai/codex/blob/main/codex-rs/README.md)
- Merlion, [`src/sandbox/policy.ts`](../../src/sandbox/policy.ts), [`src/sandbox/`](../../src/sandbox/), [`src/tools/builtin/fs_common.ts`](../../src/tools/builtin/fs_common.ts), [`src/tools/builtin/bash.ts`](../../src/tools/builtin/bash.ts), [`src/tools/builtin/run_script.ts`](../../src/tools/builtin/run_script.ts), [`src/tools/builtin/fetch.ts`](../../src/tools/builtin/fetch.ts)
