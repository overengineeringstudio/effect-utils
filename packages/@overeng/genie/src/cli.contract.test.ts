import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { normalizeCliOutput } from '@overeng/utils-dev/cli-contract'

const cliPath = fileURLToPath(new URL('../bin/genie.tsx', import.meta.url))
// Prefer the checkout root. Buck's hermetic test package tree deliberately has
// no repository metadata, so retain the package root as a fallback instead of
// deriving either root from import.meta.url's environment-dependent depth.
const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  let packageTreeRoot: string | undefined
  for (;;) {
    if (existsSync(join(dir, '.git')) === true) return dir
    if (
      packageTreeRoot === undefined &&
      existsSync(join(dir, 'package.json')) === true &&
      existsSync(join(dir, 'bin', 'genie.tsx')) === true
    ) {
      packageTreeRoot = dir
    }
    const parent = dirname(dir)
    if (parent === dir) {
      if (packageTreeRoot !== undefined) return packageTreeRoot
      throw new Error('repo or package-tree root not found')
    }
    dir = parent
  }
})()

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the genie owner during
 * Effect 4 repair with an alignment-register entry.
 * The local-source version suffix, log timestamps, and absolute checkout paths
 * (v4 `CliError` output embeds stack-frame file paths) are normalized, so
 * version-string content, log timing, and machine-specific paths are not gated
 * by this baseline.
 */
const normalizeOutput = (input: string): string =>
  normalizeCliOutput({
    input,
    ansi: true,
    time: true,
    repoRoot,
    effectCliInternals: true,
  })

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    stdout: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr),
  }
}

describe('genie CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['version', ['--version']],
    ['missing option value', ['--cwd']],
    ['invalid phase', ['--phase', 'nope', '--dry-run']],
    ['invalid phase with json output (stdout guard)', ['--phase', 'nope', '--json']],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })
})

it('rejects conflicting output flags', () => {
  const result = runCli('--dry-run', '--output', 'json', '--json')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('use only one of --output / -o or --json')
})
