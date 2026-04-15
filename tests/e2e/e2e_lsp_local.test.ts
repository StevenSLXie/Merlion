import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AssistantResponse, ChatMessage, ModelProvider } from '../../src/types.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { runLoop } from '../../src/runtime/loop.ts'

class StubProvider implements ModelProvider {
  private index = 0
  private readonly responses: AssistantResponse[]

  constructor(responses: AssistantResponse[]) {
    this.responses = responses
  }

  async complete(_messages: ChatMessage[]): Promise<AssistantResponse> {
    const response = this.responses[this.index]
    if (!response) throw new Error(`unexpected provider call at index=${this.index}`)
    this.index += 1
    return response
  }
}

test('e2e local lsp flow resolves symbol definition end-to-end', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-e2e-lsp-'))
  await mkdir(join(cwd, 'src'), { recursive: true })
  await writeFile(join(cwd, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022' },
    include: ['src/**/*.ts'],
  }, null, 2), 'utf8')
  await writeFile(join(cwd, 'src', 'lib.ts'), 'export const value = 1\n', 'utf8')
  await writeFile(join(cwd, 'src', 'main.ts'), "import { value } from './lib.js'\nconsole.log(value)\n", 'utf8')

  try {
    const provider = new StubProvider([
      {
        role: 'assistant',
        content: null,
        finish_reason: 'tool_calls',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'lsp', arguments: JSON.stringify({ action: 'definition', path: 'src/main.ts', line: 2, character: 13 }) },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        role: 'assistant',
        content: 'The symbol is defined in src/lib.ts.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const result = await runLoop({
      provider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      systemPrompt: 'You are Merlion.',
      userPrompt: 'Find where value is defined.',
      cwd,
      maxTurns: 5,
    })

    assert.equal(result.terminal, 'completed')
    assert.match(result.finalText, /src\/lib\.ts/)
    assert.equal(result.state.messages.some((message) => message.role === 'tool' && /src\/lib\.ts/.test(message.content ?? '')), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
