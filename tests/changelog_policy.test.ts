import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

test('release policy: current package version must have a changelog file', async () => {
  const root = process.cwd()
  const pkgRaw = await readFile(join(root, 'package.json'), 'utf8')
  const pkg = JSON.parse(pkgRaw) as { version?: unknown }
  assert.equal(typeof pkg.version, 'string')
  const version = pkg.version as string

  const path = join(root, 'docs', 'change_log', `v${version}.log`)
  await access(path, constants.F_OK)

  const text = await readFile(path, 'utf8')
  assert.ok(text.trim().length > 0, 'changelog file must be non-empty')
})
