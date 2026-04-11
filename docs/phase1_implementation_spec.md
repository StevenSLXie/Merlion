# Merlion Phase 1 — Implementation Spec

Date: 2026-04-11  
Prerequisites: `phase1_technical_design.md`, `initial_design.md`, `initial_design_review.md`

> This is a pixel-level implementation spec. A mid-level engineer can start writing code
> directly from this document without referencing any other source.

---

## Review Notes on phase1_technical_design.md

The strategic direction is correct. Three items need to be added before implementation:

1. **`hasAttemptedReactiveCompact` guard is missing from the spec** — `initial_design.md`
   records a real incident: one session failed 3,272 times consecutively, burning 250,000
   API calls in a single day. The root cause was a missing guard against
   "compact → still too long → compact again" loops. This is P0 and must be explicit.

2. **"Single-layer lightweight summary" needs concrete thresholds** — The trigger formula,
   the 4-field summary schema, and the choice of Haiku (not Sonnet) for summary generation
   must be spelled out for implementation.

3. **Orientation sequence is missing** — `initial_design.md §9.7` marks the
   hardcoded session-start orientation as MVP P0: read `progress.md` → read
   `codebase_index.md` → inject both into first user message. Without this, each session
   wastes tokens re-exploring the repo from scratch.

## Must-Fix Blocking Issues (P0)

The following are non-negotiable blockers. Phase 1 must not proceed without fixing them.

1. **Provider config mutability mismatch (compile blocker).**  
   In §4.2 pseudocode, `options.provider.config.maxTokens = 65536` is used, but
   `OpenAIProvider.config` is private in §3.3. This is not implementable as written.
   Fix: add explicit provider method:
   `provider.setMaxOutputTokens(tokens: number)` and read from internal state.

2. **Verification loop pseudocode references undefined previous state (logic blocker).**  
   In §7.4, `createStateFromPrevious(state)` uses `state` before it exists in the loop scope.
   Fix: maintain `let sessionState` outside the loop and update it each round, or
   keep one persistent state across fix rounds.

3. **Cost objective has no mandatory usage ledger (product blocker).**  
   Phase 1 goal is cost, but spec has no required persisted accounting for
   input/output/cached tokens per turn.
   Fix: add `usage.jsonl` writer in P0 with fields:
   `timestamp, session_id, model, prompt_tokens, completion_tokens, cached_tokens(optional), tool_schema_tokens_estimate`.

4. **Write tools have no workspace boundary enforcement (safety blocker).**  
   `create_file` / `edit_file` accept absolute paths with no rule preventing writes outside project root.
   Fix: all mutating file tools must enforce:
   `resolvedPath.startsWith(realpath(cwd) + path.sep)`.
   Violation returns hard error and is never promptable.

5. **Transcript persistence lacks secret redaction policy (security blocker).**  
   Raw command outputs may contain tokens/secrets and are persisted to disk.
   Fix: before writing transcript entries, apply redaction patterns
   (API keys, bearer tokens, private keys) and store redacted content only.

6. **Bootstrap/test environment is missing from implementation order (execution blocker).**  
   The spec defines code layout but not an initial bootstrap checkpoint.
   Fix: add Week 0 with required files/scripts:
   `package.json`, `tsconfig.json`, `npm test`, `npm run typecheck`, Node version check.
   TDD is mandatory: test first for every feature commit.

---

## Table of Contents

