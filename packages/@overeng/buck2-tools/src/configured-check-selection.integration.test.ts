import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const adapter = fileURLToPath(new URL('./configured-check-selection.mjs', import.meta.url))
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const bun = execFileSync('bash', ['-c', 'command -v bun'], { encoding: 'utf8' }).trim()
const first = 'root//app:check (root//platform:linux#1111)'
const second = 'root//other:check (root//platform:linux#1111)'
const inventory = [first, second]

type Fixture = {
  base: string
  candidate: string
  run: (options?: { mode?: string; side?: string }) => SpawnSyncReturns<string>
  cleanup: () => void
}

const git = ({ root, args }: { root: string; args: readonly string[] }) =>
  execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    },
  }).trim()

const fixture = () => {
  const scratch = join(repository, 'tmp', 'configured-check-selection')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'boundary-'))
  const base = join(root, 'base')
  const candidate = join(root, 'candidate')
  mkdirSync(base)
  git({ root: base, args: ['init', '--quiet'] })
  mkdirSync(join(base, 'src'))
  writeFileSync(join(base, 'src', 'app.ts'), 'export const value = 1\n')
  git({ root: base, args: ['add', '.'] })
  git({ root: base, args: ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'base'] })
  const baseRevision = git({ root: base, args: ['rev-parse', 'HEAD'] })
  git({ root: base, args: ['worktree', 'add', '--quiet', '--detach', candidate, baseRevision] })
  writeFileSync(join(candidate, 'src', 'app.ts'), 'export const value = 2\n')
  git({ root: candidate, args: ['add', '.'] })
  git({
    root: candidate,
    args: ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'candidate'],
  })
  const candidateRevision = git({ root: candidate, args: ['rev-parse', 'HEAD'] })
  const bin = join(root, 'bin')
  mkdirSync(bin)
  // Buck alone is stubbed: deterministic command failures and a mid-query configuration
  // change cannot be induced reliably with a real Buck daemon. Git and the CLI are real.
  writeFileSync(
    join(bin, 'buck2'),
    `#!${bun}
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
const args = process.argv.slice(2)
const side = basename(process.cwd())
const mode = side === process.env.FIXTURE_SIDE ? process.env.FIXTURE_MODE : 'success'
const first = ${JSON.stringify(first)}
const second = ${JSON.stringify(second)}
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(9) }
const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n')
if (args[0] === '--version') process.stdout.write('buck2 fixture-1\\n')
else if (args[0] === 'audit') {
  const marker = join(process.env.FIXTURE_STATE, side + '-audit')
  const repeated = existsSync(marker)
  writeFileSync(marker, 'seen')
  emit({ platform: mode === 'configuration' && repeated ? 'changed' : 'linux' })
} else if (args[0] === 'uquery') {
  if (mode === 'owner') fail('fixture owner query failure')
  const paths = readFileSync(args.at(-1).slice(1), 'utf8').trim().split('\\n')
  emit(Object.fromEntries(paths.map((path) => [path, ['root//app:check']])))
} else if (args[0] === 'cquery') {
  const expression = args.at(-1)
  if (expression === 'required') {
    if (mode === 'inventory') fail('fixture inventory query failure')
    emit({ [first]: {}, [second]: {} })
  } else if (expression.startsWith('deps(')) {
    if (mode === 'graph') fail('fixture graph query failure')
    if (mode === 'source') writeFileSync('src/app.ts', 'changed during collection\\n')
    emit(expression.includes('root//app:check') ? { [first]: {} } : { [second]: {} })
  } else if (expression.startsWith('rdeps(')) {
    if (mode === 'reverse') fail('fixture reverse query failure')
    emit([first])
  } else fail('unexpected expression: ' + expression)
} else fail('unexpected Buck invocation: ' + args.join(' '))
`,
    { mode: 0o700 },
  )
  const settings = { buck2: 'buck2', requiredQuery: 'required', universeQuery: '//...' }
  const manifest = join(root, 'manifest.json')
  writeFileSync(
    manifest,
    JSON.stringify({
      base: { ...settings, root: base, revision: baseRevision },
      candidate: { ...settings, root: candidate, revision: candidateRevision },
      scratch: join(root, 'queries'),
    }),
  )
  return {
    base,
    candidate,
    run: ({ mode = 'success', side = 'candidate' } = {}) =>
      spawnSync(bun, [adapter, manifest], {
        encoding: 'utf8',
        timeout: 30000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env['PATH'] ?? ''}`,
          FIXTURE_MODE: mode,
          FIXTURE_SIDE: side,
          FIXTURE_STATE: root,
        },
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const withFixture = (run: (value: Fixture) => void) => {
  const value = fixture()
  try {
    run(value)
  } finally {
    value.cleanup()
  }
}

const expectRejected = ({ result, error }: { result: SpawnSyncReturns<string>; error: string }) => {
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toContain(error)
}

describe('configured selection CLI with real source pins', () => {
  it('selects only the affected target when collection succeeds', () => {
    withFixture(({ run }) => {
      const result = run()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: 'affected',
        targets: [first],
        fullTargets: inventory,
        changedPaths: ['src/app.ts'],
        baseGraph: { complete: true },
        candidateGraph: { complete: true },
      })
    })
  })

  it.each(['tracked', 'untracked'])('rejects a dirty candidate pin: %s', (kind) => {
    withFixture(({ candidate, run }) => {
      writeFileSync(join(candidate, kind === 'tracked' ? 'src/app.ts' : 'extra.ts'), 'dirty\n')
      expectRejected({
        result: run(),
        error: 'snapshot has tracked or query-visible untracked modifications',
      })
    })
  })

  it('rejects a moved candidate pin', () => {
    withFixture(({ candidate, run }) => {
      git({
        root: candidate,
        args: [
          '-c',
          'core.hooksPath=/dev/null',
          'commit',
          '--quiet',
          '--allow-empty',
          '-m',
          'moved',
        ],
      })
      expectRejected({ result: run(), error: 'snapshot worktree does not match pinned revision' })
    })
  })

  it('rejects source mutation during collection', () => {
    withFixture(({ run }) => {
      expectRejected({
        result: run({ mode: 'source' }),
        error: 'snapshot changed during configured queries',
      })
    })
  })

  it('rejects effective configuration mutation during collection', () => {
    withFixture(({ run }) => {
      expectRejected({
        result: run({ mode: 'configuration' }),
        error: 'effective Buck configuration changed during configured queries',
      })
    })
  })

  for (const side of ['base', 'candidate']) {
    it.each(['graph', 'owner', 'reverse'])(
      `falls back to the full inventory on ${side} %s failure`,
      (mode) => {
        withFixture(({ run }) => {
          const result = run({ mode, side })
          expect(result.status, result.stderr).toBe(0)
          const selection = JSON.parse(result.stdout)
          expect(selection).toMatchObject({
            mode: 'full',
            targets: inventory,
            fullTargets: inventory,
          })
          expect(selection.reasons).toContain('incomplete-configured-query')
          expect(selection[`${side}Graph`]).toMatchObject({
            complete: false,
            error: expect.stringContaining(`fixture ${mode} query failure`),
          })
        })
      },
    )
  }

  it('exits nonzero instead of emitting an empty selection when candidate inventory fails', () => {
    withFixture(({ run }) => {
      expectRejected({
        result: run({ mode: 'inventory' }),
        error: 'fixture inventory query failure',
      })
    })
  })

  it('retains the full candidate inventory when base inventory fails', () => {
    withFixture(({ run }) => {
      const result = run({ mode: 'inventory', side: 'base' })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: 'full',
        targets: inventory,
        baseGraph: {
          complete: false,
          error: expect.stringContaining('fixture inventory query failure'),
        },
        candidateGraph: { complete: true },
      })
    })
  })
})
