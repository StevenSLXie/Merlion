/**
 * Unit tests for the WeChat API HTTP layer.
 *
 * All network calls are intercepted via a global fetch mock so no real
 * HTTP requests are made.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchQRCode,
  pollQRStatus,
  getUpdates,
  sendMessage,
  SESSION_EXPIRED_ERRCODE,
  WECHAT_SEND_RATE_LIMIT_ERRCODE,
  WeixinApiError,
} from '../src/transport/wechat/api.ts'

// ---------------------------------------------------------------------------
// Minimal fetch mock
// ---------------------------------------------------------------------------

type FetchResponse = { ok: boolean; status?: number; json: () => Promise<unknown> }
type FetchMock = (url: string, opts?: RequestInit) => Promise<FetchResponse>

let fetchMock: FetchMock | null = null
const originalFetch = global.fetch

before(() => {
  // @ts-expect-error – replace global fetch with mock
  global.fetch = async (url: string, opts?: RequestInit) => {
    if (!fetchMock) throw new Error('fetchMock not set')
    return fetchMock(url, opts)
  }
})

after(() => {
  global.fetch = originalFetch
})

beforeEach(() => {
  fetchMock = null
})

function mockOk(body: unknown): FetchMock {
  return async () => ({ ok: true, status: 200, json: async () => body })
}

function mockHttp(status: number): FetchMock {
  return async () => ({ ok: false, status, json: async () => ({}) })
}

// ---------------------------------------------------------------------------
// fetchQRCode
// ---------------------------------------------------------------------------

describe('fetchQRCode', () => {
  test('parses qrcode and qrcode_img_content from response', async () => {
    fetchMock = mockOk({ qrcode: 'qr-id-123', qrcode_img_content: 'https://scan.me/abc' })
    const result = await fetchQRCode()
    assert.equal(result.qrcode, 'qr-id-123')
    assert.equal(result.qrcode_img_content, 'https://scan.me/abc')
  })

  test('sends GET to correct endpoint', async () => {
    let capturedUrl = ''
    fetchMock = async (url) => {
      capturedUrl = url
      return { ok: true, json: async () => ({ qrcode: 'x', qrcode_img_content: 'y' }) }
    }
    await fetchQRCode()
    assert.ok(capturedUrl.includes('get_bot_qrcode'), 'should call get_bot_qrcode')
    assert.ok(capturedUrl.includes('bot_type=3'), 'should send bot_type=3')
  })

  test('throws on HTTP error', async () => {
    fetchMock = mockHttp(500)
    await assert.rejects(fetchQRCode, /HTTP 500/)
  })
})

// ---------------------------------------------------------------------------
// pollQRStatus
// ---------------------------------------------------------------------------

describe('pollQRStatus', () => {
  test('returns confirmed with bot_token', async () => {
    fetchMock = mockOk({
      status: 'confirmed',
      bot_token: 'tok-xyz',
      ilink_bot_id: 'bot-1',
      baseurl: 'https://ilinkai.weixin.qq.com',
      ilink_user_id: 'u-1',
    })
    const result = await pollQRStatus('qr-id')
    assert.equal(result.status, 'confirmed')
    assert.equal(result.bot_token, 'tok-xyz')
  })

  test('returns wait on AbortError (long-poll timeout)', async () => {
    fetchMock = async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const result = await pollQRStatus('qr-id')
    assert.equal(result.status, 'wait')
  })

  test('throws on non-timeout network error', async () => {
    fetchMock = async () => { throw new Error('network failure') }
    await assert.rejects(() => pollQRStatus('qr-id'), /network failure/)
  })

  test('sends special ClientVersion: 1 header', async () => {
    let capturedHeaders: Record<string, string> = {}
    fetchMock = async (_url, opts) => {
      capturedHeaders = (opts?.headers ?? {}) as Record<string, string>
      return { ok: true, json: async () => ({ status: 'wait' }) }
    }
    await pollQRStatus('qr-id')
    assert.equal(capturedHeaders['iLink-App-ClientVersion'], '1')
  })

  test('URL-encodes the qrcode id', async () => {
    let capturedUrl = ''
    fetchMock = async (url) => {
      capturedUrl = url
      return { ok: true, json: async () => ({ status: 'wait' }) }
    }
    await pollQRStatus('id with spaces')
    assert.ok(capturedUrl.includes('id+with+spaces') || capturedUrl.includes('id%20with%20spaces'))
  })

  test('supports polling via redirected base URL', async () => {
    let capturedUrl = ''
    fetchMock = async (url) => {
      capturedUrl = url
      return { ok: true, json: async () => ({ status: 'wait' }) }
    }
    await pollQRStatus('qr-id', 'https://ilinkai-hk.weixin.qq.com')
    assert.ok(
      capturedUrl.startsWith('https://ilinkai-hk.weixin.qq.com/ilink/bot/get_qrcode_status'),
      `expected redirected base URL, got: ${capturedUrl}`,
    )
  })
})

// ---------------------------------------------------------------------------
// getUpdates
// ---------------------------------------------------------------------------

describe('getUpdates', () => {
  test('returns empty response on AbortError (long-poll timeout)', async () => {
    fetchMock = async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    const result = await getUpdates('https://ilinkai.weixin.qq.com', 'tok', '', 100)
    assert.equal(result.ret, 0)
    assert.deepEqual(result.msgs, [])
  })

  test('passes get_updates_buf in POST body', async () => {
    let parsedBody: Record<string, unknown> = {}
    fetchMock = async (_url, opts) => {
      parsedBody = JSON.parse(opts?.body as string) as Record<string, unknown>
      return { ok: true, json: async () => ({ ret: 0, msgs: [], get_updates_buf: 'new-buf' }) }
    }
    await getUpdates('https://ilinkai.weixin.qq.com', 'tok', 'prev-buf', 100)
    assert.equal(parsedBody['get_updates_buf'], 'prev-buf')
  })

  test('treats HTTP 524 as empty long-poll response', async () => {
    fetchMock = async () => ({ ok: false, status: 524, json: async () => ({}) })
    const result = await getUpdates('https://ilinkai.weixin.qq.com', 'tok', '', 100)
    assert.equal(result.ret, 0)
    assert.deepEqual(result.msgs, [])
  })

  test('returns msgs from server response', async () => {
    const fakeMsg = { message_id: 42, from_user_id: 'user-1', message_type: 1, item_list: [] }
    fetchMock = mockOk({ ret: 0, msgs: [fakeMsg], get_updates_buf: 'buf2' })
    const result = await getUpdates('https://ilinkai.weixin.qq.com', 'tok', '', 100)
    assert.equal(result.msgs?.length, 1)
    assert.equal(result.msgs?.[0]?.message_id, 42)
    assert.equal(result.get_updates_buf, 'buf2')
  })

  test('includes Authorization header with token', async () => {
    let capturedHeaders: Record<string, string> = {}
    fetchMock = async (_url, opts) => {
      capturedHeaders = (opts?.headers ?? {}) as Record<string, string>
      return { ok: true, json: async () => ({ ret: 0, msgs: [] }) }
    }
    await getUpdates('https://ilinkai.weixin.qq.com', 'my-token', '', 100)
    assert.ok(capturedHeaders['Authorization']?.includes('my-token'))
  })

  test('reports SESSION_EXPIRED_ERRCODE constant value', () => {
    assert.equal(SESSION_EXPIRED_ERRCODE, -14)
  })
})

// ---------------------------------------------------------------------------
// sendMessage
// ---------------------------------------------------------------------------

describe('sendMessage', () => {
  test('sends correct to_user_id and text', async () => {
    let parsedBody: Record<string, unknown> = {}
    fetchMock = async (_url, opts) => {
      parsedBody = JSON.parse(opts?.body as string) as Record<string, unknown>
      return { ok: true, json: async () => ({}) }
    }
    await sendMessage('https://ilinkai.weixin.qq.com', 'tok', 'user-42', 'Hello!', 'ctx-token')
    const msg = parsedBody['msg'] as Record<string, unknown>
    assert.equal(msg['to_user_id'], 'user-42')
    assert.equal(msg['message_type'], 2)
    assert.equal(msg['message_state'], 2)
    assert.equal(msg['context_token'], 'ctx-token')
    const items = msg['item_list'] as Array<{ type: number; text_item: { text: string } }>
    assert.equal(items?.[0]?.type, 1)
    assert.equal(items?.[0]?.text_item?.text, 'Hello!')
  })

  test('sends to sendmessage endpoint', async () => {
    let capturedUrl = ''
    fetchMock = async (url) => {
      capturedUrl = url
      return { ok: true, json: async () => ({}) }
    }
    await sendMessage('https://ilinkai.weixin.qq.com', 'tok', 'u', 'hi')
    assert.ok(capturedUrl.includes('sendmessage'), `expected sendmessage in URL, got: ${capturedUrl}`)
  })

  test('throws on HTTP error', async () => {
    fetchMock = mockHttp(401)
    await assert.rejects(
      () => sendMessage('https://ilinkai.weixin.qq.com', 'bad-tok', 'u', 'hi'),
      /HTTP 401/,
    )
  })

  test('throws on API-level errcode even when HTTP is 200', async () => {
    fetchMock = mockOk({ ret: -1001, errmsg: 'rate limited' })
    await assert.rejects(
      () => sendMessage('https://ilinkai.weixin.qq.com', 'tok', 'u', 'hi'),
      /errcode=-1001/,
    )
  })

  test('exports send rate-limit errcode constant', () => {
    assert.equal(WECHAT_SEND_RATE_LIMIT_ERRCODE, -2)
  })

  test('throws WeixinApiError on API-level non-zero errcode', async () => {
    fetchMock = mockOk({ errcode: -2, errmsg: 'too frequent' })
    await assert.rejects(
      () => sendMessage('https://ilinkai.weixin.qq.com', 'tok', 'u', 'hi'),
      (error) => error instanceof WeixinApiError && error.errcode === -2,
    )
  })

  test('propagates AbortError on timeout instead of treating as success', async () => {
    fetchMock = async () => {
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    }
    await assert.rejects(
      () => sendMessage('https://ilinkai.weixin.qq.com', 'tok', 'u', 'hi'),
      /aborted/,
    )
  })

  test('generates unique client_id per send', async () => {
    const clientIds: string[] = []
    fetchMock = async (_url, opts) => {
      const body = JSON.parse(opts?.body as string) as { msg: { client_id: string } }
      clientIds.push(body.msg.client_id)
      return { ok: true, json: async () => ({}) }
    }
    await sendMessage('https://ilinkai.weixin.qq.com', 'tok', 'u', 'msg1')
    await sendMessage('https://ilinkai.weixin.qq.com', 'tok', 'u', 'msg2')
    assert.notEqual(clientIds[0], clientIds[1])
  })
})
