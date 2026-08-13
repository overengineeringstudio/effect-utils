import { utimes } from 'node:fs/promises'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Clock, Effect, Exit, Layer } from 'effect'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../lib/git.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { Cwd } from './context.ts'
import { mrCommand } from './mod.ts'

const NOW = Date.parse('2026-08-13T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const liveClock = Clock.make()
const fixedClock = Layer.setClock({
  [Clock.ClockTypeId]: Clock.ClockTypeId,
  currentTimeMillis: Effect.succeed(NOW),
  currentTimeNanos: Effect.succeed(BigInt(NOW) * 1_000_000n),
  sleep: (duration) => liveClock.sleep(duration),
  unsafeCurrentTimeMillis: () => NOW,
  unsafeCurrentTimeNanos: () => BigInt(NOW) * 1_000_000n,
})

type JsonResult = {
  readonly path: string
  readonly reason?: string
  readonly outcome?: string
  readonly status: string
}

const runGc = ({
  cwd,
  storePath,
  args,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  args: ReadonlyArray<string>
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    const previous = process.env['MEGAREPO_STORE']
    process.env['MEGAREPO_STORE'] = storePath
    const exit = yield* Cli.Command.run(mrCommand, { name: 'mr', version: 'test' })([
      'node',
      'mr',
      'store',
      'gc',
      '--generated-artifacts',
      ...args,
      '--output',
      'json',
    ]).pipe(
      Effect.provideService(Cwd, cwd),
      Effect.provide(Layer.mergeAll(consoleLayer, fixedClock)),
      Effect.exit,
    )
    if (previous === undefined) delete process.env['MEGAREPO_STORE']
    else process.env['MEGAREPO_STORE'] = previous
    const stdout = (yield* getStdoutLines).join('\n')
    const json = stdout.length === 0 ? undefined : (JSON.parse(stdout) as Record<string, unknown>)
    return {
      exitCode: Exit.isSuccess(exit) === true ? 0 : 1,
      planSha256: json?.['planSha256'] as string | undefined,
      results: (json?.['results'] ?? []) as ReadonlyArray<JsonResult>,
    }
  }).pipe(Effect.scoped)

const fixture = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const created = yield* createStoreFixture([
      { host: 'github.com', owner: 'acme', repo: 'widget', branches: ['feature/artifacts'] },
    ])
    const worktree = created.worktreePaths['github.com/acme/widget#feature/artifacts']!
    const outside = EffectPath.ops.join(
      created.storePath,
      EffectPath.unsafe.relativeDir('../outside/'),
    )
    yield* fs.makeDirectory(outside, { recursive: true })
    const state = EffectPath.ops.join(created.storePath, EffectPath.unsafe.relativeDir('.state/'))
    yield* fs.makeDirectory(state, { recursive: true })
    const manifest = EffectPath.ops.join(state, EffectPath.unsafe.relativeFile('agents.json'))
    const config = EffectPath.ops.join(state, EffectPath.unsafe.relativeFile('gc-config.json'))
    return { ...created, worktree, outside, manifest, config }
  })

const configure = ({
  config,
  manifest,
  activeWorkspacePaths = [],
  expiresAtMs = NOW + DAY_MS,
}: {
  config: string
  manifest?: string | undefined
  activeWorkspacePaths?: ReadonlyArray<string>
  expiresAtMs?: number
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (manifest !== undefined) {
      yield* fs.writeFileString(
        manifest,
        JSON.stringify({ version: 1, expiresAtMs, activeWorkspacePaths }),
      )
    }
    yield* fs.writeFileString(
      config,
      JSON.stringify({
        generatedArtifacts: {
          enabled: true,
          retentionMs: DAY_MS,
          allowlist: ['node_modules', 'dist'],
          ...(manifest !== undefined ? { agentLivenessManifest: manifest } : {}),
        },
      }),
    )
  })

