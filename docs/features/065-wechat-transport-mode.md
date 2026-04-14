# Feature 065: WeChat Transport Mode

Status: `done`  
Type: `P1 Transport`

## Goal

支持通过 WeChat 接收消息并驱动 Merlion 运行；提供二维码登录流程，并允许在 REPL 内用命令触发二维码登录。

## Spec

- 新增 CLI 入口：
  - `merlion wechat`
  - `merlion wechat --login`
- 新增 REPL 命令：
  - `:wechat`
  - `/wechat`
  - 行为：登录后直接进入 WeChat 监听模式（`Ctrl+C` 返回 REPL）
- WeChat 登录流程：
  1. `GET /ilink/bot/get_bot_qrcode?bot_type=3`
  2. 终端渲染二维码（`qrcode-terminal`），失败时回退文本 URL
  3. 轮询 `GET /ilink/bot/get_qrcode_status?qrcode=<id>` 直到 `confirmed`
  4. 保存凭据 `{ botToken, baseUrl, botId, userId }` 到 `~/.config/merlion/wechat.json`
- 消息收发流程：
  - `POST /ilink/bot/getupdates` 长轮询获取入站消息
  - 仅处理 `message_type == 1`（用户发给 bot）
  - 以 `message_id` 去重
  - 回复前将 markdown 转为纯文本并按 4000 字拆分
  - 发送 `POST /ilink/bot/sendmessage`

## Implementation

- `src/index.ts`
  - 新增 `wechat/connect` 参数解析与 `--login`。
  - 新增 WeChat transport 分支。
  - REPL 新增 `onWechatLogin` 回调，执行二维码登录并进入监听模式。
- `src/cli/repl.ts`
  - 新增 `:wechat` 与 `/wechat` 命令解析与执行分支。
  - Help 文案更新。
- `src/cli/experience.ts`
  - REPL banner 命令提示增加 `:wechat (/wechat)`。
- `src/transport/wechat/api.ts`
  - 封装 QR、轮询、消息拉取、消息发送 API。
- `src/transport/wechat/auth.ts`
  - 二维码渲染和登录确认流程。
- `src/transport/wechat/store.ts`
  - 凭据持久化、读取、清理。
- `src/transport/wechat/text_render.ts`
  - markdown 转纯文本与消息分片。
- `src/transport/wechat/run.ts`
  - WeChat 主循环与并发处理。
  - 修复：每个 sender 初始化 history 时使用完整 `systemPrompt`，避免回退到硬编码简化 prompt。
  - 微信回复降级策略：`max_turns_exceeded` / 空 finalText 时返回可读提示，不再发送 `(no response)`。
  - 逐轮进度推送改为显式开启：`MERLION_WECHAT_PROGRESS=1`（`MERLION_WECHAT_PROGRESS_VERBOSE=1` 开启工具批次细节）。
  - 发送链路增强：`sendmessage` 除 HTTP 状态外还校验 `ret/errcode`，并带重试，降低“CLI 显示成功但微信端丢消息”概率。
  - 限流保护：命中 `errcode=-2` 时自动停止该请求后续进度推送，并避免无效重试风暴。
  - 进度推送默认每请求上限 `10`（`MERLION_WECHAT_MAX_PROGRESS_UPDATES` 可调）。
  - 支持 `MERLION_WECHAT_MAX_TURNS` 调整轮次上限。

## Tests

- `tests/transport_wechat_api.test.ts`
- `tests/transport_wechat_store.test.ts`
- `tests/transport_wechat_text_render.test.ts`
- `tests/repl.test.ts`
  - 覆盖 `:wechat`/`/wechat` 解析与回调触发。
