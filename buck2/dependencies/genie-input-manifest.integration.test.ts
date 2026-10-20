import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const sourceRoot = fileURLToPath(new URL('../../', import.meta.url))
const cliPath = path.join(sourceRoot, 'packages/@overeng/genie/bin/genie.tsx')
const translatorPath = fileURLToPath(new URL('./pnpm-lock.ts', import.meta.url))
const repoContextPath = path.join(
  sourceRoot,
  'packages/@overeng/genie/src/runtime/repo-context/mod.ts',
)

it('regenerates lock-derived output through the real CLI and records the built-in lock reader inputs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'genie-pnpm-inputs-'))
  const lockPath = path.join(root, 'pnpm-lock.yaml')
  const manifest = path.join(root, 'inputs.manifest')
  try {
    mkdirSync(path.join(root, '.git'))
    writeFileSync(
      path.join(root, 'pnpm-workspace.yaml'),
      'packages: []\nignoreScripts: true\nallowBuilds: {}\npatchedDependencies: {}\n',
    )
    const lock = (inject: boolean) => `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
  injectWorkspacePackages: ${inject}
importers:
  .: {}
packages: {}
snapshots: {}
`
    writeFileSync(lockPath, lock(true))
    writeFileSync(
      path.join(root, 'metadata.txt.genie.ts'),
      `
import { translatePnpmLock } from ${JSON.stringify(translatorPath)}
import { defineRepoContext } from ${JSON.stringify(repoContextPath)}
const repo = defineRepoContext({ name: 'fixture', importMetaUrl: import.meta.url })
export default { data: {}, stringify: () => translatePnpmLock({
  lockfileText: repo.readText('pnpm-lock.yaml'),
  workspaceText: repo.readText('pnpm-workspace.yaml'),
}).lockfileFingerprint + '\\n' }
`,
    )
    const run = () => {
      const result = spawnSync('bun', [cliPath, '--cwd', root, '--writeable', '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GENIE_INPUT_MANIFEST: manifest,
          XDG_STATE_HOME: path.join(root, 'state'),
        },
      })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const inputs = readFileSync(manifest, 'utf8').trimEnd().split('\n')
      expect(inputs[0]).toBe('genie-inputs-v1')
      expect(inputs).toContain(lockPath)
      expect(inputs).toContain(path.join(root, 'pnpm-workspace.yaml'))
      expect(inputs).toContain(translatorPath)
      return readFileSync(path.join(root, 'metadata.txt'), 'utf8')
    }
    const first = run()
    expect(first).toMatch(/^sha256:[a-f0-9]{64}\n$/)
    writeFileSync(lockPath, lock(false))
    expect(run()).not.toBe(first)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
