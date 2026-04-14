import test from 'node:test'
import assert from 'node:assert/strict'

import { CliRuntimeSink } from '../src/runtime/sinks/cli.ts'
import type { CliSinkDriver } from '../src/runtime/sinks/cli.ts'

function makeDriver(log: string[]): CliSinkDriver {
  return {
    renderBanner() { log.push('renderBanner') },
    renderUserPrompt(prompt) { log.push(`renderUserPrompt:${prompt}`) },
    renderAssistantOutput(output, terminal) { log.push(`renderAssistantOutput:${terminal}:${output}`) },
    clearTypedInputLine() { log.push('clearTypedInputLine') },
    stopSpinner() { log.push('stopSpinner') },
    promptLabel() { log.push('promptLabel'); return 'merlion> ' },
    onTurnStart(event) { log.push(`onTurnStart:${event.turn}`) },
    onAssistantResponse(event) { log.push(`onAssistantResponse:${event.finish_reason}:${event.tool_calls_count}`) },
    onToolStart(event) { log.push(`onToolStart:${event.name}:${event.index}/${event.total}`) },
    onToolResult(event) { log.push(`onToolResult:${event.name}:${event.isError}`) },
    onUsage(snapshot, estimatedCost, provider) {
      log.push(`onUsage:${snapshot.totals.prompt_tokens}:${estimatedCost ?? 'none'}:${provider ?? 'none'}`)
    },
    onPhaseUpdate(text) { log.push(`onPhaseUpdate:${text}`) },
    onMapUpdated(text) { log.push(`onMapUpdated:${text}`) },
    setToolDetailMode(mode) { log.push(`setToolDetailMode:${mode}`) },
  }
}

test('CliRuntimeSink forwards runtime events to the driver', () => {
  const log: string[] = []
  const sink = new CliRuntimeSink(
    { model: 'test-model', sessionId: 'session-1234', isRepl: false },
    makeDriver(log)
  )

  sink.renderBanner()
  sink.renderUserPrompt('fix it')
  sink.renderAssistantOutput('done', 'completed')
  sink.clearTypedInputLine()
  sink.stopSpinner()
  assert.equal(sink.promptLabel(), 'merlion> ')
  sink.onTurnStart({ turn: 2 })
  sink.onAssistantResponse({ turn: 2, finish_reason: 'tool_calls', tool_calls_count: 1 })
  sink.onToolStart({ index: 1, total: 2, name: 'read_file', summary: '{}' })
  sink.onToolResult({ index: 1, total: 2, name: 'read_file', durationMs: 12, isError: false })
  sink.onUsage({
    snapshot: {
      turn: 1,
      delta: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 0, total_tokens: 15 },
      totals: { prompt_tokens: 10, completion_tokens: 5, cached_tokens: 0, total_tokens: 15 },
    },
    estimatedCost: 0.12,
    provider: 'openai',
  })
  sink.onPhaseUpdate('phase')
  sink.onMapUpdated('map')
  sink.setToolDetailMode('compact')

  assert.deepEqual(log, [
    'renderBanner',
    'renderUserPrompt:fix it',
    'renderAssistantOutput:completed:done',
    'clearTypedInputLine',
    'stopSpinner',
    'promptLabel',
    'onTurnStart:2',
    'onAssistantResponse:tool_calls:1',
    'onToolStart:read_file:1/2',
    'onToolResult:read_file:false',
    'onUsage:10:0.12:openai',
    'onPhaseUpdate:phase',
    'onMapUpdated:map',
    'setToolDetailMode:compact',
  ])
})
