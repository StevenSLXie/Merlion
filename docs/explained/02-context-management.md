# How Context Management Actually Works in a Coding Agent

The first time I built a coding agent, I thought context management meant "put the right files into the prompt." That was the mistake. The real job is harder and more ordinary: deciding what to keep fixed, what to append, what to summarize, and what to leave out.

I work on agent infrastructure by day and on [Merlion](../../README.md), an open-source coding agent, in my own time. Merlion has been useful for one reason in particular: it forces these choices into the open. Once you stop treating "context" as a vague cloud around the model, it becomes a concrete runtime problem.

At the center of it, a context manager for an agent does three things:

1. keep a stable prompt prefix the model can rely on
2. add the smallest amount of task-specific state needed for the next step
3. cut or compress history only when the transcript has become too large to carry forward intact

That is the whole shape.

Everything else, retrieval, summaries, memory stores, repo maps, path hints, cache metrics, exists to support those three moves.

## The smallest useful version

If you read the first piece in this series, this will look familiar. I am using the same tiny loop again on purpose, because each piece should stand on its own and because the context story starts from the same place.

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

This loop already has a context policy, even if it does not look like one.

- the `system_prompt` is the stable prefix
- the transcript is the working memory
- tool outputs are appended back into the same history
- nothing is summarized
- nothing is retrieved dynamically

For a toy agent, that is enough.

If the task is short, the model is good, and the tools are small, the transcript itself is the context manager.

## Why the toy version breaks

The trouble starts when the job gets longer than a few turns.

Three pressures appear almost immediately.

The first is relevance pressure. In a real repository, not every file, note, prior turn, or tool output belongs in the next request. A coding agent that drags the whole conversation forward will become less focused before it becomes truly out of window.

The second is budget pressure. Even if every earlier step is relevant in principle, the runtime still has to fit instructions, tools, transcript, and new observations into a bounded context window. Something has to give.

The third is cache pressure. This one matters more than many people realize. If you keep rewriting the front of the prompt, moving tool schemas around, changing the order of items, or injecting a fresh pile of runtime hints every turn, you make prefix reuse harder. The model may still work, but the system gets slower and more expensive.

So context management is not just "find more context." It is a balancing act between relevance, budget, and prefix stability.

## Why cache matters so much

This part is worth saying plainly, because otherwise prompt caching sounds like a nice optimization instead of a core design constraint.

Every turn begins with the model reading the prompt you send it. In transformer models, that first pass over the input is often called prefill. As the model processes those input tokens, its attention layers produce intermediate key and value tensors. Those tensors are the working state that lets later tokens attend to the earlier ones.

If the next request begins with the same prefix, the system may be able to reuse those tensors instead of recomputing them from scratch. OpenAI's prompt caching docs describe this directly: extended prompt caching stores key/value tensors produced during prefill. That is why exact prefix matches matter so much. The cache is not "the idea of the prompt." It is reusable computation tied to the exact earlier prefix.

This is why cache saves both time and money.

It saves time because the model does less work before it can continue from the new part of the request. It saves money because that skipped work is GPU work that no longer has to be redone. OpenAI states this in practical terms in two places: the Codex write-up says cache hits make sampling linear rather than quadratic, and the Responses migration guide says better cache utilization lowers costs.

That is also why sloppy prompt assembly is expensive in a way that is easy to miss. If you reorder tools, mutate system instructions, rewrite a stable summary every turn, or insert runtime-authored messages near the front, the request may still mean almost the same thing to a human reader. To the cache, it is a different prefix.

So when people say "preserve the prefix," the deeper point is this: preserve reusable computation.

## The MVP context manager

If you want a first version that is still worth building, I think it should stay simple.

Do four things:

1. keep a fixed system prompt
2. append the transcript in order
3. cap tool outputs before they go back into the transcript
4. when history gets too large, replace the oldest middle section with a short summary

That is enough to teach the core tradeoff.

You do not need vector search on day one. You do not need long-term memory on day one. You do not even need retrieval if the agent can already inspect the repository with tools. What you need first is a transcript that stays legible and a runtime that does not panic when the conversation gets long.

