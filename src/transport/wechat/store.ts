import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { configDir } from '../../config/store.ts'

export interface WeixinCredentials {
  botToken: string
  /** Effective API base URL (may differ from ILINK_BASE_URL after IDC redirect). */
  baseUrl: string
  botId: string
  userId: string
}

export function weixinCredsPath(): string {
  return join(configDir(), 'wechat.json')
}

export async function loadWeixinCredentials(): Promise<WeixinCredentials | null> {
  try {
    const raw = await readFile(weixinCredsPath(), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      typeof parsed.botToken !== 'string' || !parsed.botToken ||
      typeof parsed.baseUrl !== 'string' || !parsed.baseUrl
    ) return null
    return {
      botToken: parsed.botToken,
      baseUrl: parsed.baseUrl,
      botId: typeof parsed.botId === 'string' ? parsed.botId : '',
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
    }
  } catch {
    return null
  }
}

export async function saveWeixinCredentials(creds: WeixinCredentials): Promise<void> {
  const dir = configDir()
  await mkdir(dir, { recursive: true })
  await writeFile(
    weixinCredsPath(),
    JSON.stringify(creds, null, 2) + '\n',
    { mode: 0o600, encoding: 'utf8' },
  )
}

export async function clearWeixinCredentials(): Promise<void> {
  const { unlink } = await import('node:fs/promises')
  try {
    await unlink(weixinCredsPath())
  } catch {
    // already gone — no-op
  }
}
