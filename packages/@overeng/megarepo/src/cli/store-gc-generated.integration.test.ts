import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { symlink, utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Clock, Duration, Effect, Exit, Layer } from 'effect'
import * as Cli from 'effect/cli'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import {
  acquireDeletionLease,
  canonicalizeOwnerPath,
  deletionLeasePath,
  releaseDeletionLease,
} from '../store/store-deletion-lease.ts'
import { makeConsoleCapture } from '../test-utils/consoleCapture.ts'
import { decodeJson, encodeJson } from '../test-utils/json.ts'
import { createStoreFixture } from '../test-utils/store-setup.ts'
import { Cwd } from './context.ts'
import { mrCommand } from './mod.ts'

const NOW = Date.now()
const DAY_MS = 24 * 60 * 60 * 1000
/** Live wall-clock layer so command timeouts stay on wall time. */
const liveClock = Layer.succeed(Clock.Clock, {
  currentTimeMillisUnsafe: () => Date.now(),
  currentTimeMillis: Effect.sync(() => Date.now()),
  currentTimeNanosUnsafe: () => BigInt(Date.now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(Date.now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => process.hrtime.bigint(),
  monotonicTimeNanos: Effect.sync(() => process.hrtime.bigint()),
  sleep: (duration) =>
    Effect.callback((resume) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration))
      timer.unref?.()
    }),
})

type JsonResult = {
  readonly artifactClass?: string
  readonly kind?: string
  readonly path: string
  readonly reason?: string
  readonly outcome?: string
  readonly status: string
  readonly message?: string
}

const generated = (results: ReadonlyArray<JsonResult>, artifactClass: string) =>
  results.find((row) => row.kind === 'generated-artifact' && row.artifactClass === artifactClass)

type ActivityBinaries = {
  readonly st3?: string
  readonly pty?: string
}

const runGc = ({
  cwd,
  storePath,
  args,
  generatedArtifacts = true,
  activityBins,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  args: ReadonlyArray<string>
  generatedArtifacts?: boolean
  activityBins?: ActivityBinaries
}) =>
  Effect.gen(function* () {
    const { consoleLayer, getStdoutLines } = yield* makeConsoleCapture
    const previousStore = process.env['MEGAREPO_STORE']
    const previousPath = process.env['PATH']
    const previousSt3 = process.env['MEGAREPO_GC_ST3_BIN']
    const previousPty = process.env['MEGAREPO_GC_PTY_BIN']
    process.env['MEGAREPO_STORE'] = storePath
    process.env['PATH'] = `${storePath}/.state/bin:${previousPath ?? ''}`
    if (activityBins?.st3 === undefined) delete process.env['MEGAREPO_GC_ST3_BIN']
    else process.env['MEGAREPO_GC_ST3_BIN'] = activityBins.st3
    if (activityBins?.pty === undefined) delete process.env['MEGAREPO_GC_PTY_BIN']
    else process.env['MEGAREPO_GC_PTY_BIN'] = activityBins.pty
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (previousStore === undefined) delete process.env['MEGAREPO_STORE']
        else process.env['MEGAREPO_STORE'] = previousStore
        if (previousPath === undefined) delete process.env['PATH']
        else process.env['PATH'] = previousPath
        if (previousSt3 === undefined) delete process.env['MEGAREPO_GC_ST3_BIN']
        else process.env['MEGAREPO_GC_ST3_BIN'] = previousSt3
        if (previousPty === undefined) delete process.env['MEGAREPO_GC_PTY_BIN']
        else process.env['MEGAREPO_GC_PTY_BIN'] = previousPty
      }),
    )
    const exit = yield* Cli.Command.runWith(mrCommand, { version: 'test' })([
      'store',
      'gc',
      ...(generatedArtifacts === true ? ['--generated-artifacts'] : []),
      ...args,
      '--output',
      'json',
    ]).pipe(
      Effect.provideService(Cwd, cwd),
      Effect.provide(Layer.mergeAll(consoleLayer, liveClock, NodeServices.layer)),
      Effect.exit,
    )
    const stdout = (yield* getStdoutLines).join('\n')
    const json = stdout.length === 0 ? undefined : (decodeJson(stdout) as Record<string, unknown>)
    return {
      json,
      exitCode: Exit.isSuccess(exit) === true ? 0 : 1,
      planSha256: json?.['planSha256'] as string | undefined,
      completedRepoCount: json?.['completedRepoCount'] as number | undefined,
      discoveredWorktreeCount: json?.['discoveredWorktreeCount'] as number | undefined,
      activeWorktreeCount: json?.['activeWorktreeCount'] as number | undefined,
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
    const config = EffectPath.ops.join(state, EffectPath.unsafe.relativeFile('gc-config.json'))
    const bin = `${state}/bin`
    yield* fs.makeDirectory(bin, { recursive: true })
    yield* fs.writeFileString(
      `${bin}/st3`,
      '#!/bin/sh\nbase="${0%/*}/.."\ncase "$1 $2" in\n"agents ls") exec cat "$base/agents.json";;\n"subject show") exec cat "$base/subject.json";;\n*) exit 64;;\nesac\n',
    )
    yield* fs.writeFileString(
      `${bin}/pty`,
      '#!/bin/sh\n[ "$1" = list ] || exit 64\nbase="${0%/*}/.."\nif [ -f "$base/lease-trigger-path" ] && [ -f "$(cat "$base/lease-trigger-path")" ]; then\n  : > "$base/lease-hook-fired"\n  exec cat "$base/lease-live.json"\nfi\nexec cat "$base/pty.json"\n',
    )
    yield* fs.chmod(`${bin}/st3`, 0o755)
    yield* fs.chmod(`${bin}/pty`, 0o755)
    yield* configure({ config })
    return { ...created, worktree, outside, config }
  })

