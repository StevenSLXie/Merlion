import type { RuntimeTaskHandler, WechatMessageTaskInput, WechatMessageTaskOutput } from '../types.ts'

export const wechatMessageTaskHandler: RuntimeTaskHandler<WechatMessageTaskInput, WechatMessageTaskOutput> = {
  type: 'wechat_message',
  async run(input, ctx) {
    const result = await ctx.engine.submitPrompt(input.text)
    return {
      result,
      reply: input.renderReply(result),
    }
  },
}
