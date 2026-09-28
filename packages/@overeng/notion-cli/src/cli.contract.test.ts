import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url))

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

describe('notion CLI argument handling', () => {
  it.each([
    ['missing required database id', ['db', 'info']],
    ['invalid integer', ['md', 'status', '--concurrency', 'nope', 'page.nmd']],
    [
      'invalid integer with json output',
      ['md', 'status', '--concurrency', 'nope', '--json', 'page.nmd'],
    ],
  ] as const)('rejects %s', (_name, args) => {
    const result = runCli(...args)
    expect(result.status).toBe(1)
    expect(result.signal).toBeNull()
    if (args.some((arg: string) => arg === '--json') === true) expect(result.stdout).toBe('')
  })
})

it('rejects conflicting db info output flags', () => {
  const result = runCli('db', 'info', 'db-id', '--output', 'json', '--json')
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
})