This is also where many people learn the wrong lesson. They see the prompt getting large and conclude that the answer is better retrieval. Sometimes it is. Often it is not. Just as often, the agent already has the information it needs, but the transcript has become noisy, repetitive, or unstable.

## What the industry has converged on

The cleanest public description of modern agent context handling is still OpenAI's Codex write-up.

The key idea is not only that the agent keeps appending actions and observations. It is that the old prompt should stay an exact prefix of the new one whenever possible. OpenAI says this explicitly in the Codex article, and for good reason: prompt caching only works on exact prefix matches. If the front of the prompt stays stable, later turns get cheaper and faster. If the runtime keeps mutating the prefix, cache reuse disappears.

This also changes how you think about prompt assembly. Static instructions belong near the front. Tool definitions should be stable and consistently ordered. The variable parts, fresh user input, new tool outputs, recovery hints that are truly needed for this turn, belong later. In a long-running agent, "how do I keep this prompt understandable?" and "how do I keep this prompt cacheable?" are often the same question.

The Responses API formalizes this further by making the transcript item-based instead of message-only. A `message` is just one item type. `function_call`, `function_call_output`, and `reasoning` are items too. That matters because tool use is not really "assistant text with some extra fields." It is a structured trace. Once the runtime treats those steps as first-class items, it becomes easier to preserve the shape of the conversation across turns.

So the industry picture is not mysterious.

- keep a stable prefix when you can
- preserve the action-observation trace faithfully
- treat context as runtime state, not just text pasted into a prompt

## The three places context usually goes wrong

Once a system moves past the MVP stage, most failures show up in one of three places.

### 1. Too much enters the prompt

This is the obvious one.

Whole files get shoved into the transcript when only one function mattered. Search results come back huge. Shell output is dumped in full. The runtime keeps every correction hint, every retry note, every temporary reminder, and every dead-end observation.

The result is not just higher token count. It is lower signal density.

Models are surprisingly tolerant of long prompts. They are much less tolerant of long messy prompts.

### 2. The wrong things stay stable

People often say "keep the prefix stable," which is true, but incomplete. The more important question is: stable relative to what?

The right stable prefix is usually made of:

- core instructions
- tool definitions
- repository orientation that changes slowly

The wrong stable prefix is made of:

- turn-specific hints
- temporary recovery messages
- repeated summaries of the same recent work

If you stabilize noise, you just pay to preserve noise.

### 3. Compression destroys useful structure

Summarization sounds like a clean solution until you rely on it too early.

A summary can save budget, but it throws away exact wording, exact call structure, and exact local sequence. That is often fine for distant history. It is dangerous for the recent working chain.

In tool-using systems, the most important part of the transcript is often the short span from the last real user request through the latest tool results. Compress that section too aggressively and the model loses the thread of what it was doing.

Imagine an agent halfway through debugging a redirect bug. It has read three files, run a search, and narrowed the problem to one function. If compaction swallows that recent chain into a summary like "the agent has been investigating redirect handling," the model has lost the actual working state. It still knows the topic. It no longer knows where it was. The next turn becomes a re-investigation instead of a continuation.

This is why a good compaction policy is less about writing a beautiful summary and more about choosing the right boundary.

## What production systems have to decide

A real agent runtime ends up making a few decisions that the toy loop can ignore.

First, it has to separate static context from reactive context.

Static context is the stuff you want near the front for many turns: instructions, tool schemas, maybe a repository map, maybe a short orientation summary. Reactive context is added because of what just happened: a file path mentioned by the user, a tool result that surfaced a new directory, a recovery hint after a malformed tool call.

Second, it has to decide which context belongs inside the transcript and which belongs outside it.

This sounds abstract, but it is not. If the runtime authors a reminder like "you have not changed any files yet," is that a real conversation item or just a local control signal? If you put it into the live transcript, it affects future caching and future compaction. Sometimes that is worth it. Sometimes it pollutes the very history you are trying to preserve.

Third, it has to know which messages count as the user's task anchor.

This matters more than it sounds. In a coding agent, there may be many items with `role: user`, but only some of them come from the human. Others are runtime-authored nudges, recoveries, or verification prompts. If you compact around the wrong "user" message, you preserve the wrong tail of history.

