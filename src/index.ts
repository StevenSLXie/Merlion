import { createRequire } from 'node:module'

import { createDefaultCliFlags, parseCliArgs, printUsage } from './bootstrap/cli_args.ts'
import { resolveCliConfig } from './bootstrap/config_resolver.ts'
import { restoreGitCheckpoint } from './runtime/checkpoints.ts'
import { runCliRuntime } from './runtime/runner.ts'
import { launchWeixinSinkMode } from './runtime/sinks/wechat.ts'

async function main(): Promise<void> {
  const flags = parseCliArgs(process.argv.slice(2))
  if (flags === 'version') {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version: string }
    process.stdout.write(`${pkg.version}\n`)
    return
  }
  if (flags === 'help') {
    printUsage()
    return
  }

  const resolvedFlags = flags ?? createDefaultCliFlags()
  if (resolvedFlags.undoMode) {
    const restored = await restoreGitCheckpoint({
      cwd: resolvedFlags.cwd,
      sessionId: resolvedFlags.undoSessionId,
    })
    if (!restored) {
      process.stdout.write('[undo] No active checkpoint found for this project.\n')
      return
    }
    const backupHint = restored.preRestoreBackupStashCommit
      ? ` Current dirty state was stashed as ${restored.preRestoreBackupStashCommit} (${restored.preRestoreBackupStashMessage}).`
      : ''
    process.stdout.write(`[undo] Restored checkpoint ${restored.checkpointId} for session ${restored.sessionId}.${backupHint}\n`)
    return
  }
  const config = await resolveCliConfig(resolvedFlags)
  if (!config.ok) {
    process.exitCode = config.exitCode
    return
  }
  if (config.shouldExitAfterConfig) {
    return
  }

  if (resolvedFlags.wechatMode) {
    await launchWeixinSinkMode({
      model: config.config.model,
      baseURL: config.config.baseURL,
      apiKey: config.config.apiKey,
      cwd: resolvedFlags.cwd,
      forceLogin: resolvedFlags.wechatLogin,
      permissionMode: resolvedFlags.permissionMode,
      sandboxMode: config.config.sandboxMode,
      approvalPolicy: 'never',
      networkMode: config.config.networkMode,
      writableRoots: config.config.writableRoots,
      denyRead: config.config.denyRead,
      denyWrite: config.config.denyWrite,
    })
    return
  }

  process.exitCode = await runCliRuntime({
    task: resolvedFlags.task,
    provider: config.config.provider,
    model: config.config.model,
    baseURL: config.config.baseURL,
    apiKey: config.config.apiKey,
    cwd: resolvedFlags.cwd,
    permissionMode: resolvedFlags.permissionMode,
    sandboxMode: config.config.sandboxMode,
    approvalPolicy: config.config.approvalPolicy,
    networkMode: config.config.networkMode,
    writableRoots: config.config.writableRoots,
    denyRead: config.config.denyRead,
    denyWrite: config.config.denyWrite,
    resumeSessionId: resolvedFlags.resumeSessionId,
    repl: resolvedFlags.repl,
    verify: resolvedFlags.verify,
  })
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
