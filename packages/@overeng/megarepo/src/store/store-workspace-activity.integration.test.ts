/**
 * Neutral build-output budget activity admission.
 *
 * Manifests are real files read through the real filesystem; builtin capture
 * runs a real `pty`-compatible subprocess script and scans the real `/proc`.
 * Every inadmissible manifest must collapse to `undefined` (unknown ⇒ keep),
 * and a configured manifest never falls back to builtin evidence.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { hostname } from 'node:os'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { decodeJson, encodeJson } from '../test-utils/mod.ts'
import {
  PROCESS_SNAPSHOT_PRODUCER,
  WORKSPACE_ACTIVITY_V2_SCHEMA,
  captureProcessActivityManifest,
  isWorkspaceActive,
  readBudgetWorkspaceActivity,
  readBudgetWorktreeInUse,
  writeWorkspaceActivityManifest,
  type BudgetActivityConfig,
} from './store-workspace-activity.ts'

const PRODUCER = 'acceptance-fixture'
const runsAsRoot = process.getuid?.() === 0

const manifest = ({
  workspace,
  capturedAt = Date.now() - 1_000,
  ttlMs = 60_000,
  host = hostname(),
  complete = true,
  errors = [],
  snapshotId = 'snapshot-1',
  producer = PRODUCER,
}: {
  workspace: string
  capturedAt?: number
  ttlMs?: number
  host?: string
  complete?: boolean
  errors?: ReadonlyArray<string>
  snapshotId?: string
  producer?: string
}) =>
  encodeJson({
    schemaVersion: WORKSPACE_ACTIVITY_V2_SCHEMA,
    producer: { name: producer, version: 'fixture-v1' },
    epoch: { host, snapshotId, storeIndex: 7 },
    capturedAt: new Date(capturedAt).toISOString(),
    expiresAt: new Date(capturedAt + ttlMs).toISOString(),
    complete,
    errors,
    claims: [
      {
        workspace,
        sources: ['st3-seat', 'pty'],
        agents: ['agent-1'],
        activeRuntimeIds: ['runtime-1'],
        active: true,
      },
    ],
  })

/** Temp root with a canonical workspace and a manifest path inside it. */
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const workspace = `${root}/workspace`
  yield* fs.makeDirectory(workspace)
  return { fs, root, workspace, manifestPath: `${root}/activity.json` }
})

const manifestOnly = (manifestPath: string): BudgetActivityConfig => ({
  manifestPath,
  agentLivenessProducers: [PRODUCER],
  builtin: false,
})

/** Spawn a long-lived holder in `cwd`, resolved once the OS reports it spawned. */
const spawnHolder = (cwd: string): Promise<ChildProcess> => {
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>()
  const child = spawn('sleep', ['120'], { cwd, stdio: 'ignore' })
  child.once('spawn', () => resolve(child))
  child.once('error', reject)
  return promise
}

const killHolder = (child: ChildProcess): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>()
  child.once('exit', () => resolve())
  child.kill('SIGKILL')
  return promise
}

/** Point builtin capture at a script printing a fixed `pty list --json --tags` result. */
const withFakePty = ({
  fs,
  root,
  records,
}: {
  fs: FileSystem.FileSystem
  root: string
  records: unknown
}) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const script = `${root}/fake-pty`
      yield* fs.writeFileString(`${root}/pty-list.json`, encodeJson(records))
      yield* fs.writeFileString(script, `#!/bin/sh\nexec cat '${root}/pty-list.json'\n`)
      yield* fs.chmod(script, 0o755)
      const previous = process.env['MEGAREPO_GC_PTY_BIN']
      process.env['MEGAREPO_GC_PTY_BIN'] = script
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env['MEGAREPO_GC_PTY_BIN']
        else process.env['MEGAREPO_GC_PTY_BIN'] = previous
      }),
  )