const HOST = `host/${hostname()}`

const agentListing = ({
  activeWorkspacePaths = [],
  createdAtMs = Date.now(),
  hasMore = false,
  syncState,
}: {
  activeWorkspacePaths?: ReadonlyArray<string>
  createdAtMs?: number
  hasMore?: boolean
  syncState?: string
} = {}) => ({
  api_version: 'st3.client.v0',
  snapshot: {
    id: 'test-snapshot',
    host_id: HOST,
    created_at: new Date(createdAtMs).toISOString(),
    store_index: 1,
  },
  value: {
    kind: 'page',
    collection: 'agents',
    items: activeWorkspacePaths.map((_, index) => ({ id: `test.agent.${index}` })),
    page: { has_more: hasMore, next_cursor: null },
    ...(syncState === undefined ? {} : { sync: { state: syncState } }),
  },
})

/** Only st3 and pty are stubbed; git and native process-table reads remain real. */
const configure = ({
  config,
  activeWorkspacePaths = [],
  listing = agentListing({ activeWorkspacePaths }),
  subjects = activeWorkspacePaths.map((workspace, index) => ({
    subject: `test.agent.${index}`,
    actual: { status: 'running', workspace, host: hostname() },
  })),
  ptys = [],
  st3Available = true,
  ptyAvailable = true,
}: {
  config: string
  activeWorkspacePaths?: ReadonlyArray<string>
  listing?: unknown
  subjects?: ReadonlyArray<unknown>
  ptys?: unknown
  st3Available?: boolean
  ptyAvailable?: boolean
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const state = config.slice(0, config.lastIndexOf('/'))
    if (st3Available === true) {
      yield* fs.writeFileString(`${state}/agents.json`, encodeJson(listing))
    } else {
      yield* fs.remove(`${state}/agents.json`, { force: true })
    }
    yield* fs.writeFileString(
      `${state}/subject.json`,
      encodeJson({ status: { store_index: 1, subjects } }),
    )
    if (ptyAvailable === true) {
      yield* fs.writeFileString(`${state}/pty.json`, encodeJson(ptys))
    } else {
      yield* fs.remove(`${state}/pty.json`, { force: true })
    }
    yield* fs.writeFileString(
      config,
      encodeJson({
        generatedArtifacts: {
          enabled: true,
          retentionMs: DAY_MS,
          allowlist: ['node_modules', 'dist', 'storybook-static'],
        },
      }),
    )
  })

