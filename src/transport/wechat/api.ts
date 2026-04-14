/**
 * HTTP layer for the ilinkai.weixin.qq.com API.
 *
 * Protocol mirrors @tencent-weixin/openclaw-weixin v2.1.8.
 * All requests use native fetch (Node >= 22).
 */
import { randomBytes } from 'node:crypto'

export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
const BOT_TYPE = '3'
/** Server holds getUpdates up to this long before returning empty. */
export const DEFAULT_POLL_TIMEOUT_MS = 35_000
const API_TIMEOUT_MS = 15_000
export const SESSION_EXPIRED_ERRCODE = -14
export const WECHAT_SEND_RATE_LIMIT_ERRCODE = -2

/** Channel version sent in every request. */
const CHANNEL_VERSION = '2.1.8'
/**
 * iLink-App-ClientVersion as uint32: (major<<16)|(minor<<8)|patch.
 * 2.1.8 → 0x00020108 = 131336
 */
const CLIENT_VERSION_INT = ((2 & 0xff) << 16) | ((1 & 0xff) << 8) | (8 & 0xff)

/** X-WECHAT-UIN: random uint32 → decimal string → base64, per request. */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(uint32), 'utf-8').toString('base64')
}

function commonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': '',
    'iLink-App-ClientVersion': String(CLIENT_VERSION_INT),
    'X-WECHAT-UIN': randomWechatUin(),
  }
}

function postHeaders(token: string | undefined, bodyLen: number): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(),
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'Content-Length': String(bodyLen),
  }
  if (token?.trim()) headers['Authorization'] = `Bearer ${token.trim()}`
  return headers
}

async function doGet<T>(
  url: string,
  extraHeaders?: Record<string, string>,
  timeoutMs?: number,
  abortFallback?: T,
): Promise<T> {
  const controller = new AbortController()
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { ...commonHeaders(), ...extraHeaders },
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status} GET ${url}`)
    return await resp.json() as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (abortFallback !== undefined) return abortFallback
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function doPost<T>(
  url: string,
  body: unknown,
  token?: string,
  timeoutMs?: number,
  abortFallback?: T,
  statusFallbacks?: number[],
): Promise<T> {
  const bodyStr = JSON.stringify(body)
  const bodyLen = Buffer.byteLength(bodyStr, 'utf-8')
  const controller = new AbortController()
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: postHeaders(token, bodyLen),
      body: bodyStr,
      signal: controller.signal,
    })
    if (!resp.ok) {
      if (
        abortFallback !== undefined &&
        Array.isArray(statusFallbacks) &&
        statusFallbacks.includes(resp.status)
      ) {
        return abortFallback
      }
      throw new Error(`HTTP ${resp.status} POST ${url}`)
    }
    return await resp.json() as T
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      if (abortFallback !== undefined) {
        // Long-poll timeout can be normal when caller explicitly opts in.
        return abortFallback
      }
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class WeixinApiError extends Error {
  readonly errcode: number
  readonly errmsg?: string

  constructor(message: string, errcode: number, errmsg?: string) {
    super(message)
    this.name = 'WeixinApiError'
    this.errcode = errcode
    this.errmsg = errmsg
  }
}

function baseUrl(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

// ---------------------------------------------------------------------------
// QR login
// ---------------------------------------------------------------------------

export interface QRCodeResponse {
  /** QR session ID — used for status polling. */
  qrcode: string
  /** QR content to encode (a URL string). */
  qrcode_img_content: string
}

export async function fetchQRCode(): Promise<QRCodeResponse> {
  const url = `${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`
  return doGet<QRCodeResponse>(url, undefined, API_TIMEOUT_MS)
}

export interface QRStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired' | 'scaned_but_redirect'
  bot_token?: string
  ilink_bot_id?: string
  /** Effective API base URL after login (may differ from ILINK_BASE_URL). */
  baseurl?: string
  ilink_user_id?: string
  redirect_host?: string
}

export async function pollQRStatus(
  qrcodeId: string,
  pollBaseUrl: string = ILINK_BASE_URL,
): Promise<QRStatusResponse> {
  const url = `${baseUrl(pollBaseUrl)}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}`
  // Protocol note: QR-status long-poll uses ClientVersion '1' (nanobot / reference impl).
  const qrHeaders = { 'iLink-App-ClientVersion': '1' }
  return await doGet<QRStatusResponse>(url, qrHeaders, DEFAULT_POLL_TIMEOUT_MS, { status: 'wait' })
}

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export interface WeixinMessageItem {
  type?: number
  text_item?: { text?: string }
}

export interface WeixinMessage {
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  /** 1 = user→bot, 2 = bot→user */
  message_type?: number
  message_state?: number
  item_list?: WeixinMessageItem[]
  context_token?: string
}

export interface GetUpdatesResp {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WeixinMessage[]
  get_updates_buf?: string
  /** Server-suggested timeout for next poll (ms). */
  longpolling_timeout_ms?: number
}

// ---------------------------------------------------------------------------
// Long-poll for messages
// ---------------------------------------------------------------------------

export async function getUpdates(
  apiBaseUrl: string,
  token: string,
  getUpdatesBuf: string,
  timeoutMs: number = DEFAULT_POLL_TIMEOUT_MS,
): Promise<GetUpdatesResp> {
  const url = `${baseUrl(apiBaseUrl)}/ilink/bot/getupdates`
  // Add 5 s client-side margin so we time out after the server.
  return doPost<GetUpdatesResp>(url, {
    get_updates_buf: getUpdatesBuf,
    base_info: { channel_version: CHANNEL_VERSION },
  }, token, timeoutMs + 5_000, { ret: 0, msgs: [], get_updates_buf: '' }, [524])
}

// ---------------------------------------------------------------------------
// Send message
// ---------------------------------------------------------------------------

export async function sendMessage(
  apiBaseUrl: string,
  token: string,
  toUserId: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  interface SendMessageResp {
    ret?: number
    errcode?: number
    errmsg?: string
  }

  const url = `${baseUrl(apiBaseUrl)}/ilink/bot/sendmessage`
  const clientId = `merlion-${Date.now()}-${randomBytes(3).toString('hex')}`
  const resp = await doPost<SendMessageResp>(url, {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,   // BOT
      message_state: 2,  // FINISH
      item_list: text ? [{ type: 1, text_item: { text } }] : [],
      context_token: contextToken,
    },
  }, token, API_TIMEOUT_MS)

  const errCode = resp?.errcode ?? resp?.ret ?? 0
  if (errCode !== 0) {
    const errMsg = typeof resp?.errmsg === 'string' ? resp.errmsg : ''
    throw new WeixinApiError(
      `sendMessage error: errcode=${errCode}${errMsg ? `, errmsg=${errMsg}` : ''}`,
      errCode,
      errMsg || undefined,
    )
  }
}
