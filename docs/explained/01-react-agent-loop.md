# How a ReAct Agent Loop Actually Works

I spent a lot of time reading coding-agent runtimes before I realized the loop at the center of them was small. Not easy. Not trivial. Just small. The loop itself is often only a few dozen lines. Everything else is defense: against bad tool calls, runaway context, premature stopping, and the model's own confusion.

I work on agent infrastructure by day and on [Merlion](../../README.md), an open-source coding agent, in my own time. Part of the reason Merlion exists is that I wanted one runtime small enough to read without turning into a toy. This piece comes from staring at that code, and at larger systems, until the same pattern became hard to miss.

At the center of it, a ReAct agent does three things:

1. show the model the transcript so far
2. let it either answer or call a tool, then run the tool and loop back
3. stop when it finally answers instead of asking to act

That is the whole shape.

Everything else people add on top, retries, guardrails, memory, compaction, permissions, verification, tracing, matters in practice, but it is not the loop itself. If you cannot see the small engine inside, all the production features blur together.

## The smallest useful loop

Here is the minimal version in pseudocode:

```python
messages = [
    {"role": "system", "content": system_prompt},
    {"role": "user", "content": user_prompt},
]

while True:
    response = model(messages, tools=tool_schemas)
    messages.append(response)

    if response.contains_tool_calls():
        tool_results = run_tools(response.tool_calls)
        messages.extend(tool_results)
        continue

    return response.final_text()
```

That is the whole idea. No planner, no memory store, no retrieval pipeline, no verification runner. Just a transcript, a tool layer, and a stop condition.

If you understand this loop, you understand the core of most modern tool-using agents.

## Why tool results go back into the transcript

This is the part many newcomers miss.

Why not run the tool, keep the result in a hidden variable, and move on? Because the model needs to see the observation in the same representational channel it used to request the action.

ReAct is not "model decides once, runtime does the rest." It is "model decides, runtime executes, model observes, model decides again." The observation has to come back into the prompt or the loop is broken.

That is why the transcript usually grows like this:

```text
system: You are a coding agent...
user: Find the bug in redirect handling.
assistant(tool_calls): read_file("requests/sessions.py")
tool: <file contents>
assistant(tool_calls): search("redirect method rewrite")
tool: <search results>
assistant: The bug is in how the method is copied across redirects...
```

The runtime does not hold state in some hidden side channel and hope the model remembers. It keeps appending the conversation. Each decision depends on what came before.

This is also why tool schemas matter more than people think. A tool's name, description, and argument schema are not just documentation. They are part of the model's working vocabulary. A vague tool description hurts the agent faster than people expect.

## Two useful reference points

The cleanest way to understand the loop is to compare two standard views of it.

OpenAI's Responses and Codex material makes the action-observation chain explicit. A model can emit reasoning, function calls, function-call outputs, and then eventually a final message. The important idea is not just that tools are involved. It is that the chain should be preserved. In the Codex writeup, the old prompt stays as an exact prefix of the new one, so the model can continue from the same trace and the system can benefit from prompt caching.

LangGraph expresses the same pattern as control flow:

```text
start -> model -> tools? -> model -> tools? -> model -> end
```

That graph is useful because it removes a lot of extra language. Underneath, a ReAct loop is just a tiny state machine:

- call model
- if there are tool calls, execute them and go back
- otherwise stop

Those two views complement each other. OpenAI clarifies the transcript discipline. LangGraph clarifies the control flow.

## What changes in real systems

Once the toy loop meets actual software work, two assumptions break almost immediately.

First, you cannot assume the model will request tools cleanly. It will stop too early, repeat the same failing call, choose the wrong tool, or hallucinate an answer instead of inspecting the code.

Second, you cannot assume the runtime can trust tool arguments blindly. In coding agents, the model will absolutely produce malformed JSON, empty paths, pasted labels inside path arguments, and shell commands that are broader than they should be.

So a real runtime grows a seam between "the model requested a tool call" and "the tool actually executes." That seam is where validation, permissions, retries, truncation policy, and stop recovery live.

This is what makes production agents look much larger than the classroom loop. The loop itself does not change much. What changes is the amount of engineering needed to keep it stable under pressure.