const oldIgnoredArtifact = (worktree: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${worktree}/.gitignore`, 'node_modules/\n')
    yield* Git.runCommand({ args: ['add', '.gitignore'], cwd: worktree })
    yield* Git.runCommand({ args: ['commit', '-m', 'ignore generated dependencies'], cwd: worktree })
    const artifact = `${worktree}/node_modules`
    yield* fs.makeDirectory(artifact, { recursive: true })
    yield* fs.writeFileString(`${artifact}/fixture.txt`, 'generated')
    yield* Effect.promise(() =>
      utimes(
        `${artifact}/fixture.txt`,
        new Date(NOW - 2 * DAY_MS),
        new Date(NOW - 2 * DAY_MS),
      ),
    )
    yield* Effect.promise(() => utimes(artifact, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)))
    return artifact
  })

describe('mr store gc --generated-artifacts', () => {
  it.effect(
    'dry-run plans an old ignored artifact without deleting it',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(result.results.find((row) => row.path === artifact)?.outcome).toBe('would-delete')
        expect(result.planSha256).toMatch(/^[0-9a-f]{64}$/)
        expect(yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(artifact)))).toBe(true)
      },
      Effect.provide(NodeContext.layer),
    ),
  )

  it.effect(
    'recent nested activity keeps an old artifact root',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        yield* Effect.promise(() =>
          utimes(`${artifact}/fixture.txt`, new Date(NOW - 1_000), new Date(NOW - 1_000)),
        )
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(result.results.find((row) => row.path === artifact)?.reason).toBe('retention')
      },
      Effect.provide(NodeContext.layer),
    ),
  )

  it.effect(
    'missing or expired agent manifest fails closed',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        yield* configure({ config: f.config })
        const missing = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(missing.results.find((row) => row.path === artifact)?.outcome).toBe('unknown')
        yield* configure({ config: f.config, manifest: f.manifest, expiresAtMs: NOW - 1 })
        const expired = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(expired.results.find((row) => row.path === artifact)?.reason).toBe(
          'agent-liveness-unavailable',
        )
      },
      Effect.provide(NodeContext.layer),
    ),
  )

  it.effect(
    'dirty worktree and non-ignored artifact are kept',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config, manifest: f.manifest })
        const ignored = yield* oldIgnoredArtifact(f.worktree)
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${f.worktree}/README.md`, 'dirty')
        const dirty = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(dirty.results.find((row) => row.path === ignored)?.reason).toBe('dirty-worktree')
        yield* Git.runCommand({ args: ['add', 'README.md'], cwd: f.worktree })
        yield* Git.runCommand({ args: ['commit', '-m', 'restore clean fixture'], cwd: f.worktree })
        const dist = `${f.worktree}/dist`
        yield* fs.makeDirectory(dist, { recursive: true })
        yield* fs.writeFileString(`${dist}/tracked.txt`, 'tracked')
        yield* Git.runCommand({ args: ['add', 'dist/tracked.txt'], cwd: f.worktree })
        yield* Git.runCommand({ args: ['commit', '-m', 'track dist fixture'], cwd: f.worktree })
        yield* Effect.promise(() => utimes(dist, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)))
        const nonIgnored = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(nonIgnored.results.find((row) => row.path === dist)?.reason).toBe(
          'artifact-not-ignored',
        )
      },
      Effect.provide(NodeContext.layer),
    ),
  )

  it.effect(
    'rejects mutation and expected-plan until a deletion transaction exists',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        expect(
          (yield* runGc({ cwd: f.outside, storePath: f.storePath, args: [] })).exitCode,
        ).toBe(1)
        expect(
          (
            yield* runGc({
              cwd: f.outside,
              storePath: f.storePath,
              args: ['--dry-run', '--expected-plan', '0'.repeat(64)],
            })
          ).exitCode,
        ).toBe(1)
      },
      Effect.provide(NodeContext.layer),
    ),
  )
})
