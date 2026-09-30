import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../bin/ci-tools.ts', import.meta.url))

const runCli = (...args: ReadonlyArray<string>) =>
  spawnSync('bun', [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })

describe('ci-tools command validation', () => {
  it('rejects a missing workflow bundle identifier', () => {
    const result = runCli('workflow-report', 'collect-bundle')
    expect(result.status).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('--bundle-id')
  })

  it('rejects an unsupported deployment mode', () => {
    const result = runCli(
      'deploy',
      'netlify',
      '--target',
      'web',
      '--artifact-dir',
      '/tmp',
      '--mode',
      'nope',
    )
    expect(result.status).toBe(1)
    expect(result.signal).toBeNull()
    expect(result.stderr).toContain('--mode')
  })
})