1. [Project Structure](#1-project-structure)
2. [Core Type Definitions](#2-core-type-definitions)
3. [Provider Layer (OpenAI-Compatible / OpenRouter)](#3-provider-layer)
4. [Layer A: Core Runtime (ReAct Loop)](#4-layer-a-core-runtime)
5. [Layer B: Context Engine](#5-layer-b-context-engine)
6. [Layer C: Tooling (7 Built-in Tools)](#6-layer-c-tooling)
7. [Layer D: Verification Loop](#7-layer-d-verification-loop)
8. [Layer E: Repository Artifacts](#8-layer-e-repository-artifacts)
9. [Session Persistence (JSONL)](#9-session-persistence)
10. [Permissions & Sandbox](#10-permissions--sandbox)
11. [CLI Entry Point](#11-cli-entry-point)
12. [Implementation Order](#12-implementation-order)

---

## 1. Project Structure

```
merlion/
├── src/
│   ├── index.ts                    # CLI entry point
│   ├── providers/
│   │   └── openai.ts               # OpenAI-compatible provider (used for OpenRouter)
│   ├── runtime/
│   │   ├── loop.ts                 # ReAct main loop (AsyncGenerator)
│   │   ├── state.ts                # LoopState type + initializer
│   │   ├── session.ts              # Session management (create, resume, persist)
│   │   ├── executor.ts             # Tool executor (concurrent batching)
│   │   └── retry.ts                # API retry strategy
│   ├── context/
│   │   ├── engine.ts               # Context Engine entry (normalizeMessages)
│   │   ├── budget.ts               # Tool result budget truncation
│   │   └── compact.ts              # Compact (summary generation)
│   ├── tools/
│   │   ├── registry.ts             # Tool Registry
│   │   ├── builtin/
│   │   │   ├── read_file.ts
│   │   │   ├── search.ts
│   │   │   ├── create_file.ts
│   │   │   ├── edit_file.ts
│   │   │   ├── bash.ts
│   │   │   ├── fetch.ts
│   │   │   └── ask_user.ts         # P1
│   │   └── types.ts                # Tool interface definitions
│   ├── verification/
│   │   ├── runner.ts               # Verification main flow
│   │   └── checks.ts               # Check implementations
│   ├── artifacts/
│   │   ├── agents_md.ts            # AGENTS.md loading and injection
│   │   ├── progress.ts             # progress.md read/write
│   │   └── codebase_index.ts       # codebase_index.md read/write
│   ├── permissions/
│   │   ├── guard.ts                # Permission check entry point
│   │   └── sandbox.ts              # Bash dangerous command detection
│   └── types.ts                    # Global shared types
├── package.json
└── tsconfig.json
```

**Tech stack:**
- TypeScript 5.x, `"moduleResolution": "bundler"`, `"strict": true`
- Node.js 22+ (run TS directly with `--experimental-strip-types`)
- External dependencies: `openai` npm package (OpenAI-compatible SDK, works with OpenRouter)
- No framework. Node standard library only beyond `openai`.

---

## 2. Core Type Definitions

File: `src/types.ts`

```typescript
// ─── Message format (OpenAI-compatible) ──────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool'

// A single message sent to the API
export interface ChatMessage {
  role: Role
  content?: string | null
  name?: string                // for 'tool' role messages
  tool_calls?: ToolCall[]      // present on assistant messages that call tools
  tool_call_id?: string        // present on 'tool' role messages (result messages)
}

// A tool call embedded in an assistant message
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string         // JSON string — parse it yourself
  }
}

// ─── Loop State (main loop state machine) ────────────────────────────────────

export type LoopTransition =
  | 'tool_use'                  // Normal tool call, loop continues
  | 'max_tokens_escalate'       // 8K → 64K escalation retry
  | 'max_tokens_recovery'       // Injected "please continue"
  | 'reactive_compact_retry'    // Compact after 413 / context overflow

export type LoopTerminal =
  | 'completed'                 // Normal completion (stop_reason=stop, no tool calls)
  | 'model_error'               // Unrecoverable API error
  | 'context_overflow'          // Context too long, all recovery paths exhausted
  | 'aborted'                   // User interrupted (Ctrl+C)
  | 'max_turns_exceeded'        // Exceeded maxTurns limit (default 100)

export interface LoopState {
  messages: ChatMessage[]
  turnCount: number
  maxOutputTokensOverride?: number     // After escalation: 65536. Undefined = default 8192.
  maxOutputTokensRecoveryCount: number // Number of "please continue" injections (max 3)
  hasAttemptedReactiveCompact: boolean // ★ Guard: prevents compact → overflow → compact loop
  nudgeCount: number                   // Times a nudge has been injected this session (max 2)
  lastTransition?: LoopTransition
  abortController: AbortController
  sessionId: string
}

// ─── Tool system ──────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string
  description: string         // ≤100 tokens. State what it does, not how.
  parameters: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  concurrencySafe: boolean    // true = can run in parallel with other concurrencySafe tools
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>
}

export interface ToolContext {
  cwd: string
  sessionId: string
  permissions: PermissionStore
  onAskUser?: (question: string) => Promise<string>  // for ask_user tool
}

export interface ToolResult {
  content: string
  isError: boolean
}

// ─── Session ──────────────────────────────────────────────────────────────────

export interface SessionMetadata {
  id: string                  // UUID v4
  createdAt: string           // ISO 8601
  model: string               // full model ID, e.g. "anthropic/claude-sonnet-4-5"
  projectPath: string
}

export interface CompactBoundaryMarker {
  type: 'compact_boundary'
  timestamp: string
  // Index of the summary message in the pre-compact message array.
  // After resume, only messages after this index are loaded.
  summaryMessageIndex: number
}

export type TranscriptEntry = ChatMessage | CompactBoundaryMarker

// ─── Permissions ──────────────────────────────────────────────────────────────

export type PermissionDecision = 'allow' | 'deny' | 'allow_session'

export interface PermissionStore {
  // Keys where 'allow_session' was granted — skip prompting for these
  sessionAllowed: Set<string>
  ask: (tool: string, description: string) => Promise<PermissionDecision>
}
```

---

## 3. Provider Layer

### 3.1 Why OpenAI-compatible (OpenRouter)

Phase 1 targets the OpenAI Chat Completions API format via OpenRouter. This gives access
to all major models (Claude, GPT, Gemini, DeepSeek) through one endpoint and one API key,
without per-provider SDK integration work.

OpenRouter endpoint: `https://openrouter.ai/api/v1`  
SDK: the `openai` npm package works out of the box with a custom `baseURL`.

### 3.2 Message format differences vs Anthropic

The OpenAI format differs from Anthropic in three ways that matter for the loop:

| Concept | Anthropic format | OpenAI format |
|---|---|---|
| Tool call in assistant msg | `content: [{ type: 'tool_use', id, name, input }]` | `tool_calls: [{ id, type: 'function', function: { name, arguments } }]` |
| Tool result message | `role: 'user', content: [{ type: 'tool_result', tool_use_id, content }]` | `role: 'tool', tool_call_id, content: string` |
| System prompt | Separate `system` param | First message with `role: 'system'` |

**Everything in `src/types.ts` uses the OpenAI format.** There is no Anthropic format in
the codebase. No translation layer is needed.

### 3.3 Provider implementation

File: `src/providers/openai.ts`

```typescript
import OpenAI from 'openai'
import type { ChatMessage, ToolDefinition } from '../types.js'

export interface ProviderConfig {
  apiKey: string
  baseURL: string             // e.g. 'https://openrouter.ai/api/v1'
  model: string               // e.g. 'anthropic/claude-sonnet-4-5'
  maxTokens?: number          // default 8192
  extraHeaders?: Record<string, string>
}

// Separate config for the compact (summary generation) model.
// Using a cheap model here is important — compact runs every time context overflows.
export interface CompactConfig {
  apiKey: string              // Can be the same key or a different one
  baseURL: string             // Can be the same endpoint or different (e.g. direct Anthropic)
  model: string               // e.g. 'anthropic/claude-haiku-4-5' or 'openai/gpt-4o-mini'
  // No maxTokens — summary output is always short (< 2K tokens), use provider default
}

// Build a CompactConfig from CLI / env — called in CLI entry point.
// Falls back to cheap defaults if not configured.
export function buildCompactConfig(
  mainConfig: ProviderConfig,
  overrides?: Partial<CompactConfig>,
): CompactConfig {
  return {
    apiKey:  overrides?.apiKey  ?? mainConfig.apiKey,
    baseURL: overrides?.baseURL ?? mainConfig.baseURL,
    model:   overrides?.model   ?? 'anthropic/claude-haiku-4-5',
    // ↑ Default to Haiku if user doesn't specify. Cheapest model that can summarize well.
    //   If the user's baseURL is OpenRouter, 'anthropic/claude-haiku-4-5' just works.
  }
}

export interface StreamChunk {
  type: 'text_delta' | 'tool_call_delta' | 'finish'
  text?: string
  tool_call_index?: number
  tool_call_id?: string
  tool_call_name?: string
  tool_call_args_delta?: string
  finish_reason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage?: { prompt_tokens: number; completion_tokens: number }
}

export interface AssistantMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: import('../types.js').ToolCall[]
  finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
  usage: { prompt_tokens: number; completion_tokens: number }
}

export class OpenAIProvider {
  private client: OpenAI
  private maxOutputTokens: number

  constructor(private config: ProviderConfig) {
    this.maxOutputTokens = config.maxTokens ?? 8192
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/merlion-ai/merlion',
        'X-Title': 'Merlion',
        ...config.extraHeaders,
      },
    })
  }

  setMaxOutputTokens(tokens: number): void {
    this.maxOutputTokens = tokens
  }

  // Streaming call — yields chunks, returns assembled AssistantMessage
  async *streamChat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): AsyncGenerator<StreamChunk, AssistantMessage, void> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.config.model,
        messages: messages as OpenAI.ChatCompletionMessageParam[],
        tools: tools.map(toOpenAITool),
        tool_choice: tools.length > 0 ? 'auto' : undefined,
        max_tokens: this.maxOutputTokens,
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    )

    // Assemble streaming chunks into a complete message
    let contentAcc = ''
    let finishReason: string = 'stop'
    const toolCallAccumulators: Map<number, {
      id: string; name: string; args: string
    }> = new Map()
    let usage = { prompt_tokens: 0, completion_tokens: 0 }

    for await (const chunk of stream) {
      const choice = chunk.choices[0]
      if (!choice) {
        if (chunk.usage) usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens }
        continue
      }

      const delta = choice.delta

      // Text delta
      if (delta.content) {
        contentAcc += delta.content
        yield { type: 'text_delta', text: delta.content }
      }

      // Tool call delta
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!toolCallAccumulators.has(idx)) {
            toolCallAccumulators.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' })
          }
          const acc = toolCallAccumulators.get(idx)!
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name = tc.function.name
          if (tc.function?.arguments) {
            acc.args += tc.function.arguments
            yield {
              type: 'tool_call_delta',
              tool_call_index: idx,
              tool_call_id: acc.id,
              tool_call_name: acc.name,
              tool_call_args_delta: tc.function.arguments,
            }
          }
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason
      }
    }

    yield { type: 'finish', finish_reason: finishReason as any, usage }

    // Return assembled message
    const toolCalls = toolCallAccumulators.size > 0
      ? Array.from(toolCallAccumulators.entries())
          .sort(([a], [b]) => a - b)
          .map(([, acc]) => ({
            id: acc.id,
            type: 'function' as const,
            function: { name: acc.name, arguments: acc.args },
          }))
      : undefined

    return {
      role: 'assistant',
      content: contentAcc || null,
      tool_calls: toolCalls,
      finish_reason: finishReason as any,
      usage,
    }
  }
}

function toOpenAITool(tool: ToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as OpenAI.FunctionParameters,
    },
  }
}
```

### 3.4 Configuration

Environment variables:

```
OPENROUTER_API_KEY     Required. API key (used for both main model and compact model).
MERLION_MODEL          Main model ID (default: anthropic/claude-sonnet-4-5)
MERLION_BASE_URL       Main model base URL (default: https://openrouter.ai/api/v1)
MERLION_COMPACT_MODEL  Compact/summary model ID (default: anthropic/claude-haiku-4-5)
MERLION_COMPACT_URL    Compact model base URL (default: same as MERLION_BASE_URL)
MERLION_COMPACT_KEY    Compact model API key (default: same as OPENROUTER_API_KEY)
```

`MERLION_COMPACT_*` vars let you route compact calls to a different provider entirely.
For example: main model via OpenRouter, compact model direct to Anthropic API —
different pricing, different rate limits.

Config file (optional): `~/.merlion/config.json`
```json
{
  "model": "anthropic/claude-sonnet-4-5",
  "baseURL": "https://openrouter.ai/api/v1",
  "compactModel": "anthropic/claude-haiku-4-5",
  "compactBaseURL": "https://openrouter.ai/api/v1"
}
```

CLI flag `--model` overrides the main model. `--compact-model` overrides the compact model.

---

## 4. Layer A: Core Runtime

### 4.1 Main loop interface

File: `src/runtime/loop.ts`

```typescript
export interface RunOptions {
  provider: OpenAIProvider
  compactConfig: CompactConfig   // Model used for summary generation (see §5.4)
  systemPrompt: string           // Fully assembled before loop starts (AGENTS.md + task context)
  tools: ToolDefinition[]        // Tier 1 fixed tool set
  maxTurns?: number              // Default: 100
  cwd: string
  permissions: PermissionStore
  onText?: (delta: string) => void
  onToolCall?: (name: string, args: unknown) => void
  onToolResult?: (name: string, result: ToolResult) => void
  onUsage?: (promptTokens: number, completionTokens: number) => void
}

// Main entry: AsyncGenerator, yields each assistant message (after tool results are collected)
export async function* runLoop(
  userMessage: string,
  state: LoopState,
  options: RunOptions,
): AsyncGenerator<AssistantMessage, LoopTerminal, void>
```

### 4.2 Main loop pseudocode

```
function* runLoop(userMessage, state, options):
  // 1. Append user message
  state.messages.push({ role: 'user', content: userMessage })

  loop:
    // 2. Hard turn limit check
    if state.turnCount >= (options.maxTurns ?? 100):
      return 'max_turns_exceeded'

    // 3. Context budget check — trigger compact if needed
    const usage = estimateTokens(state.messages)
    const threshold = computeCompactThreshold(contextWindow, currentMaxTokens)
    if usage > threshold and not state.hasAttemptedReactiveCompact:
      await compactMessages(state, options)
      state.hasAttemptedReactiveCompact = true
      state.lastTransition = 'reactive_compact_retry'
      // Do NOT continue here — fall through to the API call with the compacted messages

    // 4. Normalize messages (tool result budget truncation)
    const normalizedMessages = normalizeMessages(state.messages)
    const allMessages = [{ role: 'system', content: options.systemPrompt }, ...normalizedMessages]

    // 5. Call API (streaming)
    let assistantMsg: AssistantMessage
    try:
      assistantMsg = await drainStream(
        provider.streamChat(allMessages, options.tools, state.abortController.signal),
        options.onText, options.onToolCall, options.onUsage
      )
    catch AbortError:
      return 'aborted'
    catch APIError as e:
      if isRetryable(e): continue  // retry logic in retry.ts handles this
      return 'model_error'

    state.turnCount++
    options.onUsage?.(assistantMsg.usage.prompt_tokens, assistantMsg.usage.completion_tokens)

    // 6. Handle finish_reason
    switch assistantMsg.finish_reason:

      case 'length':  // max_tokens hit
        // Path 1: Escalate from 8K to 64K (once per turn only)
        if not state.maxOutputTokensOverride:
          state.maxOutputTokensOverride = 65536
          options.provider.setMaxOutputTokens(65536)
          state.lastTransition = 'max_tokens_escalate'
          // Don't append the cut-off assistant message — retry the whole call
          continue

        // Path 2: Inject "please continue" (max 3 times)
        if state.maxOutputTokensRecoveryCount < 3:
          state.messages.push(toStorableMessage(assistantMsg))
          state.messages.push({
            role: 'user',
            content: 'Output was cut off. Continue directly from where you stopped. No recap, no apology.'
          })
          state.maxOutputTokensRecoveryCount++
          state.lastTransition = 'max_tokens_recovery'
          await persistTranscript(state)
          continue

        // Path 3: Exhausted — treat as completion
        state.messages.push(toStorableMessage(assistantMsg))
        await persistTranscript(state)
        yield assistantMsg
        return 'completed'

      case 'tool_calls':
        const toolUseBlocks = assistantMsg.tool_calls ?? []
        const toolResults = await executeTools(toolUseBlocks, state, options)
        state.messages.push(toStorableMessage(assistantMsg))
        for (const result of toolResults):
          state.messages.push(result)   // role: 'tool' messages
        await persistTranscript(state)
        state.lastTransition = 'tool_use'
        yield assistantMsg
        continue

      case 'stop':
        // ─── Nudge check (premature exit detection) ─────────────────────────
        // The model occasionally ends its turn with a short acknowledgment
        // that PROMISES to do work but doesn't actually call any tools.
        // Example: "I'll start by reading the auth file." — then stops.
        // We detect this and inject a nudge message to push it back into action.
        //
        // See §4.7 for the full shouldNudge() specification.
        const text = assistantMsg.content ?? ''
        if (shouldNudge(text, state)) {
          state.messages.push(toStorableMessage(assistantMsg))
          state.messages.push({
            role: 'user',
            content: 'Continue with the task. Use your tools to make progress. ' +
                     'If you have completed everything, describe what was done.'
          })
          state.nudgeCount++
          await persistTranscript(state)
          continue
        }
        // ────────────────────────────────────────────────────────────────────

        state.messages.push(toStorableMessage(assistantMsg))
        await persistTranscript(state)
        yield assistantMsg
        return 'completed'

      default:
        return 'model_error'
```

**Critical constraint:** `persistTranscript` must be called after EVERY tool execution,
not at session end. If the process is killed between tool calls, the next resume must
be able to reconstruct exact message state.

### 4.3 Nudge detection (shouldNudge)

File: `src/runtime/loop.ts` (exported for testing)

**Problem:** The model occasionally ends its turn with a forward-looking sentence like
"I'll start by reading the configuration file." but then stops without calling any tools.
This is a false start — the model said it would do X but didn't. If left unchecked, the
loop returns `'completed'` and the task is abandoned.

**Non-problem (do NOT nudge):**
- Short conversational replies: "yes", "ok", "在", "好的" — these are real completions.
- Genuine completion phrases: "Done.", "The fix is complete.", "All tests pass." — past tense, correct.
- Any response where tool calls were made this turn (finish_reason would be 'tool_calls', not 'stop').

**Detection logic:**

```typescript
function shouldNudge(text: string, state: LoopState): boolean {
  // Hard gate 1: nudge limit — max 2 nudges per session to prevent nudge loops
  if (state.nudgeCount >= 2) return false

  // Hard gate 2: very short text is conversational, never nudge
  // Covers: "在", "yes", "ok", "sure", "done", "no problem", etc.
  // Threshold: 50 chars. A forward-looking sentence is always longer than this.
  if (text.trim().length < 50) return false

  // Core signal: text promises future action but no tools were called.
  // These patterns capture "I will X" / "I'll X" / "Let me X" constructions
  // where X is an action verb — the clearest false-start signature.
  const WILL_DO_PATTERNS: RegExp[] = [
    /\bi('ll| will)\s+(start|begin|look|check|read|analyze|examine|fix|help|try|write|create|update|run|search|find)/i,
    /\blet me\s+(start|begin|look|check|read|analyze|examine|fix|help|try|write|create|update|run|search|find)/i,
    /\bi('m| am) going to\s+\w/i,
    /\bfirst,?\s+i('ll| will)\s+\w/i,
    /\bto (start|begin|proceed),?\s+i('ll| will)\s+\w/i,
  ]

  return WILL_DO_PATTERNS.some(p => p.test(text))
}

// Why this design works:
//
// "在" (2 chars) → blocked by < 50 chars gate ✓
// "好的，我明白了" (7 chars) → blocked by < 50 chars gate ✓
// "I'll start by reading the auth file." (36 chars) → blocked by < 50 chars gate ✓
// "I'll start by reading the auth file and understanding the current session management approach." (93 chars)
//   → passes length gate, matches WILL_DO_PATTERNS → nudge ✓
// "Let me read the configuration file to understand the current setup." (67 chars)
//   → passes length gate, matches WILL_DO_PATTERNS → nudge ✓
// "The function has been updated successfully. The type error on line 42 is fixed." (79 chars)
//   → passes length gate, no WILL_DO_PATTERNS match → no nudge ✓
// "Done. All three files have been modified." (41 chars) → blocked by < 50 chars gate ✓
//
// Edge case: "I'll summarize what was found: [long list...]" — matches WILL_DO_PATTERNS
// but the task may genuinely be done. Accept this false positive: the nudge message
// says "if you've completed everything, describe what was done" — the model can just
// re-output its summary as a completion. Costs one extra turn, not a correctness problem.
```

**Nudge injection message** (injected as `role: 'user'`):
```
Continue with the task. Use your tools to make progress.
If you have completed everything, describe what was done.
```

Short, directive, not accusatory. Does not mention "premature exit" or "you stopped" —
that would confuse models into apologizing rather than continuing.

### 4.4 Tool executor (partitionToolCalls)

File: `src/runtime/executor.ts`

```typescript
// Partition strategy: group consecutive concurrencySafe tool calls into parallel batches;
// each non-safe tool call is its own serial batch.
function partitionToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
): ToolCall[][]

// Execution rules:
// - concurrencySafe (read_file, search, fetch) → Promise.all, max 10 concurrent
// - not safe (bash, edit_file, create_file) → serial, one at a time
// - Concurrency limit: env MERLION_MAX_TOOL_CONCURRENCY, default 10
// - Output: array of { role: 'tool', tool_call_id, content } messages
//           One per tool call, in the SAME ORDER as input tool_calls.
//           If a tool call fails, the error message goes in content, isError is noted.

async function executeTools(
  toolCalls: ToolCall[],
  state: LoopState,
  options: RunOptions,
): Promise<ChatMessage[]>
// Returns role:'tool' messages in original order
```

**Partition example:**
```
Input:  [read_file(f1), read_file(f2), bash(cmd), read_file(f3), edit_file(f4)]
Batch 1: [read_file(f1), read_file(f2)]  → Promise.all
Batch 2: [bash(cmd)]                      → serial (after permission check)
Batch 3: [read_file(f3)]                  → Promise.all
Batch 4: [edit_file(f4)]                  → serial
```

### 4.4 Empty tool result and abort tool result

**Empty result placeholder (P0 — always inject):**
```typescript
const EMPTY_RESULT = '(no output)'
// Any tool that returns '' gets this instead.
// Reason: an empty tool_result causes the model to stall or loop.
```

**Aborted tool result (when user presses Ctrl+C mid-execution):**
```typescript
const ABORTED_RESULT = '[Tool execution was interrupted by user]'
// For every tool_call that has no result yet when abort fires:
// 1. Inject the aborted result message
// 2. Ensure tool_calls/tool messages are 1:1 symmetric
// Rule: every ToolCall in an assistant message MUST have exactly one
//       corresponding 'tool' role message. OpenAI API returns 400 if not.
```

### 4.5 Context overflow (413 / token limit) handling

```typescript
// In the loop, BEFORE calling the API, check token budget:
if (estimatedTokens > threshold && !state.hasAttemptedReactiveCompact) {
  await compactMessages(state, options)
  state.hasAttemptedReactiveCompact = true   // ★ Set guard — only compact once per session
}

// If compact was already attempted and tokens are still over limit:
// → Return 'context_overflow'. Do NOT try again.
// This guard is what prevents the "compact → still too long → compact → ..." death loop.
```

### 4.6 API retry strategy

File: `src/runtime/retry.ts`

```typescript
// Delay: exponential backoff + 25% jitter, capped at 32s
// retry-after header takes priority when present
function getRetryDelay(attempt: number, retryAfterMs?: number): number {
  const base = Math.min(1000 * Math.pow(2, attempt), 32_000)
  const jitter = base * 0.25 * Math.random()
  return retryAfterMs ?? (base + jitter)
}

// Error classification:
// Retryable:
//   429 (rate limit)   → exponential backoff, max 5 attempts
//   500, 502, 503, 529 → exponential backoff, max 5 attempts
//   ECONNRESET         → retry immediately after socket reset
// Fast-fail (do not retry):
//   400 → programming error, do not retry
//   401 → invalid API key, throw immediately
//   403 → permissions error, throw immediately
//
// AbortSignal must be passed through — Ctrl+C must interrupt mid-retry.
```

---

## 5. Layer B: Context Engine

### 5.1 Token estimation

We use a simple heuristic throughout: `Math.ceil(chars / 4)` tokens. No tokenizer.
This is intentionally approximate — we apply generous safety margins so the approximation
doesn't matter.

### 5.2 normalizeMessages entry point

File: `src/context/engine.ts`

```typescript
export interface ContextConfig {
  contextWindow: number        // Model context window (e.g. 200_000)
  maxOutputTokens: number      // Current max_tokens setting
  maxToolResultTokens: number  // Per-result truncation limit (default: 8_000 tokens ≈ 32_000 chars)
}

// Run before every API call. Mutates nothing — returns a new array.
export function normalizeMessages(
  messages: ChatMessage[],
  config: ContextConfig,
): ChatMessage[] {
  let msgs = [...messages]
  msgs = applyToolResultBudget(msgs, config.maxToolResultTokens)
  return msgs
}

// Compact trigger threshold (checked in loop.ts before each turn):
export function computeCompactThreshold(config: ContextConfig): number {
  const effectiveWindow = config.contextWindow - Math.max(config.maxOutputTokens, 20_000)
  return effectiveWindow - 13_000
  // For a 200K model: 200K - 20K - 13K = 167K (triggers at ~83.5% utilization)
  //
  // Note: "Context utilization has a sweet spot at ~40%" (OpenAI Harness Engineering).
  // We trigger compact later than ideal (83%) to avoid wasting tokens on unnecessary
  // compaction. Phase 2 can tune this lower if performance data warrants it.
}
```

### 5.3 Tool result budget truncation

File: `src/context/budget.ts`

```typescript
// Truncate each tool result message independently to prevent a single large
// output (e.g. 100K lines of bash logs) from flooding the context.
export function applyToolResultBudget(
  messages: ChatMessage[],
  maxChars: number,  // default: 32_000 (= ~8K tokens)
): ChatMessage[]

// Truncation rule:
// 1. Count chars in the tool result content
// 2. If under limit: pass through unchanged
// 3. If over limit:
//    - Keep first 40% of chars
//    - Middle replaced with: \n[...{omitted_lines} lines truncated...]\n
//    - Keep last 20% of chars
//    Total kept ≈ 60% * maxChars
// Why keep more of the beginning: for file reads, the top of the file is more
// structurally important. For bash output, error messages often appear at the end,
// so we keep both ends.
```

### 5.4 Compact (single-layer summary)

File: `src/context/compact.ts`

**Trigger (called from loop.ts):**
```typescript
export async function compactMessages(state: LoopState, options: RunOptions): Promise<void>
```

**Compact procedure:**
```
1. Find the last compact_boundary marker in the transcript.
   Take all messages after that marker (or all messages if no marker exists).

2. Call the API to generate a summary using options.compactConfig (NOT the main provider).
   - Build a one-off OpenAI client from compactConfig.{apiKey, baseURL, model}
   - Non-streaming call (simpler, summary is always short)
   - No tools passed (this is a pure text summarization call)
   - System prompt: see §5.5
   - If the call fails: log a warning and leave state.messages unchanged.
     Do NOT propagate the error into the main loop — a failed compact is better
     than a crashed session.

3. Replace state.messages with:
   [
     { role: 'user',      content: '<context_summary>\n{summary_json}\n</context_summary>' },
     { role: 'assistant', content: 'Understood. I have the context from the summary.' },
   ]

4. Write compact_boundary marker to JSONL transcript immediately.
   The marker is the resume anchor — without it, resume would reload the full history.

5. Do NOT set hasAttemptedReactiveCompact here.
   The caller (loop.ts) sets it after calling compactMessages.
```

### 5.5 Summary generation prompt

```
System:
You are a conversation summarizer. Compress the following conversation history
into a structured JSON summary. Be precise and preserve all specific technical
details: file paths, function names, error messages, line numbers.

Output ONLY valid JSON (no markdown fences, no explanation):
{
  "currentObjective": "One or two sentences describing the current task goal.",
  "verifiedFacts": [
    "Concrete facts confirmed during this session. Max 10 items.",
    "Example: src/auth.ts login() has a session leak on line 42",
    "Example: Completed: added timeout config to config/app.ts"
  ],
  "pendingWork": [
    "Work that was requested but not yet completed. Max 10 items."
  ],
  "importantFiles": [
    { "path": "src/auth.ts", "note": "Main file being modified. Contains login/logout logic." }
  ]
}

Rules:
- importantFiles: max 5 entries
- Preserve ALL specific file paths, function names, error messages
- Do NOT preserve resolved debugging steps or superseded information
- If the conversation has no meaningful content yet, return empty arrays

User:
{paste the messages to summarize here}
```

---

## 6. Layer C: Tooling

### 6.1 Tool Registry

File: `src/tools/registry.ts`

```typescript
export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map()

  register(tool: ToolDefinition): void
  get(name: string): ToolDefinition | undefined
  getAll(): ToolDefinition[]

  // Produce the tools array for API calls
  toAPIFormat(): ToolDefinition[]  // returns all registered tools
}

// Initialization (called in CLI entry):
const registry = new ToolRegistry()
registry.register(readFileTool)
registry.register(searchTool)
registry.register(createFileTool)
registry.register(editFileTool)
registry.register(bashTool)
registry.register(fetchTool)
// registry.register(askUserTool)  // P1
```

### 6.2 read_file

```typescript
// File: src/tools/builtin/read_file.ts
export const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: 'Read file contents. Supports line ranges via start_line/end_line.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative file path' },
      start_line: { type: 'integer', description: '1-indexed, inclusive' },
      end_line: { type: 'integer', description: '1-indexed, inclusive' },
    },
    required: ['path'],
  },
  concurrencySafe: true,
  execute: async ({ path, start_line, end_line }, ctx) => {
    // 1. Resolve path (relative paths resolved against ctx.cwd)
    // 2. stat: check file exists and is a regular file (not a directory)
    // 3. Size guard: > 1 GiB → return error (prevent OOM)
    // 4. Read content, apply line range if provided
    // 5. Format output: prepend each line with its line number
    //    Format: "{n}\t{line_content}"
    //    Example: "1\tfunction login() {"
    // 6. Empty file → return '(empty file)'
    // 7. Line range beyond file end → return what exists, no error
    //
    // FILE_UNCHANGED_STUB optimization (from free-code):
    //   Track content hash per path in ctx.sessionReadCache (Map<path, hash>).
    //   If the same path is read again within the same session AND the file on disk
    //   has the same hash → return:
    //   '(file content unchanged since last read — use the previous content)'
    //   This prevents repeated large file reads from bloating context.
    //   Reset the cache entry if the file is written via edit_file or create_file.
  }
}
```

### 6.3 search (ripgrep)

```typescript
// File: src/tools/builtin/search.ts
export const searchTool: ToolDefinition = {
  name: 'search',
  description: 'Search file contents with ripgrep. For code search.',
  parameters: {
    type: 'object',
    properties: {
      pattern:        { type: 'string', description: 'Regex or literal pattern' },
      path:           { type: 'string', description: 'Directory or file to search' },
      glob:           { type: 'string', description: 'File filter glob, e.g. "*.ts"' },
      case_sensitive: { type: 'boolean', description: 'Default: false' },
    },
    required: ['pattern'],
  },
  concurrencySafe: true,
  execute: async ({ pattern, path, glob, case_sensitive }, ctx) => {
    // 1. Spawn rg with child_process.spawn (not exec — avoids shell injection)
    //    Default flags: --line-number --no-heading --max-count=200
    //    Resolve path against ctx.cwd if relative.
    // 2. If rg not found in PATH: fall back to `grep -rn`, warn in output.
    // 3. Output > 200 lines: truncate. Append:
    //    '[...output truncated — use path or glob to narrow the search]'
    // 4. No matches → return '(no matches found)'
  }
}
```

### 6.4 create_file

```typescript
// File: src/tools/builtin/create_file.ts
export const createFileTool: ToolDefinition = {
  name: 'create_file',
  description: 'Create a new file with content. Fails if file already exists.',
  parameters: {
    type: 'object',
    properties: {
      path:    { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  concurrencySafe: false,
  execute: async ({ path, content }, ctx) => {
    const decision = await ctx.permissions.ask('create_file', `Create: ${path}`)
    if (decision === 'deny') return { content: '[Permission denied]', isError: true }

    // Workspace boundary guard (P0):
    // - Resolve to absolute realpath
    // - Must remain under ctx.cwd
    // - Outside path => hard error, never promptable
    // Error: 'Path is outside the workspace root and cannot be modified.'

    // File exists check: if file already exists → error, do NOT overwrite.
    // Error message: 'File already exists. Use edit_file to modify existing files.'
    // Reason: prevents accidental clobber. The model should use edit_file for existing files.

    // Create parent directories recursively (fs.mkdir with recursive: true)
    // Write file (fs.writeFile)
    // Invalidate sessionReadCache for this path (so next read_file call reads fresh)
    // Return: 'Created {path} ({line_count} lines, {char_count} chars)'
  }
}
```

### 6.5 edit_file (str_replace)

```typescript
// File: src/tools/builtin/edit_file.ts
export const editFileTool: ToolDefinition = {
  name: 'edit_file',
  description: 'Edit file by replacing exact text. old_string must match exactly once.',
  parameters: {
    type: 'object',
    properties: {
      path:       { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace, including whitespace' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  concurrencySafe: false,
  execute: async ({ path, old_string, new_string }, ctx) => {
    const decision = await ctx.permissions.ask('edit_file', `Edit: ${path}`)
    if (decision === 'deny') return { content: '[Permission denied]', isError: true }

    // Workspace boundary guard (P0):
    // - Resolve to absolute realpath
    // - Must remain under ctx.cwd
    // - Outside path => hard error, never promptable

    const content = await fs.readFile(resolvedPath, 'utf8')

    const occurrences = countSubstringOccurrences(content, old_string)

    if (occurrences === 0) {
      return {
        content: 'old_string not found in file. Check exact content including whitespace and indentation.',
        isError: true,
      }
    }
    if (occurrences > 1) {
      return {
        content: `Found ${occurrences} occurrences of old_string. Provide a more specific string that uniquely identifies the target section.`,
        isError: true,
      }
    }

    const newContent = content.replace(old_string, new_string)
    await fs.writeFile(resolvedPath, newContent, 'utf8')

    // Invalidate sessionReadCache for this path
    // Return: 'Edited {path}'
  }
}
// Note: Do NOT enforce "read before write" in the tool layer.
// The system prompt handles this as a guideline.
// Reason: sometimes the model already has the file content (e.g. just after create_file).
```

### 6.6 bash

```typescript
// File: src/tools/builtin/bash.ts
export const bashTool: ToolDefinition = {
  name: 'bash',
  description: 'Execute a shell command. Avoid interactive commands.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'integer', description: 'Timeout in ms. Default: 30000. Max: 300000.' },
    },
    required: ['command'],
  },
  concurrencySafe: false,
  execute: async ({ command, timeout = 30_000 }, ctx) => {
    // ─── Security check (see §10) ──────────────────────────────────────────
    const risk = assessCommandRisk(command as string)
    if (risk === 'block') {
      return { content: `[Blocked: ${getRiskReason(command as string)}]`, isError: true }
    }
    if (risk === 'warn') {
      const decision = await ctx.permissions.ask('bash', command as string)
      if (decision === 'deny') return { content: '[Permission denied]', isError: true }
    }
    // ───────────────────────────────────────────────────────────────────────

    // Execution:
    // - Use child_process.spawn(['bash', '-c', command]) — NOT exec(), NOT shell: true
    //   with a string command (injection risk)
    // - cwd: ctx.cwd
    // - Timeout: kill with SIGTERM after `timeout` ms; SIGKILL after 2s more
    // - Capture both stdout and stderr
    // - Max output: 100K chars total. If exceeded:
    //   Truncate combined output. Append '[output truncated]'.
    //
    // Output format:
    //   Has output: '{combined_stdout_stderr}\n[exit: {code}]'
    //   Empty output: '[exit: {code}]'
    //   Note: don't use EMPTY_RESULT placeholder here — exit code IS meaningful output.
  }
}
```

**Dangerous command detection — two levels:**

```typescript
// Level 1 — WARN (ask permission before executing):
const WARN_PATTERNS: RegExp[] = [
  /\brm\s+-[rf]{1,2}\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+push\s+--force\b/,
  /DROP\s+TABLE/i,
  /\bTRUNCATE\b/i,
  /\bkubectl\s+delete\b/,
]

// Level 2 — BLOCK (refuse outright, no permission prompt):
const BLOCK_PATTERNS: RegExp[] = [
  /rm\s+-rf\s+[\/~]/,            // rm -rf / or ~/
  />\s*\/etc\//,                 // write to /etc
  /curl[^|]*\|\s*(ba)?sh/,       // curl pipe to shell
  /wget[^|]*\|\s*(ba)?sh/,       // wget pipe to shell
  /`[^`]*rm[^`]*`/,              // rm inside command substitution
  /\$\([^)]*rm[^)]*\)/,
]

// Note: Phase 1 uses regex only. Phase 2 can upgrade to tree-sitter AST analysis
// for more sophisticated injection detection.
```

### 6.7 fetch

```typescript
// File: src/tools/builtin/fetch.ts
export const fetchTool: ToolDefinition = {
  name: 'fetch',
  description: 'Fetch content from a URL. Returns text content.',
  parameters: {
    type: 'object',
    properties: {
      url:        { type: 'string' },
      max_length: { type: 'integer', description: 'Max chars to return. Default: 20000.' },
    },
    required: ['url'],
  },
  concurrencySafe: true,
  execute: async ({ url, max_length = 20_000 }, ctx) => {
    // 1. Validate URL: only http/https schemes allowed.
    //    Others (file://, ftp://, etc.) → error immediately.
    // 2. Native fetch (Node 22+), timeout: 15s via AbortController
    // 3. Content-Type handling:
    //    text/html → extract text from <body>, strip HTML tags (regex, no DOM parser)
    //    text/*    → return as-is
    //    application/json → JSON.stringify(JSON.parse(body), null, 2)
    //    other     → '[Binary content not shown. Content-Type: {type}]'
    // 4. Truncate to max_length chars
    // 5. Output format:
    //    'URL: {url}\nStatus: {status_code}\n\n{content}'
  }
}
```

### 6.8 ask_user (P1)

```typescript
// File: src/tools/builtin/ask_user.ts
// Priority: P1 (implement in week 2)
export const askUserTool: ToolDefinition = {
  name: 'ask_user',
  description: 'Ask the user a question and wait for their response. Use when blocked.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
    },
    required: ['question'],
  },
  concurrencySafe: true,
  execute: async ({ question }, ctx) => {
    // Uses ctx.onAskUser callback (wired up to readline in CLI entry)
    const answer = await ctx.onAskUser?.(question as string)
    if (!answer) return { content: '[No response]', isError: false }
    return { content: answer, isError: false }
  }
}
```

---

## 7. Layer D: Verification Loop

### 7.1 Architecture

Verification is a **harness-layer loop outside the agent loop**, not a tool call inside it.

```
User task
  → Agent loop: implement changes
  → Verification harness: run checks
  → Inject structured results into next agent loop turn
  → Agent: fix failures
  → Repeat (max 5 fix rounds)
  → Done (all passed or exhausted)
```

### 7.2 Check discovery

File: `src/verification/checks.ts`

```typescript
export interface CheckConfig {
  name: string
  command: string
  timeout: number      // ms, default 60_000
}

// Auto-discover checks from package.json scripts.
// Check these keys in order; include a check if the script key exists.
export async function discoverChecks(cwd: string): Promise<CheckConfig[]> {
  const pkg = await readPackageJson(cwd)
  const scripts = pkg?.scripts ?? {}

  const CANDIDATE_SCRIPTS: Array<{ key: string; name: string; timeout: number }> = [
    { key: 'typecheck',    name: 'typecheck', timeout: 60_000 },
    { key: 'type-check',   name: 'typecheck', timeout: 60_000 },
    { key: 'tsc',          name: 'typecheck', timeout: 60_000 },
    { key: 'lint',         name: 'lint',      timeout: 30_000 },
    { key: 'test',         name: 'test',      timeout: 120_000 },
    { key: 'test:unit',    name: 'test',      timeout: 120_000 },
    { key: 'build',        name: 'build',     timeout: 120_000 },
  ]

  const found: CheckConfig[] = []
  const seen = new Set<string>()

  for (const candidate of CANDIDATE_SCRIPTS) {
    if (scripts[candidate.key] && !seen.has(candidate.name)) {
      seen.add(candidate.name)
      found.push({
        name: candidate.name,
        command: `npm run ${candidate.key}`,
        timeout: candidate.timeout,
      })
    }
  }

  return found
  // If no checks found: return []. Verification pass is trivially true.
}
```

### 7.3 Verification runner

File: `src/verification/runner.ts`

```typescript
export async function runVerification(
  checks: CheckConfig[],
  cwd: string,
): Promise<VerificationResult> {
  // Run all checks sequentially (not in parallel — a build failure should stop lint, etc.)
  // Each check:
  //   1. Run command with child_process.spawn(['sh', '-c', command])
  //   2. Capture stdout + stderr, respect timeout
  //   3. Truncate output to 2000 chars (plenty for error messages)
  //   4. Record: passed (exit 0), failed (non-zero), timed_out
}

// Format result for injection into agent context
export function formatVerificationResult(result: VerificationResult): string {
  // Output format injected as the next user message:
  //
  // ===VERIFICATION RESULTS===
  // typecheck: FAILED (2.3s)
  // --- output ---
  // src/auth.ts(42,5): error TS2345: Argument of type 'string' is not...
  // ---
  // test: PASSED (8.1s)
  // lint: PASSED (1.2s)
  // ===END===
  //
  // Fix the failures above. Do not modify tests or type definitions unless the
  // error is in those files. Run the same checks again when done.
}
```

### 7.4 Integration with CLI

```typescript
// In CLI entry (src/index.ts), runTask wraps the agent loop:
const MAX_FIX_ROUNDS = 5

async function runTask(initialTask: string, opts: RunOptions): Promise<void> {
  const checks = await discoverChecks(opts.cwd)
  let currentMessage = initialTask
  let lastVerification: VerificationResult | null = null
  let sessionState = createInitialState()

  for (let round = 0; round < MAX_FIX_ROUNDS; round++) {
    // Keep one persistent session state across fix rounds so transcript + token
    // behavior remain continuous and resumable.
    if (round > 0 && lastVerification) {
      currentMessage = formatVerificationResult(lastVerification)
    }

    const terminal = await drainLoopToCompletion(runLoop(currentMessage, sessionState, opts))
    if (terminal === 'aborted') return

    if (checks.length === 0) break  // No checks configured — trust the agent

    lastVerification = await runVerification(checks, opts.cwd)
    if (lastVerification.allPassed) break
  }
}
```

---

## 8. Layer E: Repository Artifacts

### 8.1 AGENTS.md

File: `src/artifacts/agents_md.ts`

**Load order (highest priority first):**
```
1. <project_root>/AGENTS.md       → project-level, overrides all
2. ~/.merlion/AGENTS.md           → user-level global
3. <install_dir>/default.md       → built-in fallback
```

**Timing:** Loaded once at session start. Injected into the static prefix of the system
prompt. Never re-read during the session.

**Built-in default AGENTS.md (~200 tokens):**
```markdown
# Agent Rules

## Before editing
Always read a file before editing it.

## After changes
Run tests and typecheck if the project has them configured.

## File operations
- Use edit_file for modifying existing files
- Use create_file only for new files
- Never delete files without explicit user confirmation

## Communication
Report what you did and what remains. Be concise.
```

**Size:** Warn (do not truncate) if project AGENTS.md exceeds 500 lines.

### 8.2 progress.md

File: `src/artifacts/progress.ts`

**Location:** `<project_root>/.merlion/progress.md`  
**Gitignore:** Add `.merlion/` to `.gitignore` automatically on first write.

**Write timing:** At the end of each session (normal completion or user abort).  
The agent writes this — it is injected into the system prompt as context so the
agent knows what it should update before finishing.

**Format:**
```markdown
## Session {ISO_TIMESTAMP}
### Completed
- {specific completed items with file paths}

### Current State
- {key facts about current code state}

### Known Issues
- {unresolved problems}

### Next Priority
- {most important next step}
```

**Read timing:** At session start. If the file exists, include its content in the
system prompt dynamic suffix (see §11.3).

**Rotation:** Keep only the last 3 session entries. Entries beyond that are trimmed.

### 8.3 codebase_index.md

File: `src/artifacts/codebase_index.ts`

**Location:** `<project_root>/.merlion/codebase_index.md`

**Purpose:** Eliminates the cold-start token waste of re-exploring the repo on every
new session. Without this, the agent spends ~2000-5000 tokens doing `search` and
`read_file` calls just to locate relevant files. With it, the agent knows the structure
immediately from session start.

**Read timing:** At session start. Inject into system prompt if the file exists.  
**Write timing:** Created/updated by the agent itself (bash tool) at the end of a session,
or manually via `/index` command.

**Format example:**
```markdown
# Codebase Index
updated: 2026-04-11T14:30:00Z

## Module Map
src/auth/    → JWT + session management. Entry: src/auth/index.ts
src/api/     → Express router, v1 prefix, ~40 endpoints
src/db/      → Prisma ORM, PostgreSQL
src/utils/   → Shared utilities, no external deps

## Key Files
src/index.ts      → Main entry. Startup: db → redis → express
config/app.ts     → All env vars (zod-validated)

## Build & Run
dev:   npm run dev
test:  npm test
build: npm run build

## Recent Hot Zones
src/auth/refresh.ts    ← Main file from last session
src/api/users.ts       ← Has open TODO: rate limiting

## Known Constraints
- Dependency direction: types → config → db → service → api
- Never mock the database in tests (real DB required)
```

**Token cost:** ~300-500 tokens. Always worth it.

**Phase 1 workflow:** The agent creates/updates this file manually using bash.
Phase 2 can automate this with PostToolUse hooks.

### 8.4 Session orientation sequence

This is a **hardcoded harness behavior** — not something the agent does by itself.
Before the first user message is sent to the model, the harness prepends orientation
context to the system prompt's dynamic suffix:

```typescript
// src/artifacts/orientation.ts
export async function buildOrientationContext(cwd: string): Promise<string> {
  const parts: string[] = []

  // Load progress.md
  const progress = await loadProgress(cwd)
  if (progress) {
    parts.push('<previous_progress>\n' + progress + '\n</previous_progress>')
  }

  // Load codebase_index.md
  const index = await loadCodebaseIndex(cwd)
  if (index) {
    parts.push('<codebase_index>\n' + index + '\n</codebase_index>')
  }

  return parts.join('\n\n')
}
```

This is injected as part of the system prompt (not as a user message). It costs ~500-1000
tokens but saves the 2000-5000 tokens that would otherwise go into exploration.

---

## 9. Session Persistence

### 9.1 JSONL format

**File path:** `~/.merlion/projects/{project_hash}/{session_id}.jsonl`

- `project_hash`: `sha256(absoluteProjectPath).slice(0, 16)` (hex)
- `session_id`: UUID v4

**Line types:**

```jsonl
// Session metadata (first line always)
{"type":"session_meta","id":"abc-123","createdAt":"2026-04-11T06:00:00Z","model":"anthropic/claude-sonnet-4-5","projectPath":"/home/user/myapp"}

// Chat messages (one per line)
{"type":"message","role":"user","content":"Fix the auth bug"}
{"type":"message","role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"src/auth.ts\"}"}}]}
{"type":"message","role":"tool","tool_call_id":"call_1","content":"1\tfunction login() {"}

// Compact boundary (written immediately after compact)
{"type":"compact_boundary","timestamp":"2026-04-11T06:15:00Z"}
```

### 9.2 Write rules

```typescript
// ALWAYS use appendFile — never rewrite the whole file.
// Write after EVERY tool execution batch (not at session end).
// Failure to write: log warning + continue. Never abort the task for persistence failures.
// Before writing content, apply secret redaction:
//   - Bearer tokens
//   - API keys (OpenAI/Anthropic/GitHub-style patterns)
//   - PEM private key blocks
// Persist redacted text only.
await fs.appendFile(transcriptPath, JSON.stringify(entry) + '\n', 'utf8')
```

### 9.3 Session resume

**Trigger:** `merlion --resume` (shows list) or `merlion --resume <session-id>`

```typescript
async function resumeSession(sessionId: string): Promise<LoopState> {
  // 1. Read JSONL file line by line
  // 2. Find the LAST compact_boundary marker
  // 3. Load only 'message' entries after that marker
  //    (pre-boundary messages are superseded by the compact summary)
  // 4. If no boundary found: load all message entries
  // 5. Integrity check: every assistant message with tool_calls must be followed by
  //    matching 'tool' messages. If not (interrupted mid-execution):
  //    Inject ABORTED_RESULT for the missing tool results.
  // 6. session_allowed permissions: reset to empty (re-ask on resume)
  // 7. Return LoopState with reconstructed messages[]
}
```

### 9.4 Usage ledger (cost tracking, required)

**File path:** `~/.merlion/projects/{project_hash}/{session_id}.usage.jsonl`

Append one line per assistant turn:

```jsonl
{"timestamp":"2026-04-11T07:10:12Z","session_id":"...","model":"anthropic/claude-sonnet-4-5","prompt_tokens":4231,"completion_tokens":312,"cached_tokens":3891,"tool_schema_tokens_estimate":640}
```

If provider usage does not include `cached_tokens`, write `null`.
This file is mandatory for validating cost improvements.

---

## 10. Permissions & Sandbox

### 10.1 Permission modes

```typescript
type PermissionMode =
  | 'interactive'   // Default: prompt for each dangerous action
  | 'auto_allow'    // --auto-allow: approve everything (for CI)
  | 'auto_deny'     // --auto-deny: deny everything (for read-only exploration)
```

### 10.2 Permission key format

```typescript
// Key used for allow_session deduplication:
function permissionKey(tool: string, input: string): string {
  return `${tool}:${input.trim().replace(/\s+/g, ' ')}`
}
// Example: 'bash:git push --force origin main'
// Example: 'edit_file:/home/user/project/src/auth.ts'
```

### 10.3 Interactive permission dialog

```
┌─ Permission Required ───────────────────────────────────┐
│ Tool:    bash                                            │
│ Command: git push --force origin main                   │
│ Risk:    ⚠ WARNING — may overwrite remote history        │
└─────────────────────────────────────────────────────────┘
[a] allow once   [A] allow for this session   [d] deny
```

**Input handling:**
- `a` → `allow` (this invocation only)
- `A` → `allow_session` (skip prompt for same key in this session)
- `d` or Enter → `deny`
- Ctrl+C → `deny` + abort the entire agent loop

### 10.4 Risk assessment

File: `src/permissions/sandbox.ts`

```typescript
export type RiskLevel = 'safe' | 'warn' | 'block'

export function assessCommandRisk(command: string): RiskLevel {
  if (BLOCK_PATTERNS.some(p => p.test(command))) return 'block'
  if (WARN_PATTERNS.some(p => p.test(command))) return 'warn'
  return 'safe'
}

// WARN_PATTERNS and BLOCK_PATTERNS: see §6.6
```

---

## 11. CLI Entry Point

### 11.1 Command syntax

```
merlion [options] [task]

Options:
  --model <id>          Model ID (default: anthropic/claude-sonnet-4-5)
  --resume [id]         Resume a previous session (lists recent if id omitted)
  --auto-allow          Skip permission prompts — approve everything
  --no-verify           Skip the verification loop
  --max-turns <n>       Max loop turns before giving up (default: 100)
  --cwd <path>          Working directory (default: current directory)
  --index               Rebuild codebase_index.md and exit

Interactive (no task argument): enter REPL mode (multi-turn conversation)
```

### 11.2 Startup sequence

```typescript
async function main() {
  const { task, opts, isResume } = parseArgs()

  // 1. Validate config (API key present, model ID set)
  validateConfig(opts)

  // 2. Build provider
  const provider = new OpenAIProvider({
    apiKey: process.env.OPENROUTER_API_KEY!,
    baseURL: opts.baseURL ?? 'https://openrouter.ai/api/v1',
    model: opts.model,
  })

  // 3. Build tool registry
  const registry = buildRegistry()

  // 4. Build permission store
  const permissions = createPermissionStore(opts.permissionMode)

  // 5. Load AGENTS.md
  const agentsMd = await loadAgentsMd(opts.cwd)

  // 6. Build orientation context (progress.md + codebase_index.md)
  const orientationContext = await buildOrientationContext(opts.cwd)

  // 7. Assemble system prompt
  const systemPrompt = buildSystemPrompt({ agentsMd, orientationContext })

  // 8. Discover verification checks
  const checks = opts.noVerify ? [] : await discoverChecks(opts.cwd)

  // 9. Create or resume session
  const state = isResume
    ? await resumeSession(opts.sessionId)
    : createInitialState({ model: opts.model, cwd: opts.cwd })

  // 10. Run
  if (task) {
    await runTask(task, { state, systemPrompt, registry, provider, permissions, opts, checks })
  } else {
    await runREPL({ state, systemPrompt, registry, provider, permissions, opts, checks })
  }

  // 11. Write progress.md (best-effort, do not throw)
  await writeProgress(opts.cwd, state).catch(() => {})
}
```

### 11.3 System prompt structure

```typescript
function buildSystemPrompt({ agentsMd, orientationContext }: {
  agentsMd: string
  orientationContext: string
}): string {
  // ★ STATIC PREFIX — must remain identical across turns within a session
  //   for prompt caching to work. Changes here invalidate the cache.
  const STATIC_PREFIX = `You are Merlion, an AI coding agent. You help software engineers with coding tasks.

## Core principles
- Read files before editing them
- Make minimal changes to accomplish the task
- Verify your changes with tests and typecheck if the project has them
- Be concise. Report what you did and what remains.

## Tools available
read_file, search, create_file, edit_file, bash, fetch
Use the right tool for each step. You can call multiple tools in one response.

${agentsMd}`

  // ★ DYNAMIC SUFFIX — session-specific context.
  //   Placed at the END so the static prefix can be cached.
  const DYNAMIC_SUFFIX = orientationContext
    ? `\n\n${orientationContext}`
    : ''

  return STATIC_PREFIX + DYNAMIC_SUFFIX
}
```

**Why the order matters:** OpenRouter (and Anthropic's prompt cache) cache based on
a matching prefix. If dynamic content comes first, the prefix never matches across
sessions and caching is ineffective. Static content first → maximum cache hits.

### 11.4 Terminal output rendering

No UI framework in Phase 1. Use `process.stdout.write` directly.

```
[Turn 1]
⚙  read_file src/auth.ts
✓  read_file (0.1s)
⚙  edit_file src/auth.ts
✓  edit_file (0.1s)

The login function now validates the session token before...

────────────────────────────────────────────────
[tokens: 4,231 in / 312 out | cached: 3,891]
```

**Display rules:**
- Tool call start: `⚙  {tool_name} {first_arg_preview}`
- Tool call done: `✓  {tool_name} ({duration})`
- Tool call error: `✗  {tool_name}: {error_summary}`
- Token usage: printed after each assistant turn
- Turn separator: `────────────────────────────────────────────────`

---

## 12. Implementation Order

### Week 0 — Bootstrap and TDD baseline

0. Initialize repo baseline files: `package.json`, `tsconfig.json`, `.gitignore`
1. Add scripts:
   - `npm test` (Node built-in test runner)
   - `npm run typecheck` (`tsc --noEmit`)
2. Add `tests/` directory and one smoke test that executes in CI/local.
3. Add `docs/todo.md` + `docs/tracker.md` and define status workflow:
   `todo -> in_progress -> blocked -> done`
4. Add commit protocol:
   - write mini feature spec in `docs/features/NNN-*.md`
   - write failing test first
   - implement
   - run tests
   - commit

**Week 0 acceptance test:** fresh clone runs `npm test` and `npm run typecheck` successfully.

### Week 1 — Working skeleton

Implement in this exact order. Each step is independently testable.

1. `src/types.ts` — All type definitions (pure types, no logic)
2. `src/providers/openai.ts` — Provider with streaming. Test: make a direct API call, print the streaming output.
3. `src/tools/types.ts` + `src/tools/registry.ts`
4. `src/tools/builtin/read_file.ts` — Simplest tool. Test: read a real file.
5. `src/runtime/retry.ts` — Retry logic. Test: mock 429 responses.
6. `src/runtime/executor.ts` — partitionToolCalls + executeTools. Test: mock tools, verify ordering.
7. `src/runtime/loop.ts` — Main loop skeleton. Start with only `finish_reason=stop` and `finish_reason=tool_calls`. Add `max_tokens` and `context_overflow` handling in step 9.
8. `src/runtime/session.ts` — JSONL write only (no resume yet).
9. `src/index.ts` — CLI entry, one-shot mode only (no REPL, no verification).
10. Add usage ledger writer (`session_id.usage.jsonl`) and print per-turn usage.

**Week 1 acceptance test:** `merlion "read the README and summarize it"` completes successfully. Tool call written to JSONL.

### Week 2 — Full tool set + permissions

11. `src/permissions/sandbox.ts` + `src/permissions/guard.ts`
12. `src/tools/builtin/bash.ts` (depends on sandbox.ts)
13. `src/tools/builtin/edit_file.ts` + workspace boundary guard
14. `src/tools/builtin/create_file.ts` + workspace boundary guard
15. `src/tools/builtin/search.ts`
16. `src/tools/builtin/fetch.ts`
17. Add `hasAttemptedReactiveCompact` guard + context overflow handling to `loop.ts`
18. Add `max_tokens` escalation (8K→64K) + recovery injection to `loop.ts`
19. `src/tools/builtin/ask_user.ts`

**Week 2 acceptance test:** Complete a real coding task — add a function to an existing
file, run `tsc --noEmit` to verify. Permission dialog works for bash commands.

### Week 3 — Context engine + resume

20. `src/context/budget.ts` — Tool result truncation
21. `src/context/compact.ts` — Summary generation (Haiku via OpenRouter)
22. `src/context/engine.ts` — normalizeMessages pipeline
23. `src/runtime/session.ts` — Add resume logic (compact boundary + message reconstruction)
24. Add transcript redaction before persist (session + tool outputs)
25. `src/artifacts/agents_md.ts` — Multi-path AGENTS.md loading
26. `src/artifacts/progress.ts` — progress.md read/write
27. `src/artifacts/codebase_index.ts` — codebase_index.md load
28. `src/artifacts/orientation.ts` — Orientation context builder
29. Wire orientation context into `src/index.ts`

**Week 3 acceptance test:** Run a session until compact triggers. Resume with `--resume`.
Verify state is correctly reconstructed. AGENTS.md content appears in system prompt.

### Week 4 — Verification + polish

30. `src/verification/checks.ts` — discoverChecks from package.json
31. `src/verification/runner.ts` — runVerification
32. Verification loop in `src/index.ts` (runTask with fix rounds)
33. REPL mode (multi-turn) in `src/index.ts`
34. Token usage display in terminal output
35. `--resume` interactive selection (list recent sessions)
36. End-to-end tests (see §Appendix C)

**Week 4 acceptance test:** Given a project with TypeScript errors, `merlion "fix all
type errors"` runs until `tsc --noEmit` passes, with at most 5 fix rounds.

---

## Appendix A: Environment Variables

```
OPENROUTER_API_KEY          Required. API key for main model + compact model (shared by default).
MERLION_MODEL               Main model ID (default: anthropic/claude-sonnet-4-5)
MERLION_BASE_URL            Main model base URL (default: https://openrouter.ai/api/v1)
MERLION_COMPACT_MODEL       Compact model ID (default: anthropic/claude-haiku-4-5)
MERLION_COMPACT_URL         Compact model base URL (default: same as MERLION_BASE_URL)
MERLION_COMPACT_KEY         Compact model API key (default: same as OPENROUTER_API_KEY)
MERLION_MAX_TURNS           Override default maxTurns (default: 100)
MERLION_MAX_TOOL_CONCURRENCY  Tool concurrency limit (default: 10)
MERLION_DATA_DIR            Override ~/.merlion (data storage directory)
```

## Appendix B: What Phase 1 deliberately excludes

| Feature | Reason excluded |
|---|---|
| `cache_edits` (server-side tool result deletion) | Depends on undocumented API; complexity not justified until cache metrics are collected |
| Sub-agents (fork/fresh) | Adds complexity. Validate single-agent quality first. |
| Auto Dream (automatic memory consolidation) | Extra LLM calls not cost-justified in Phase 1 |
| Tool Search (deferred tool loading) | Only 6 tools in Phase 1 — no need |
| Skill system (progressive disclosure) | P1 after core loop is stable |
| Stop hooks (premature exit detection) | P1. Needs quality data to calibrate. |
| Embedding / vector search | P3. ripgrep is sufficient. |
| Multiple provider SDKs (Anthropic native, Gemini) | Single OpenAI-compatible interface covers all models via OpenRouter |
| Context utilization % warning (<40% sweet spot) | Phase 2 when we have usage telemetry to verify |
| Entropy management (periodic refactor agent) | Phase 3 |

## Appendix C: Testing Strategy

- **Tool layer**: Unit tests per tool against a real temporary filesystem (no mocking).
- **loop.ts**: Integration tests with a mock `OpenAIProvider` that returns scripted responses.
  Verify state transitions: tool_use → result → continue, max_tokens escalation, reactive_compact guard.
- **context/compact.ts**: Unit test: feed synthetic messages, verify summary format and boundary marker written to JSONL.
- **verification/runner.ts**: Integration test on a real project with deliberate TypeScript errors.
- **End-to-end golden paths** (must pass before any release):
  1. Read-only task: `merlion "list all exported functions in src/"` — no file writes, completes cleanly.
  2. Edit task: `merlion "add a hello() function to src/utils.ts"` — file modified, typecheck passes.
  3. Fix round task: introduce a type error, run `merlion "fix type errors"` — verification loop runs, error fixed, tsc passes.

**No mocking the filesystem or the real checks in integration tests.**
Reason: `initial_design.md` explicitly records that mock/prod divergence was a root cause
of past incidents (mock tests passed, real DB migration failed).
