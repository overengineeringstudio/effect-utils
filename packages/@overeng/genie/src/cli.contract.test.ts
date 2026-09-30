import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../bin/genie.tsx', import.meta.url))
const runCli = (...args: ReadonlyArray<string>) =>
  spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

describe('genie CLI argument boundaries', () => {
  it.each([
    ['missing option value', ['--cwd']],
    ['invalid phase', ['--phase', 'nope', '--dry-run']],
    ['invalid settings mode', ['github-settings', '--mode', 'delete', '--repo', 'owner/repo']],
    ['missing settings repository', ['github-settings', '--mode', 'check']],
  ] as const)('rejects %s', (_name, args) => {
    const result = runCli(...args)
    expect(result.status).toBe(1)
    expect(result.signal).toBeNull()
  })

  it('keeps argument errors off JSON stdout', () => {
    const result = runCli('--phase', 'nope', '--json')
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })

  it('rejects conflicting output flags without contaminating JSON stdout', () => {
    const result = runCli('--dry-run', '--output', 'json', '--json')
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
  })
})