That is one reason item structure and source tagging matter. Once the runtime can say "this was an external user request" and "this was a runtime-authored reminder," compaction gets safer.

## Where Merlion sits

This is exactly the line Merlion is trying to walk.

There are already agent systems that solve context with a lot of product machinery. There are also demos that avoid the issue by staying too small to hit real pressure. Merlion is trying to stay in the middle: real enough to expose the hard parts, but still small enough that the context path can be read from top to bottom.

The split is deliberate.

- [`src/context/service.ts`](../../src/context/service.ts): builds the stable prompt pieces and path-guided additions
- [`src/runtime/query_engine.ts`](../../src/runtime/query_engine.ts): owns transcript state across turns
- [`src/runtime/items.ts`](../../src/runtime/items.ts): defines the item-native transcript model and item/message projection rules
- [`src/context/compact.ts`](../../src/context/compact.ts): compacts old history when the item transcript gets too large
- [`src/runtime/prompt_observability.ts`](../../src/runtime/prompt_observability.ts): measures stable-prefix behavior and cache-related prompt shape
- [`src/runtime/session.ts`](../../src/runtime/session.ts): persists transcript items and response boundaries for replay and resume

The design starts with a fixed base and only then gets more selective.

On startup, Merlion builds a stable orientation layer: system prompt, repository guidance, and a small amount of generated workspace context. During the turn, it adds path guidance based on what the user asked for and on which paths later appear in tool calls or tool results. That means the runtime does not begin by searching the whole repository blindly. It tries to narrow the working set first.

The transcript itself is now item-native. Instead of pretending the whole conversation is just a list of chat messages, Merlion keeps distinct items for messages, reasoning, function calls, and function-call outputs. That is closer to the Codex and Responses model, and it makes resume and compaction less lossy.

Compaction is intentionally conservative. Merlion keeps the static system prefix, preserves the recent working chain starting from the latest external user request, and compresses the older middle into one runtime-authored summary item only when the transcript has crossed a threshold. In other words: do not summarize the hot path unless you have to.

The observability layer exists for the same reason. Merlion tracks stable-prefix tokens, stable-prefix ratio, cached tokens, and response boundaries not because dashboards are fashionable, but because context work is otherwise too easy to guess at. If a runtime claims to care about caching but cannot tell you how stable its prefix actually was, it is mostly operating on vibes.

## The shape I think is worth aiming for

If I had to reduce context management to one rule, it would be this:

Keep the front of the prompt boring. Keep the middle sparse. Keep the tail exact.

The boring front is what makes the model predictable and the cache useful. The sparse middle is what stops old work from turning into clutter. The exact tail is what lets the model continue the current thread without losing local structure.

That rule is simple enough for an MVP and still true in production. The differences are mostly in how much engineering it takes to maintain it under pressure.

That is also why context management is such a revealing part of an agent runtime. It tells you what the system thinks is stable, what it thinks is important, and what kinds of mess it expects from the world. A coding agent's context policy is really a theory of how work unfolds over time.

If you want to see one concrete version of that theory in code, Merlion is the follow-up. It does not solve context by pretending the problem is elegant. It solves it by keeping the main moves visible: stable prefix, path-guided additions, item-native transcript, conservative compaction, and explicit cache observability.

## References

- OpenAI, ["Unrolling the Codex agent loop"](https://openai.com/index/unrolling-the-codex-agent-loop/)
- OpenAI docs, ["Migrate to the Responses API"](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- OpenAI docs, ["Prompt caching"](https://developers.openai.com/api/docs/guides/prompt-caching)
- Merlion, [`src/context/service.ts`](../../src/context/service.ts), [`src/context/compact.ts`](../../src/context/compact.ts), [`src/runtime/query_engine.ts`](../../src/runtime/query_engine.ts), [`src/runtime/items.ts`](../../src/runtime/items.ts), [`src/runtime/prompt_observability.ts`](../../src/runtime/prompt_observability.ts), [`src/runtime/session.ts`](../../src/runtime/session.ts)
