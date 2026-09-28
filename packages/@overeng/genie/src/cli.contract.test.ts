import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../bin/genie.tsx', import.meta.url))
const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
  }
}

describe('genie CLI argument handling', () => {
  it.each([
    ['missing option value', ['--cwd']],
    ['invalid phase', ['--phase', 'nope', '--dry-run']],
    ['invalid phase with json output', ['--phase', 'nope', '--json']],
  ] as const)('rejects %s', (_name, args) => {
    const result = runCli(...args)
    expect(result.status).toBe(1)
    expect(result.signal).toBeNull()
    if (args.some((arg: string) => arg === '--json') === true) expect(result.stdout).toBe('')
  })
})

it('rejects conflicting output flags', () => {
  const result = runCli('--dry-run', '--output', 'json', '--json')
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
})