const oldIgnoredArtifact = (
  worktree: AbsoluteDirPath,
  artifactClass: 'node_modules' | 'storybook-static' = 'node_modules',
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.writeFileString(`${worktree}/.gitignore`, `${artifactClass}/\n`)
    yield* Git.runCommand({ args: ['add', '.gitignore'], cwd: worktree })
    yield* Git.runCommand({
      args: ['commit', '-m', 'ignore generated dependencies'],
      cwd: worktree,
    })
    const artifact = `${worktree}/${artifactClass}`
    yield* fs.makeDirectory(artifact, { recursive: true })
    yield* fs.writeFileString(`${artifact}/fixture.txt`, 'generated')
    yield* Effect.promise(() =>
      utimes(`${artifact}/fixture.txt`, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)),
    )
    yield* Effect.promise(() =>
      utimes(artifact, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)),
    )
    return artifact
  })

/** A real CLI subprocess is a sibling of the holder, unlike the in-process test runner. */
const runNativeGc = ({
  cwd,
  storePath,
  args,
  activityBins,
}: {
  cwd: AbsoluteDirPath
  storePath: AbsoluteDirPath
  args: ReadonlyArray<string>
  activityBins?: ActivityBinaries
}) => {
  const result = spawnSync(
    'bun',
    [
      fileURLToPath(new URL('../../bin/mr.ts', import.meta.url)),
      'store',
      'gc',
      '--generated-artifacts',
      ...args,
      '--output',
      'json',
    ],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        MEGAREPO_STORE: storePath,
        PATH: `${storePath}/.state/bin:${process.env['PATH'] ?? ''}`,
        MEGAREPO_GC_ST3_BIN: activityBins?.st3,
        MEGAREPO_GC_PTY_BIN: activityBins?.pty,
        NO_COLOR: '1',
      },
    },
  )
  const json =
    result.stdout.length === 0 ? undefined : (decodeJson(result.stdout) as Record<string, unknown>)
  return {
    exitCode: result.status,
    stderr: result.stderr,
    planSha256: json?.['planSha256'] as string | undefined,
    results: (json?.['results'] ?? []) as ReadonlyArray<JsonResult>,
  }
}

const spawnHolder = (cwd: string): Promise<ChildProcess> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>()
  const child = spawn('sleep', ['120'], { cwd, stdio: 'ignore' })
  child.once('spawn', () => resolve(child))
  child.once('error', reject)
  return promise
}

const killHolder = (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGKILL')
  return promise
}

