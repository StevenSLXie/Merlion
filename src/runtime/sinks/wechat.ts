import type { WeixinRunOptions } from '../../transport/wechat/run.ts'

export async function launchWeixinSinkMode(options: WeixinRunOptions): Promise<void> {
  const { runWeixinMode } = await import('../../transport/wechat/run.ts')
  await runWeixinMode(options)
}