describe('readBudgetWorkspaceActivity manifest admission', () => {
  it.effect(
    'admits a fresh complete manifest from a listed producer on this host',
    Effect.fnUntraced(
      function* () {
        const { fs, workspace, manifestPath } = yield* fixture
        yield* fs.writeFileString(manifestPath, manifest({ workspace }))
        const activity = yield* readBudgetWorkspaceActivity({
          fs,
          config: manifestOnly(manifestPath),
        })
        expect(activity?.epoch).toEqual({
          host: hostname(),
          producer: PRODUCER,
          snapshotId: 'snapshot-1',
          storeIndex: 7,
        })
        expect([...(activity?.activePaths ?? [])]).toEqual([workspace])
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: workspace })).toBe(true)

        // Re-reading the same producer snapshot stays admitted.
        const again = yield* readBudgetWorkspaceActivity({
          fs,
          config: manifestOnly(manifestPath),
          admittedEpoch: activity!.epoch,
        })
        expect(again?.epoch).toEqual(activity?.epoch)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'missing manifest is unknown and never falls back to builtin evidence',
    Effect.fnUntraced(
      function* () {
        const { fs, manifestPath } = yield* fixture
        expect(
          yield* readBudgetWorkspaceActivity({ fs, config: manifestOnly(manifestPath) }),
        ).toBeUndefined()
        expect(
          yield* readBudgetWorkspaceActivity({
            fs,
            config: { manifestPath, agentLivenessProducers: [PRODUCER], builtin: true },
          }),
        ).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'rejects expired, future, over-long, foreign-host, incomplete, errored and unlisted manifests',
    Effect.fnUntraced(
      function* () {
        const { fs, workspace, manifestPath } = yield* fixture
        const now = Date.now()
        const rejected = [
          manifest({ workspace, capturedAt: now - 120_000, ttlMs: 60_000 }),
          manifest({ workspace, capturedAt: now + 60_000 }),
          manifest({ workspace, capturedAt: now - 1_000, ttlMs: 5 * 60_000 + 1 }),
          manifest({ workspace, host: `not-${hostname()}` }),
          manifest({ workspace, complete: false }),
          manifest({ workspace, errors: ['st3 agents ls failed'] }),
          manifest({ workspace, producer: 'st2' }),
          encodeJson({ schemaVersion: 'st2.workspace-activity.v1' }),
          '{ not json',
        ]
        for (const content of rejected) {
          yield* fs.writeFileString(manifestPath, content)
          expect(
            yield* readBudgetWorkspaceActivity({ fs, config: manifestOnly(manifestPath) }),
          ).toBeUndefined()
        }
        // No admitted producers admits nothing.
        yield* fs.writeFileString(manifestPath, manifest({ workspace }))
        expect(
          yield* readBudgetWorkspaceActivity({
            fs,
            config: { manifestPath, builtin: false },
          }),
        ).toBeUndefined()
        // No source at all is unknown, not idle.
        expect(yield* readBudgetWorkspaceActivity({ fs, config: { builtin: false } })).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'a changed producer snapshot after the scan is unknown',
    Effect.fnUntraced(
      function* () {
        const { fs, workspace, manifestPath } = yield* fixture
        yield* fs.writeFileString(manifestPath, manifest({ workspace }))
        const admitted = yield* readBudgetWorkspaceActivity({
          fs,
          config: manifestOnly(manifestPath),
        })
        yield* fs.writeFileString(manifestPath, manifest({ workspace, snapshotId: 'snapshot-2' }))
        expect(
          yield* readBudgetWorkspaceActivity({
            fs,
            config: manifestOnly(manifestPath),
            admittedEpoch: admitted!.epoch,
          }),
        ).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect(
    'noncanonical claims are unknown; claims for deleted workspaces protect nothing',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace, manifestPath } = yield* fixture
        yield* fs.symlink(workspace, `${root}/alias`)
        yield* fs.writeFileString(manifestPath, manifest({ workspace: `${root}/alias` }))
        expect(
          yield* readBudgetWorkspaceActivity({ fs, config: manifestOnly(manifestPath) }),
        ).toBeUndefined()

        yield* fs.writeFileString(manifestPath, manifest({ workspace: `${root}/gone` }))
        const activity = yield* readBudgetWorkspaceActivity({
          fs,
          config: manifestOnly(manifestPath),
        })
        expect(activity?.activePaths.size).toBe(0)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe.skipIf(process.platform !== 'linux')('readBudgetWorkspaceActivity builtin capture', () => {
  it.effect(
    'is unknown when another owner’s process cannot be inspected',
    Effect.fnUntraced(
      function* () {
        if (runsAsRoot === true) return
        const { fs, root } = yield* fixture
        yield* withFakePty({ fs, root, records: [] })
        // PID 1 belongs to root: its cwd/root/fds are unreadable to this user.
        expect(yield* readBudgetWorkspaceActivity({ fs, config: {} })).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect.skipIf(runsAsRoot === false)(
    'retained PTY records and live process references protect their worktrees',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace } = yield* fixture
        const ptyWorkspace = `${root}/pty-workspace`
        const idle = `${root}/idle`
        yield* fs.makeDirectory(ptyWorkspace)
        yield* fs.makeDirectory(idle)
        yield* withFakePty({
          fs,
          root,
          records: [
            { name: 'exited', status: 'exited', pid: null, cwd: ptyWorkspace },
            { name: 'vanished', status: 'vanished', pid: null, cwd: `${root}/deleted` },
          ],
        })
        const holder = yield* Effect.promise(() => spawnHolder(workspace))
        const activity = yield* readBudgetWorkspaceActivity({ fs, config: {} })
        yield* Effect.promise(() => killHolder(holder))

        expect(activity?.epoch.producer).toBe('builtin')
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: ptyWorkspace })).toBe(
          true,
        )
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: workspace })).toBe(true)
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: idle })).toBe(false)

        // A running record without a process is incomplete evidence.
        yield* withFakePty({
          fs,
          root,
          records: [{ name: 'broken', status: 'running', pid: null, cwd: ptyWorkspace }],
        })
        expect(yield* readBudgetWorkspaceActivity({ fs, config: {} })).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})

describe.skipIf(process.platform !== 'linux')('all-uid process coverage', () => {
  it.effect.skipIf(runsAsRoot === true)(
    'an all-uid manifest the owner could have written is rejected; strict probe stays unknown',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace, manifestPath } = yield* fixture
        yield* withFakePty({ fs, root, records: [] })
        const forged = yield* captureProcessActivityManifest({ fs, storeRoots: [root] })
        // Non-root cannot read every process: the snapshot reports itself incomplete.
        expect(forged.complete).toBe(false)
        // Publication refuses a directory the owner controls.
        const refused = yield* writeWorkspaceActivityManifest({
          fs,
          path: manifestPath,
          manifest: { ...forged, complete: true, errors: [] },
        }).pipe(Effect.flip)
        expect(refused._tag).toBe('ActivityUnavailable')
        expect(yield* fs.readDirectory(root)).not.toContainEqual(
          expect.stringMatching(/\.tmp$/),
        )
        // A hand-written copy is rejected by readers for the same reason.
        yield* fs.writeFileString(
          manifestPath,
          encodeJson({
            ...(decodeJson(manifest({ workspace, producer: PROCESS_SNAPSHOT_PRODUCER })) as object),
            processCoverage: 'all-uids',
            processRoots: [root],
          }),
        )
        expect(
          yield* readBudgetWorkspaceActivity({
            fs,
            config: {
              manifestPath,
              agentLivenessProducers: [PROCESS_SNAPSHOT_PRODUCER],
              builtin: false,
            },
          }),
        ).toBeUndefined()
        expect(
          yield* readBudgetWorktreeInUse({ worktreePath: workspace, activity: undefined }),
        ).toEqual({ _tag: 'unknown', reason: 'inaccessible-process' })
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )

  it.effect.skipIf(runsAsRoot === false)(
    'a root snapshot covers processes; the owner still adds fresh PTY records',
    Effect.fnUntraced(
      function* () {
        const { fs, root, workspace, manifestPath } = yield* fixture
        const ptyWorkspace = `${root}/pty-workspace`
        const idle = `${root}/idle`
        yield* fs.makeDirectory(ptyWorkspace)
        yield* fs.makeDirectory(idle)
        const holder = yield* Effect.promise(() => spawnHolder(workspace))
        const snapshot = yield* captureProcessActivityManifest({ fs, storeRoots: [root] })
        yield* Effect.promise(() => killHolder(holder))

        expect(snapshot).toMatchObject({
          producer: { name: PROCESS_SNAPSHOT_PRODUCER },
          complete: true,
          errors: [],
          processCoverage: 'all-uids',
          processRoots: [root],
        })
        expect(snapshot.claims).toContainEqual({
          workspace,
          sources: ['process'],
          agents: [],
          activeRuntimeIds: [],
          active: true,
        })
        yield* writeWorkspaceActivityManifest({ fs, path: manifestPath, manifest: snapshot })

        yield* withFakePty({
          fs,
          root,
          records: [{ name: 'retained', status: 'exited', pid: null, cwd: ptyWorkspace }],
        })
        const config = {
          manifestPath,
          agentLivenessProducers: [PROCESS_SNAPSHOT_PRODUCER],
          builtin: false,
        }
        const activity = yield* readBudgetWorkspaceActivity({ fs, config })
        expect(activity?.processCoverage).toEqual({ roots: [root] })
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: workspace })).toBe(true)
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: ptyWorkspace })).toBe(
          true,
        )
        expect(isWorkspaceActive({ activity: activity!, canonicalWorktree: idle })).toBe(false)
        expect(yield* readBudgetWorktreeInUse({ worktreePath: idle, activity })).toEqual({
          _tag: 'free',
        })

        // A fresh root-controlled snapshot from a previous boot cannot waive
        // foreign-process inspection, nor can a nonzero native store index.
        for (const epoch of [
          { ...snapshot.epoch, snapshotId: 'previous-boot' },
          { ...snapshot.epoch, storeIndex: 1 },
        ]) {
          yield* writeWorkspaceActivityManifest({
            fs,
            path: manifestPath,
            manifest: { ...snapshot, epoch },
          })
          expect(yield* readBudgetWorkspaceActivity({ fs, config })).toBeUndefined()
        }
        yield* writeWorkspaceActivityManifest({ fs, path: manifestPath, manifest: snapshot })

        // The PTY supplement is mandatory: its failure makes the manifest unusable.
        yield* withFakePty({ fs, root, records: { not: 'a list' } })
        expect(yield* readBudgetWorkspaceActivity({ fs, config })).toBeUndefined()
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