Consider free-code, an open-source coding agent that is useful to read for exactly this reason. Its architecture splits the runtime into an outer conversation shell and an inner query loop. That is already a useful lesson. In a real agent, the loop is rarely the whole runtime. There is usually a surrounding layer that owns conversation state, transcript persistence, model configuration, attachments, memory loading, permissions, and UI integration. Inside that shell, the loop is still the same old loop.

If you read a large agent runtime without first holding the minimal pattern in your head, it can feel like a pile of unrelated features. If you see the small engine first, the file gets easier to parse. It becomes a small loop with a lot of maintenance around it.

## Where Merlion sits

This is exactly the tradeoff Merlion is trying to explore.

There are already many coding-agent projects that are useful to run but hard to read, and many tiny demos that are easy to read but too thin to teach you much about real behavior. Merlion is trying to stay in the middle: a real CLI coding agent, but still small enough that the main runtime can be read and explained.

The split is deliberate:

- [`src/runtime/query_engine.ts`](../../src/runtime/query_engine.ts): outer conversation runtime
- [`src/runtime/loop.ts`](../../src/runtime/loop.ts): main ReAct loop
- [`src/runtime/executor.ts`](../../src/runtime/executor.ts): tool execution
- [`src/context/service.ts`](../../src/context/service.ts): context assembly

That division lets the core motion stay visible. The loop still does the obvious things: call the model, execute tool calls, append tool outputs, continue, and stop only when a real assistant answer has been produced. Around that, Merlion adds the layers a production coding agent cannot skip: path-guided context instead of blind repo-wide search, tool-argument validation, permission modes, reactive compaction, and verification nudges.

The design goal is not to pretend those problems do not exist. It is to keep them next to the loop instead of letting them swallow it. That is why Merlion pulls heuristic logic into separate files and keeps the main runtime path readable. The standard I care about is simple: can someone open the code and still point to where the loop really is?

That is also why I think the ReAct loop remains worth studying in its minimal form. Once you see it clearly, you can ask better questions of any agent runtime you read:

- where is the actual loop?
- what is core logic, and what is recovery logic?
- what state is required for correctness, and what state is just optimization?
- which patches are universal, and which are product-specific?

Understanding that boundary is most of the battle.

## What the runtime is for

A ReAct agent loop is an append-only conversation in which the model alternates between choosing actions and observing their results. The runtime's job is not to replace the model's judgment. It is to keep that alternation well-formed: expose tools the model can reason about, execute them faithfully, return observations in transcript form, and stop only when a final answer has actually arrived.

Most of the work in agent infrastructure happens around that motion, not inside it. That is why agent engineers spend so much time on tool schemas, truncation policy, permission models, compaction, and recovery behavior. They are usually not arguing about the loop itself. They are arguing about the parts that keep the loop from falling apart.

If you want to see what that looks like in code once some real-world pressure has been added back in, Merlion is the follow-up. It is not the smallest possible loop. It is a runtime built to stay readable while still doing enough real work to make the architecture worth studying.

## References

- OpenAI Cookbook, ["Handling Function Calls with Reasoning Models"](https://developers.openai.com/cookbook/examples/reasoning_function_calls)
- OpenAI, ["Unrolling the Codex agent loop"](https://openai.com/index/unrolling-the-codex-agent-loop/)
- LangChain docs, ["Agents"](https://docs.langchain.com/oss/python/langchain/agents)
- LangGraph template, [`graph.py`](https://github.com/langchain-ai/react-agent/blob/main/src/react_agent/graph.py)
- free-code, [`src/QueryEngine.ts`](https://github.com/paoloanzn/free-code/blob/main/src/QueryEngine.ts) and [`src/query.ts`](https://github.com/paoloanzn/free-code/blob/main/src/query.ts)
- Merlion, [`src/runtime/query_engine.ts`](../../src/runtime/query_engine.ts), [`src/runtime/loop.ts`](../../src/runtime/loop.ts), [`src/runtime/executor.ts`](../../src/runtime/executor.ts), [`src/context/service.ts`](../../src/context/service.ts)
