import { createServer } from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchTool } from '../src/tools/builtin/fetch.ts'
import { resolveSandboxPolicy } from '../src/sandbox/policy.ts'

async function withServer(
  handler: (req: any, res: any) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('invalid server address')
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run(baseUrl)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
}

test('fetches plain text', async () => {
  await withServer((_, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end('hello world')
  }, async (baseUrl) => {
    const result = await fetchTool.execute({ url: `${baseUrl}/plain` }, { cwd: process.cwd() })
    assert.equal(result.isError, false)
    assert.match(result.content, /Status: 200/)
    assert.match(result.content, /hello world/)
  })
})

test('pretty-prints json', async () => {
  await withServer((_, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ a: 1, b: 'x' }))
  }, async (baseUrl) => {
    const result = await fetchTool.execute({ url: `${baseUrl}/json` }, { cwd: process.cwd() })
    assert.equal(result.isError, false)
    assert.match(result.content, /"a": 1/)
    assert.match(result.content, /"b": "x"/)
  })
})

test('strips html tags', async () => {
  await withServer((_, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<html><body><h1>Title</h1><p>Body</p></body></html>')
  }, async (baseUrl) => {
    const result = await fetchTool.execute({ url: `${baseUrl}/html` }, { cwd: process.cwd() })
    assert.equal(result.isError, false)
    assert.match(result.content, /Title/)
    assert.match(result.content, /Body/)
    assert.doesNotMatch(result.content, /<h1>/)
  })
})

test('rejects non-http scheme', async () => {
  const result = await fetchTool.execute({ url: 'file:///etc/passwd' }, { cwd: process.cwd() })
  assert.equal(result.isError, true)
  assert.match(result.content, /Only http\/https URLs are allowed/)
})

test('truncates long response', async () => {
  await withServer((_, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end('x'.repeat(5000))
  }, async (baseUrl) => {
    const result = await fetchTool.execute(
      { url: `${baseUrl}/long`, max_length: 1000 },
      { cwd: process.cwd() },
    )
    assert.equal(result.isError, false)
    assert.match(result.content, /\[content truncated\]/)
  })
})

test('network-off sandbox blocks fetch', async () => {
  const result = await fetchTool.execute(
    { url: 'https://example.com' },
    {
        cwd: process.cwd(),
        sandbox: {
        policy: resolveSandboxPolicy({
          cwd: process.cwd(),
          sandboxMode: 'workspace-write',
          approvalPolicy: 'untrusted',
          networkMode: 'off',
        }),
        backend: {
          name: () => 'test',
          isAvailableForPolicy: async () => true,
          run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
        },
      },
    },
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /blocks outbound network/i)
})

test('network-off fetch can escalate with approval', async () => {
  await withServer((_, res) => {
    res.setHeader('Content-Type', 'text/plain')
    res.end('allowed after approval')
  }, async (baseUrl) => {
    let prompts = 0
    const result = await fetchTool.execute(
      { url: `${baseUrl}/approved` },
      {
        cwd: process.cwd(),
        permissions: {
          ask: async () => {
            prompts += 1
            return 'allow'
          },
        },
        sandbox: {
          policy: resolveSandboxPolicy({
            cwd: process.cwd(),
            sandboxMode: 'workspace-write',
            approvalPolicy: 'on-failure',
            networkMode: 'off',
          }),
          backend: {
            name: () => 'test',
            isAvailableForPolicy: async () => true,
            run: async () => ({ stdout: '', stderr: '', exitCode: 0, timedOut: false }),
          },
        },
      },
    )

    assert.equal(result.isError, false)
    assert.equal(prompts, 1)
    assert.match(result.content, /allowed after approval/)
  })
})