describe('mr store gc --generated-artifacts', () => {
  it.effect(
    'dry-run plans an old ignored artifact without deleting it',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        const row = generated(result.results, 'node_modules')
        expect(row?.outcome, row?.message).toBe('would-delete')
        expect(row).toMatchObject({
          kind: 'generated-artifact',
          artifactClass: 'node_modules',
          path: `${yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.realPath(artifact)))}/`,
          status: 'kept',
          outcome: 'would-delete',
        })
        expect(result.completedRepoCount).toBe(1)
        expect(result.discoveredWorktreeCount).toBe(1)
        expect(result.activeWorktreeCount).toBe(0)
        expect(result.planSha256).toMatch(/^[0-9a-f]{64}$/)
        expect(result.json).toMatchObject({
          basePath: f.storePath,
          dryRun: true,
          done: true,
          censusStatus: 'complete',
          completedRepoCount: 1,
          discoveredWorktreeCount: 1,
          activeWorktreeCount: 0,
          planSha256: result.planSha256,
          results: result.results,
        })
        const repeated = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(repeated.planSha256).toBe(result.planSha256)
        expect(yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(artifact)))).toBe(
          true,
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'uses configured native paths and executable names instead of poisoned PATH defaults',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        const state = `${f.storePath}/.state`
        const explicit = `${state}/explicit-bins`
        yield* fs.makeDirectory(explicit)
        const activityBins = { st3: `${explicit}/native-st3`, pty: `${explicit}/native-pty` }
        const executableNames = { st3: 'native-st3', pty: 'native-pty' }
        for (const name of ['st3', 'pty'] as const) {
          const script = yield* fs.readFileString(`${state}/bin/${name}`)
          yield* fs.writeFileString(activityBins[name], script)
          yield* fs.writeFileString(`${state}/bin/${executableNames[name]}`, script)
          yield* fs.chmod(`${state}/bin/${executableNames[name]}`, 0o755)
          yield* fs.chmod(activityBins[name], 0o755)
          yield* fs.writeFileString(`${state}/bin/${name}`, '#!/bin/sh\nexit 79\n')
        }
        const result = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
          activityBins,
        })
        expect(generated(result.results, 'node_modules')).toMatchObject({
          outcome: 'would-delete',
          reason: 'eligible',
        })
        const native = runNativeGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
          activityBins,
        })
        expect(native.exitCode, native.stderr).toBe(0)
        expect(generated(native.results, 'node_modules')).toMatchObject({
          outcome: 'would-delete',
          reason: 'eligible',
        })
        const named = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
          activityBins: executableNames,
        })
        expect(generated(named.results, 'node_modules')).toMatchObject({
          outcome: 'would-delete',
          reason: 'eligible',
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    30_000,
  )

  it.effect(
    'fails closed for each invalid explicit native binary without falling back to healthy PATH',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        const healthy = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(generated(healthy.results, 'node_modules')?.outcome).toBe('would-delete')
        for (const activityBins of [
          { st3: `${f.outside}/missing-st3` },
          { pty: `${f.outside}/missing-pty` },
          { st3: '' },
          { pty: '' },
        ]) {
          const invalid = yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run'],
            activityBins,
          })
          expect(generated(invalid.results, 'node_modules')).toMatchObject({
            outcome: 'unknown',
            reason: 'agent-liveness-unavailable',
          })
        }
        const restored = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(generated(restored.results, 'node_modules')?.outcome).toBe('would-delete')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'admits idle projection timestamps while still protecting observed active workspaces',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        yield* configure({
          config: f.config,
          listing: agentListing({ createdAtMs: 0 }),
        })
        const idle = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(generated(idle.results, 'node_modules')).toMatchObject({
          outcome: 'would-delete',
          reason: 'eligible',
        })
        yield* configure({
          config: f.config,
          activeWorkspacePaths: [f.worktree],
          listing: agentListing({ activeWorkspacePaths: [f.worktree], createdAtMs: NOW - DAY_MS }),
        })
        const active = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(generated(active.results, 'node_modules')).toMatchObject({
          outcome: 'keep',
          reason: 'live',
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'treats unknown and running st3 actual statuses as active across composed workspace roots',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        for (const { status, workspace } of [
          { status: 'running', workspace: yield* fs.realPath(f.storePath) },
          { status: 'future-active-status', workspace: yield* fs.realPath(artifact) },
        ]) {
          yield* configure({
            config: f.config,
            activeWorkspacePaths: [workspace],
            subjects: [
              {
                subject: 'test.agent.0',
                actual: { status, workspace, host: hostname(), terminal: true },
              },
            ],
          })
          const result = yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run'],
          })
          expect(generated(result.results, 'node_modules')).toMatchObject({
            outcome: 'keep',
            reason: 'live',
          })
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'allows a definitely stopped st3 agent with no remaining workspace',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        yield* configure({
          config: f.config,
          activeWorkspacePaths: [f.worktree],
          subjects: [
            {
              subject: 'test.agent.0',
              actual: { status: 'stopped', terminal: true, host: hostname(), exit_code: 0 },
            },
          ],
        })
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(generated(result.results, 'node_modules')).toMatchObject({
          outcome: 'would-delete',
          reason: 'eligible',
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refuses a PTY that becomes live while apply holds the owner deletion lease',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const plan = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        const candidate = generated(plan.results, 'node_modules')!
        expect(candidate.outcome).toBe('would-delete')
        const state = `${f.storePath}/.state`
        const leasePath = deletionLeasePath({
          storeBasePath: f.storePath,
          ownerPath: yield* canonicalizeOwnerPath(f.worktree),
        })
        yield* fs.writeFileString(`${state}/lease-trigger-path`, leasePath)
        yield* fs.writeFileString(
          `${state}/lease-live.json`,
          encodeJson([{ name: 'activation', status: 'running', pid: process.pid, cwd: artifact }]),
        )
        const args = ['--expected-plan', plan.planSha256!, '--candidate-path', candidate.path]
        const refused = yield* runGc({ cwd: f.outside, storePath: f.storePath, args })
        expect(refused.exitCode).toBe(1)
        expect(yield* fs.exists(`${state}/lease-hook-fired`)).toBe(true)
        expect(yield* fs.exists(artifact)).toBe(true)
        expect(yield* fs.exists(leasePath)).toBe(false)
        yield* fs.remove(`${state}/lease-trigger-path`)
        const applied = yield* runGc({ cwd: f.outside, storePath: f.storePath, args })
        expect(applied.exitCode).toBe(0)
        expect(yield* fs.exists(artifact)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'running, retained exited, and vanished PTY cwd records veto until removed',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const idle = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        const candidate = generated(idle.results, 'node_modules')!
        expect(candidate.outcome).toBe('would-delete')
        const pty = { name: 'fixture-holder', cwd: artifact, tags: ['test'] }
        const args = ['--expected-plan', idle.planSha256!, '--candidate-path', candidate.path]
        for (const status of ['running', 'exited', 'vanished']) {
          yield* configure({
            config: f.config,
            ptys: [{ ...pty, status, pid: status === 'running' ? process.pid : null }],
          })
          const retained = yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run'],
          })
          expect(generated(retained.results, 'node_modules')).toMatchObject({
            outcome: 'keep',
            reason: 'live',
          })
          const refused = yield* runGc({ cwd: f.outside, storePath: f.storePath, args })
          expect(refused.exitCode).toBe(1)
          expect(yield* fs.exists(artifact)).toBe(true)
        }
        yield* configure({ config: f.config, ptys: [] })
        const removed = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(generated(removed.results, 'node_modules')?.outcome).toBe('would-delete')
        expect(removed.planSha256).toBe(idle.planSha256)
        const applied = yield* runGc({ cwd: f.outside, storePath: f.storePath, args })
        expect(applied.exitCode).toBe(0)
        expect(yield* fs.exists(artifact)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'fails closed for invalid native PTY records instead of ignoring live sessions',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        for (const ptys of [
          { sessions: [] },
          [{ name: 'fixture-holder', status: 'running', pid: process.pid }],
          [{ name: 'fixture-holder', status: 'unknown', pid: process.pid, cwd: f.worktree }],
        ]) {
          yield* configure({ config: f.config, ptys })
          const result = yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run'],
          })
          expect(generated(result.results, 'node_modules')).toMatchObject({
            outcome: 'unknown',
            reason: 'agent-liveness-unavailable',
          })
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
    'native process cwd blocks dry-run and apply until the real holder exits',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const plan = runNativeGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(plan.exitCode, plan.stderr).toBe(0)
        const candidate = generated(plan.results, 'node_modules')!
        expect(candidate.outcome).toBe('would-delete')
        const holder = yield* Effect.acquireRelease(
          Effect.promise(() => spawnHolder(artifact)),
          (child) => Effect.promise(() => killHolder(child)),
        )
        const live = runNativeGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(live.exitCode, live.stderr).toBe(0)
        expect(generated(live.results, 'node_modules')).toMatchObject({
          outcome: 'keep',
          reason: 'live',
        })
        const args = ['--expected-plan', plan.planSha256!, '--candidate-path', candidate.path]
        const refused = runNativeGc({ cwd: f.outside, storePath: f.storePath, args })
        expect(refused.exitCode, refused.stderr).toBe(1)
        expect(yield* fs.exists(artifact)).toBe(true)
        yield* Effect.promise(() => killHolder(holder))
        const applied = runNativeGc({ cwd: f.outside, storePath: f.storePath, args })
        expect(applied.exitCode, applied.stderr).toBe(0)
        expect(yield* fs.exists(artifact)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
    30_000,
  )

  it.effect(
    'fails closed when a nonterminal st3 agent has no usable actual workspace',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        for (const subjects of [
          [],
          [{ subject: 'test.agent.0' }],
          [{ subject: 'test.agent.0', actual: { status: 'running', host: hostname() } }],
          [
            {
              subject: 'test.agent.0',
              actual: { status: 'running', workspace: 'relative/worktree', host: hostname() },
            },
          ],
        ]) {
          yield* configure({
            config: f.config,
            activeWorkspacePaths: [f.worktree],
            subjects,
          })
          const result = yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run'],
          })
          expect(generated(result.results, 'node_modules')).toMatchObject({
            outcome: 'unknown',
            reason: 'agent-liveness-unavailable',
          })
          expect(result.completedRepoCount).toBe(1)
          expect(result.discoveredWorktreeCount).toBe(1)
          expect(result.activeWorktreeCount).toBe(0)
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'keeps an artifact claimed by st3 actual.workspace even though its listing lacks workspace',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        yield* configure({
          config: f.config,
          activeWorkspacePaths: [yield* fs.realPath(f.worktree)],
        })
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(generated(result.results, 'node_modules')).toMatchObject({
          outcome: 'keep',
          reason: 'live',
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'fails closed for invalid or incomplete native st3 listings',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)

        const valid = agentListing()
        const cases = [
          { listing: { ...valid, api_version: 'unsupported' } },
          { listing: { ...valid, snapshot: { ...valid.snapshot, host_id: 'host/other-host' } } },
          { listing: agentListing({ hasMore: true }) },
          { listing: agentListing({ syncState: 'failed' }) },
          { listing: { ...valid, value: { ...valid.value, items: [{ name: 'missing-id' }] } } },
        ] as const

        for (const override of cases) {
          yield* configure({ config: f.config, ...override })
          const result = yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run'],
          })
          expect(generated(result.results, 'node_modules')).toMatchObject({
            outcome: 'unknown',
            reason: 'agent-liveness-unavailable',
          })
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'recent nested activity keeps an old artifact root',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        yield* Effect.promise(() =>
          utimes(`${artifact}/fixture.txt`, new Date(NOW - 1_000), new Date(NOW - 1_000)),
        )
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        const row = generated(result.results, 'node_modules')
        expect(row?.reason, row?.message).toBe('retention')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'unavailable st3 or PTY native source fails closed',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* oldIgnoredArtifact(f.worktree)
        for (const unavailable of [{ st3Available: false }, { ptyAvailable: false }]) {
          yield* configure({ config: f.config, ...unavailable })
          const result = yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run'],
          })
          expect(generated(result.results, 'node_modules')).toMatchObject({
            outcome: 'unknown',
            reason: 'agent-liveness-unavailable',
          })
        }
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'dirty worktree and non-ignored artifact are kept',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config })
        yield* oldIgnoredArtifact(f.worktree)
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(`${f.worktree}/README.md`, 'dirty')
        const dirty = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(generated(dirty.results, 'node_modules')?.reason).toBe('dirty-worktree')
        yield* Git.runCommand({ args: ['add', 'README.md'], cwd: f.worktree })
        yield* Git.runCommand({ args: ['commit', '-m', 'restore clean fixture'], cwd: f.worktree })
        const dist = `${f.worktree}/dist`
        yield* fs.makeDirectory(dist, { recursive: true })
        yield* Effect.promise(() =>
          utimes(dist, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)),
        )
        const nonIgnored = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        expect(generated(nonIgnored.results, 'dist')?.reason).toBe('artifact-not-ignored')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'never deletes a clean force-tracked file inside an ignored artifact',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        yield* Git.runCommand({
          args: ['add', '--force', 'node_modules/fixture.txt'],
          cwd: f.worktree,
        })
        yield* Git.runCommand({
          args: ['commit', '-m', 'track ignored generated file'],
          cwd: f.worktree,
        })
        expect(
          (yield* Git.runCommand({ args: ['status', '--porcelain'], cwd: f.worktree })).trim(),
        ).toBe('')
        // check-ignore's normal tracked-file behavior must not be the only veto.
        yield* Git.runCommand({
          args: ['check-ignore', '--no-index', '--quiet', '--', 'node_modules/fixture.txt'],
          cwd: f.worktree,
        })
        const plan = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        const candidate = generated(plan.results, 'node_modules')!
        expect(candidate).toMatchObject({ outcome: 'keep', reason: 'artifact-tracked' })
        const applied = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--expected-plan', plan.planSha256!, '--candidate-path', candidate.path],
        })
        expect(applied.exitCode).toBe(1)
        expect(yield* fs.readFileString(`${artifact}/fixture.txt`)).toBe('generated')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'reclaims idle storybook-static with its exact plan digest and candidate selector',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        const artifact = yield* oldIgnoredArtifact(f.worktree, 'storybook-static')
        const plan = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        const candidate = generated(plan.results, 'storybook-static')!
        expect(candidate).toMatchObject({ outcome: 'would-delete', reason: 'eligible' })
        const applied = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--expected-plan', plan.planSha256!, '--candidate-path', candidate.path],
        })
        expect(applied.exitCode).toBe(0)
        expect(applied.results).toEqual([
          expect.objectContaining({
            path: candidate.path,
            artifactClass: 'storybook-static',
            outcome: 'deleted',
          }),
        ])
        expect(yield* fs.exists(artifact)).toBe(false)
        expect(yield* fs.exists(`${f.worktree}/README.md`)).toBe(true)
        expect(
          (yield* Git.runCommand({ args: ['status', '--porcelain'], cwd: f.worktree })).trim(),
        ).toBe('')
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'requires a complete plan-bound candidate selector for mutation',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        expect((yield* runGc({ cwd: f.outside, storePath: f.storePath, args: [] })).exitCode).toBe(
          1,
        )
        expect(
          (yield* runGc({
            cwd: f.outside,
            storePath: f.storePath,
            args: ['--dry-run', '--expected-plan', '0'.repeat(64)],
          })).exitCode,
        ).toBe(1)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'applies exactly one generated-artifact candidate from an unchanged plan',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        yield* configure({ config: f.config })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        yield* fs.writeFileString(`${f.worktree}/.gitignore`, 'node_modules/\ndist/\n')
        yield* Git.runCommand({ args: ['add', '.gitignore'], cwd: f.worktree })
        yield* Git.runCommand({ args: ['commit', '-m', 'ignore dist'], cwd: f.worktree })
        const sibling = `${f.worktree}/dist`
        yield* fs.makeDirectory(sibling, { recursive: true })
        yield* fs.writeFileString(`${sibling}/fixture.txt`, 'generated sibling')
        yield* Effect.promise(() =>
          utimes(sibling, new Date(NOW - 2 * DAY_MS), new Date(NOW - 2 * DAY_MS)),
        )

        const plan = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        const candidate = generated(plan.results, 'node_modules')!
        const applied = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--expected-plan', plan.planSha256!, '--candidate-path', candidate.path],
        })

        expect(applied.exitCode).toBe(0)
        expect(applied.results).toHaveLength(1)
        expect(applied.results[0]).toMatchObject({ path: candidate.path, outcome: 'deleted' })
        expect(yield* fs.exists(artifact)).toBe(false)
        expect(yield* fs.exists(sibling)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refuses to delete while an activation holds the owner deletion lease',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        yield* configure({ config: f.config })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const plan = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })

        const candidatePath = generated(plan.results, 'node_modules')!.path
        // Stand in for `mr store lease -- <activation>`: hold the owner lease
        // across the whole apply attempt.
        const ownerPath = yield* canonicalizeOwnerPath(f.worktree)
        const held = yield* acquireDeletionLease({
          storeBasePath: f.storePath,
          ownerPath,
          now: NOW,
        })
        const refused = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--expected-plan', plan.planSha256!, '--candidate-path', candidatePath],
        })
        expect(refused.exitCode).toBe(1)
        expect(yield* fs.exists(artifact)).toBe(true)

        // Activation finished: the same plan applies.
        yield* releaseDeletionLease(held)
        const applied = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--expected-plan', plan.planSha256!, '--candidate-path', candidatePath],
        })
        expect(applied.exitCode).toBe(0)
        expect(yield* fs.exists(artifact)).toBe(false)
        expect(yield* fs.exists(held.leasePath)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refuses missing and newly-live generated-artifact candidates',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        yield* configure({ config: f.config })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const plan = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        const candidatePath = generated(plan.results, 'node_modules')!.path

        const missing = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--expected-plan', plan.planSha256!, '--candidate-path', `${f.outside}missing`],
        })
        expect(missing.exitCode).toBe(1)
        expect(yield* fs.exists(artifact)).toBe(true)

        yield* configure({
          config: f.config,
          activeWorkspacePaths: [f.worktree.replace(/\/+$/u, '')],
        })
        const live = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--expected-plan', plan.planSha256!, '--candidate-path', candidatePath],
        })
        expect(live.exitCode).toBe(1)
        expect(yield* fs.exists(artifact)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'refuses application when any part of the canonical plan changed',
    Effect.fnUntraced(
      function* () {
        const fs = yield* FileSystem.FileSystem
        const f = yield* fixture()
        yield* configure({ config: f.config })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const plan = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
        })
        yield* fs.writeFileString(`${artifact}/changed-after-plan.txt`, 'new evidence')

        const changed = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--expected-plan', plan.planSha256!, '--candidate-path', artifact],
        })

        expect(changed.exitCode).toBe(1)
        expect(yield* fs.exists(artifact)).toBe(true)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'nested symlink fails the bounded scan closed',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        yield* Effect.promise(() => symlink(f.outside, `${artifact}/outside`))
        const result = yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(generated(result.results, 'node_modules')).toMatchObject({
          outcome: 'unknown',
          reason: 'artifact-scan-incomplete',
        })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'legacy store gc does not include generated-artifact planning',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config })
        const artifact = yield* oldIgnoredArtifact(f.worktree)
        const result = yield* runGc({
          cwd: f.outside,
          storePath: f.storePath,
          args: ['--dry-run'],
          generatedArtifacts: false,
        })
        expect(result.planSha256).toMatch(/^[0-9a-f]{64}$/)
        expect(result.results.some((row) => row.kind === 'generated-artifact')).toBe(false)
        expect(yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(artifact)))).toBe(
          true,
        )
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'planning does not create or reconcile the shared workspace registry',
    Effect.fnUntraced(
      function* () {
        const f = yield* fixture()
        yield* configure({ config: f.config })
        yield* oldIgnoredArtifact(f.worktree)
        const registry = `${f.storePath}/.state/workspaces`
        const fs = yield* FileSystem.FileSystem
        expect(yield* fs.exists(registry)).toBe(false)
        yield* runGc({ cwd: f.outside, storePath: f.storePath, args: ['--dry-run'] })
        expect(yield* fs.exists(registry)).toBe(false)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
