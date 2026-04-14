import { createRequire } from 'node:module'

import { fetchQRCode, pollQRStatus, ILINK_BASE_URL } from './api.ts'
import { saveWeixinCredentials, type WeixinCredentials } from './store.ts'

const MAX_QR_REFRESHES = 3
const MAX_POLL_ERRORS = 3
const POLL_ERROR_RETRY_DELAY_MS = 1_500

type QrcodeTerminal = {
  generate(text: string, opts: { small: boolean }, cb: (qr: string) => void): void
}

/**
 * Display a QR code in the terminal using qrcode-terminal if available,
 * or print a fallback URL the user can paste into WeChat's scan dialog.
 */
async function displayQR(content: string): Promise<void> {
  try {
    const require = createRequire(import.meta.url)
    const qt = require('qrcode-terminal') as QrcodeTerminal
    await new Promise<void>((resolve) => {
      qt.generate(content, { small: true }, (qr) => {
        process.stdout.write('\n' + qr + '\n')
        resolve()
      })
    })
  } catch {
    process.stdout.write(`\n  Scan this content with WeChat:\n  ${content}\n\n`)
  }
}

/**
 * Run the interactive QR-code login flow:
 *   1. Fetch QR from ilinkai
 *   2. Display in terminal
 *   3. Long-poll until confirmed or expired (auto-refresh up to MAX_QR_REFRESHES)
 *   4. Persist credentials
 */
export async function loginWithQRCode(): Promise<WeixinCredentials> {
  process.stdout.write('\n  Fetching WeChat login QR code…\n')

  for (let attempt = 0; attempt < MAX_QR_REFRESHES; attempt++) {
    const qrResp = await fetchQRCode()
    const qrcodeId = qrResp.qrcode
    const qrcodeContent = qrResp.qrcode_img_content

    await displayQR(qrcodeContent)
    process.stdout.write('  Open WeChat → Me → Scan QR Code, then scan the code above.\n')
    process.stdout.write('  Waiting…\n\n')

    let redirectBase: string | undefined
    let pollBaseUrl = ILINK_BASE_URL
    let pollErrors = 0
    let scannedHintShown = false

    // Long-poll until the QR transitions out of 'wait'
    for (;;) {
      let status
      try {
        status = await pollQRStatus(qrcodeId, pollBaseUrl)
      } catch (error) {
        pollErrors += 1
        if (pollErrors > MAX_POLL_ERRORS) {
          throw new Error(
            `WeChat QR login failed while polling status: ${String(error)}\n` +
            'Check your network connection and try `merlion wechat --login` again.'
          )
        }
        process.stdout.write(
          `  QR status poll failed (${pollErrors}/${MAX_POLL_ERRORS}); retrying…\n`
        )
        await new Promise((resolve) => setTimeout(resolve, POLL_ERROR_RETRY_DELAY_MS))
        continue
      }
      pollErrors = 0

      if (status.status === 'scaned_but_redirect' && status.redirect_host) {
        redirectBase = `https://${status.redirect_host}`
        if (pollBaseUrl !== redirectBase) {
          pollBaseUrl = redirectBase
          process.stdout.write(`  QR scanned — switching login host to ${status.redirect_host}…\n`)
        }
      }

      if (status.status === 'scaned_but_redirect' || status.status === 'scaned') {
        if (!scannedHintShown) {
          process.stdout.write('  QR code scanned — confirm in WeChat…\n')
          scannedHintShown = true
        }
        continue
      }

      if (status.status === 'confirmed' && status.bot_token) {
        const creds: WeixinCredentials = {
          botToken: status.bot_token,
          baseUrl: status.baseurl ?? redirectBase ?? ILINK_BASE_URL,
          botId: status.ilink_bot_id ?? '',
          userId: status.ilink_user_id ?? '',
        }
        await saveWeixinCredentials(creds)
        process.stdout.write('  WeChat connected! Credentials saved.\n\n')
        return creds
      }

      if (status.status === 'expired') {
        process.stdout.write(`  QR code expired. Refreshing… (${attempt + 1}/${MAX_QR_REFRESHES})\n`)
        break  // re-fetch QR
      }

      // 'wait' — just keep polling
    }
  }

  throw new Error(
    'WeChat QR login failed: QR code expired too many times.\n' +
    'Check your network connection and run `merlion wechat --login` again.'
  )
}
