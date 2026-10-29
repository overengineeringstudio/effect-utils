import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createTestTempDirectoryFactory } from './test-tmp.ts'

const createTestTempDirectory = createTestTempDirectoryFactory()
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const yaml = 'name: test\non: push\njobs: {}\n'
const config = 'self-hosted-runner:\n  labels:\n    - test-runner\n'
const actionlintUrl = new URL(
  '../packages/@overeng/genie/src/runtime/github-workflow/actionlint.ts',
  import.meta.url,
).href

/** Real subprocesses exercise the wrapper without changing the test runner's environment. */
const runFixture = (mode: string) => {
  const root = createTestTempDirectory('genie-actionlint-test-')
  roots.push(root)
  const bin = join(root, 'actionlint.mjs')
  const report = join(root, 'report.json')
  writeFileSync(
    bin,
    `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
const configPath = process.argv[process.argv.indexOf('-config-file') + 1]
writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  config: readFileSync(configPath, 'utf8'),
  yaml: readFileSync(0, 'utf8'),
}))
const mode = ${JSON.stringify(mode)}
if (mode === 'fatal') {
  process.stderr.write('fatal fixture error')
  process.exitCode = 2
} else if (mode === 'malformed') {
  process.stdout.write('invalid json')
  process.exitCode = 1
} else if (mode === 'issues') {
  process.stdout.write(JSON.stringify([{ message: 'fixture issue', kind: 'syntax-check', line: 1, column: 1 }]))
  process.exitCode = 1
}
`,
    { mode: 0o755 },
  )
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `import { runActionlint } from ${JSON.stringify(actionlintUrl)}
const result = runActionlint({
  yaml: ${JSON.stringify(yaml)},
  location: '.github/workflows/test.yml',
  config: { selfHostedRunnerLabels: ['test-runner'] },
})
process.stdout.write(JSON.stringify(result.issues))`,
    ],
    {
      env: { ...process.env, TMPDIR: root, GENIE_ACTIONLINT_BIN: bin },
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    },
  )
  expect(result.error).toBeUndefined()
  expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual({ config, yaml })
  expect(readdirSync(root).sort()).toEqual(['actionlint.mjs', 'report.json'])
  return result
}

describe('actionlint config lifecycle', () => {
  it.each(['success', 'issues', 'fatal', 'malformed'])(
    'removes the complete config directory after %s',
    (mode) => {
      const result = runFixture(mode)
      expect(result.status).toBe(mode === 'malformed' ? 1 : 0)
      if (mode === 'success') expect(JSON.parse(result.stdout)).toEqual([])
      if (mode === 'issues') expect(result.stdout).toContain('actionlint-syntax-check')
      if (mode === 'fatal') expect(result.stdout).toContain('actionlint-crash')
    },
  )
})
