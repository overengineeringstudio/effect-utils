import { expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import './buck2-gate-isolation.unit.test.ts'

const entrypoint = new URL('./buck2-entrypoint.ts', import.meta.url).href

it('targets only the selected isolation through native status and kill, retaining unrelated v2', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'buck-gate-isolation-')))
  const cwd = join(root, 'subdir')
  const native = join(root, 'native')
  const calls = join(root, 'calls.jsonl')
  const state = join(root, 'state.json')
  try {
    mkdirSync(join(cwd, 'nested'), { recursive: true })
    writeFileSync(join(root, '.buckroot'), '')
    writeFileSync(
      join(root, '.buckconfig'),
      '[cells]\nroot = .\nalias = .\n[buck2]\nisolation_dir = not-a-native-default\n',
    )
    writeFileSync(join(cwd, 'nested/outer'), '@inner\n')
    writeFileSync(join(cwd, 'inner'), '--flagfile\nflags\n')
    writeFileSync(join(cwd, 'flags'), '--isolation-dir\nowned\nbuild\n//:target\n')
    writeFileSync(join(cwd, 'mode.py'), 'raise Exception("must not execute")\n')
    writeFileSync(
      native,
      `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
const isolation = args[1]
if (args[0] !== '--isolation-dir') process.exit(2)
if (args[2] === 'status') {
  console.log(JSON.stringify({ project_root: ${JSON.stringify(root)}, isolation_dir: isolation, active_commands: [] }))
} else if (args[2] === 'kill') {
  const state = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'))
  state[isolation] = 'stopped'
  writeFileSync(${JSON.stringify(state)}, JSON.stringify(state))
} else process.exit(2)
`,
      { mode: 0o700 },
    )
    const invoke = (
      args: readonly string[],
      env: Record<string, string | undefined>,
      phases: readonly string[],
    ) =>
      spawnSync(
        process.execPath,
        [
          '-e',
          `import { reconcileGateDaemon } from ${JSON.stringify(entrypoint)}
for (const phase of ${JSON.stringify(phases)}) reconcileGateDaemon({ native: ${JSON.stringify(native)}, root: ${JSON.stringify(root)}, args: ${JSON.stringify(args)}, env: process.env, phase })`,
        ],
        { cwd, env: { ...process.env, BUCK_ISOLATION_DIR: undefined, ...env }, encoding: 'utf8' },
      )
    for (const { args, env } of [
      { args: ['@nested/outer'], env: {} },
      { args: ['--flagfile', 'flags'], env: {} },
      { args: ['build'], env: { BUCK_ISOLATION_DIR: 'owned' } },
      { args: ['build', '--isolation-dir=owned'], env: { BUCK_ISOLATION_DIR: 'v2' } },
    ]) {
      writeFileSync(calls, '')
      writeFileSync(state, JSON.stringify({ owned: 'running', v2: 'running' }))
      const result = invoke(args, env, ['exit'])
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(
        readFileSync(calls, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual([
        ['--isolation-dir', 'owned', 'status'],
        ['--isolation-dir', 'owned', 'kill'],
      ])
      expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ owned: 'stopped', v2: 'running' })
    }
    for (const args of [
      ['build', '--isolation-dir'],
      ['build', '--isolation-dir=one', '--isolation-dir=two'],
      ['@missing', 'build'],
      ['@alias//flags', 'build'],
      ['@mode.py', 'build'],
      ['@-', 'build'],
      ['--flagfile=flags', 'build'],
    ]) {
      writeFileSync(calls, '')
      writeFileSync(state, JSON.stringify({ owned: 'running', v2: 'running' }))
      const result = invoke(args, {}, ['start', 'exit'])
      expect(result.status).toBe(0)
      expect(result.stderr).toBe(
        'warning: Buck2 gate retained daemon: native isolation could not be determined safely\n',
      )
      expect(readFileSync(calls, 'utf8')).toBe('')
      expect(JSON.parse(readFileSync(state, 'utf8'))).toEqual({ owned: 'running', v2: 'running' })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
