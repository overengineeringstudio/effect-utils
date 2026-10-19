import { execFileSync, spawn } from 'node:child_process'
import { utimes } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { encodeJson } from '../test-utils/mod.ts'
import {
  BuckDaemonStatus,
  findWorktreeBuckDaemons,
  runBuck2,
  stopWorktreeBuckDaemons,
} from './store-buck-daemons.ts'
import { discoverBuckMaintainWorktrees } from './store-buck-maintain-evidence.ts'
import { runBuckMaintain } from './store-buck-maintain.ts'
import {
  acquireDeletionLease,
  deletionLeasePath,
  releaseDeletionLease,
} from './store-deletion-lease.ts'
import { WORKSPACE_ACTIVITY_V2_SCHEMA } from './store-workspace-activity.ts'

it.live('discovers nested slash refs without descending into worktrees or archives', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
    for (const directory of [
      'refs/heads/owner/branch/.git',
      'refs/heads/owner/branch/nested/.git',
      '.archive/old/.git',
      'refs/heads/other/.git',
    ]) {
      yield* fs.makeDirectory(join(root, directory), { recursive: true })
    }
    expect(yield* discoverBuckMaintainWorktrees([root])).toEqual([
      join(root, 'refs/heads/other'),
      join(root, 'refs/heads/owner/branch'),
    ])
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live(
  'refuses action without a seat or configured owner scope and writes no lease in report-only mode',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const store = yield* fs.makeTempDirectoryScoped()
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const saved = { store: process.env['MEGAREPO_STORE'], seat: process.env['ST_AGENT'] }
          process.env['MEGAREPO_STORE'] = store
          delete process.env['ST_AGENT']
          return saved
        }),
        (saved) =>
          Effect.sync(() => {
            if (saved.store === undefined) delete process.env['MEGAREPO_STORE']
            else process.env['MEGAREPO_STORE'] = saved.store
            if (saved.seat === undefined) delete process.env['ST_AGENT']
            else process.env['ST_AGENT'] = saved.seat
          }),
      )
      const receipt = yield* runBuckMaintain({ configPath: undefined, dryRun: false })
      expect(receipt).toEqual({
        version: 1,
        dryRun: true,
        entries: [],
        summary: { worktrees: 0, actions: 0, skipped: 0 },
      })
      expect(yield* fs.exists(join(store, '.state', 'deletion-leases'))).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live(
  'native idle-stop kills a real daemon while an active LSP command blocks shutdown',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      if (process.platform !== 'linux') {
        // Exercise maintenance without entering Linux-only daemon census/lifecycle setup.
        yield* fs.makeDirectory(join(root, '.git'))
        yield* fs.makeDirectory(join(root, 'buck-out', 'maintain-integration', 'daemon'), {
          recursive: true,
        })
        const daemonState = join(root, 'buck-out', 'maintain-integration', 'daemon', 'state')
        yield* fs.writeFileString(daemonState, 'unsupported-platform daemon fixture')
        const configPath = join(root, 'maintain.json')
        yield* fs.writeFileString(
          configPath,
          encodeJson({
            version: 1,
            worktreeRoots: [root],
            maintainOwners: ['seat/a'],
            buckOut: { budgetBytes: 0, keepSince: '0s' },
          }),
        )
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const saved = { store: process.env['MEGAREPO_STORE'], seat: process.env['ST_AGENT'] }
            process.env['MEGAREPO_STORE'] = root
            process.env['ST_AGENT'] = 'seat/a'
            return saved
          }),
          (saved) =>
            Effect.sync(() => {
              if (saved.store === undefined) delete process.env['MEGAREPO_STORE']
              else process.env['MEGAREPO_STORE'] = saved.store
              if (saved.seat === undefined) delete process.env['ST_AGENT']
              else process.env['ST_AGENT'] = saved.seat
            }),
        )
        expect(yield* runBuckMaintain({ configPath, dryRun: false })).toEqual({
          version: 1,
          dryRun: false,
          entries: [
            {
              worktree: root,
              action: 'none',
              reason: 'census-unsupported-platform',
              bytesBefore: null,
              bytesAfter: null,
              daemon: [],
              ownerEvidence: [],
            },
          ],
          summary: { worktrees: 1, actions: 0, skipped: 1 },
        })
        expect(yield* fs.readFileString(daemonState)).toBe('unsupported-platform daemon fixture')
        expect(yield* fs.exists(join(root, '.state', 'deletion-leases'))).toBe(false)
        return
      }
      const configured = process.env['BUCK2_BIN']
      if (configured === undefined)
        return yield* Effect.die(
          'BUCK2_BIN must name the pinned Buck2 for the real-daemon integration test',
        )
      const real = yield* fs.realPath(configured)
      const sibling = join(dirname(dirname(real)), 'libexec', 'buck2')
      const binary = (yield* fs.exists(sibling)) === true ? sibling : real
      yield* fs.writeFileString(join(root, '.buckroot'), '')
      yield* fs.writeFileString(
        join(root, '.buckconfig'),
        '[cells]\n  root = .\n[buck2]\n  file_watcher = fs_hash_crawler\n',
      )
      const isolation = 'maintain-integration'
      const initial = { pid: 0, daemonId: '', isolation, root, path: root }
      yield* Effect.addFinalizer(() =>
        runBuck2({ binary, daemon: initial, subcommand: 'kill' }).pipe(Effect.asVoid),
      )
      // A long-lived streaming command exposes real attached-client state in status.
      const client = yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn(binary, ['--isolation-dir', isolation, 'lsp'], {
            cwd: root,
            stdio: ['pipe', 'ignore', 'ignore'],
          }),
        ),
        (child) =>
          Effect.sync(() => {
            child.stdin.end()
            child.kill()
          }),
      )
      const deadline = Date.now() + 60_000
      let attached = false
      while (attached === false && Date.now() < deadline) {
        const daemons = yield* findWorktreeBuckDaemons({ worktreePath: root })
        if (daemons[0] !== undefined) {
          const result = yield* runBuck2({
            binary,
            daemon: daemons[0].daemon,
            subcommand: 'status',
          })
          const status =
            Option.isSome(result) === true && result.value.exitCode === 0
              ? yield* Schema.decodeEffect(Schema.fromJsonString(BuckDaemonStatus))(
                  result.value.stdout,
                ).pipe(Effect.option)
              : Option.none()
          attached = Option.isSome(status) === true && status.value.active_commands.length > 0
        }
        if (attached === false) yield* Effect.yieldNow
      }
      expect(attached).toBe(true)
      const active = yield* stopWorktreeBuckDaemons({
        worktreePath: root,
        binary,
        idleSinceMs: Date.now() + 60_000,
      })
      expect(active).toHaveLength(1)
      expect(active[0]?._tag).toBe('kept-active')
      client.stdin.end()
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (client.exitCode !== null) resolve()
            else client.once('exit', () => resolve())
          }),
      )
      let idle = false
      while (idle === false && Date.now() < deadline) {
        const daemons = yield* findWorktreeBuckDaemons({ worktreePath: root })
        if (daemons[0] === undefined)
          return yield* Effect.die('expected fixture daemon to remain after LSP exits')
        const result = yield* runBuck2({ binary, daemon: daemons[0].daemon, subcommand: 'status' })
        const status =
          Option.isSome(result) === true && result.value.exitCode === 0
            ? yield* Schema.decodeEffect(Schema.fromJsonString(BuckDaemonStatus))(
                result.value.stdout,
              ).pipe(Effect.option)
            : Option.none()
        idle = Option.isSome(status) === true && status.value.active_commands.length === 0
        if (idle === false) yield* Effect.yieldNow
      }
      expect(idle).toBe(true)
      const lateLog = join(root, 'buck-out', isolation, 'log', 'late-command.fixture')
      const arrivedDuringRecheck = yield* stopWorktreeBuckDaemons({
        worktreePath: root,
        binary,
        idleSinceMs: Date.now() + 60_000,
        beforeKill: () =>
          fs.writeFileString(lateLog, 'command activity during final recheck').pipe(
            Effect.andThen(
              Effect.tryPromise(() => {
                const touched = new Date(Date.now() + 1000)
                return utimes(lateLog, touched, touched)
              }),
            ),
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          ),
      })
      expect(arrivedDuringRecheck[0]?._tag).toBe('kept-active')
      const stopped = yield* stopWorktreeBuckDaemons({
        worktreePath: root,
        binary,
        idleSinceMs: Date.now() + 60_000,
      })
      expect(stopped).toHaveLength(1)
      expect(stopped[0]?._tag).toBe('stopped')
      expect(yield* findWorktreeBuckDaemons({ worktreePath: root })).toHaveLength(0)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  180_000,
)

it.live(
  'maintains real worktrees through ownership, locks, native cleanup and final lease gates',
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const store = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      const binary = yield* Effect.gen(function* () {
        if (process.platform !== 'linux') return undefined
        const configured = process.env['BUCK2_BIN']
        if (configured === undefined) return yield* Effect.die('BUCK2_BIN is required')
        const real = yield* fs.realPath(configured)
        const sibling = join(dirname(dirname(real)), 'libexec', 'buck2')
        return (yield* fs.exists(sibling)) === true ? sibling : real
      })
      const st3 = join(store, 'st3')
      const pty = join(store, 'pty')
      const page = encodeJson({
        api_version: 'st3.client.v0',
        snapshot: {
          id: 'fixture',
          host_id: `host/${hostname()}`,
          created_at: new Date().toISOString(),
          store_index: 0,
        },
        value: {
          kind: 'page',
          collection: 'agents',
          items: [],
          page: { has_more: false, next_cursor: null },
        },
      })
      yield* fs.writeFileString(st3, `#!/bin/sh\nprintf '%s\\n' '${page}'\n`)
      yield* fs.writeFileString(pty, "#!/bin/sh\nprintf '[]\\n'\n")
      yield* fs.chmod(st3, 0o755)
      yield* fs.chmod(pty, 0o755)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const saved = {
            store: process.env['MEGAREPO_STORE'],
            seat: process.env['ST_AGENT'],
            path: process.env['PATH'],
            st3: process.env['MEGAREPO_GC_ST3_BIN'],
            pty: process.env['MEGAREPO_GC_PTY_BIN'],
          }
          process.env['MEGAREPO_STORE'] = store
          process.env['ST_AGENT'] = 'seat/a'
          if (binary !== undefined) process.env['PATH'] = `${dirname(binary)}:${saved.path ?? ''}`
          process.env['MEGAREPO_GC_ST3_BIN'] = st3
          process.env['MEGAREPO_GC_PTY_BIN'] = pty
          return saved
        }),
        (saved) =>
          Effect.sync(() => {
            for (const [key, value] of [
              ['MEGAREPO_STORE', saved.store],
              ['ST_AGENT', saved.seat],
              ['PATH', saved.path],
              ['MEGAREPO_GC_ST3_BIN', saved.st3],
              ['MEGAREPO_GC_PTY_BIN', saved.pty],
            ]) {
              if (key === undefined) continue
              if (value === undefined) delete process.env[key]
              else process.env[key] = value
            }
          }),
      )
      const source = join(store, 'source')
      yield* fs.makeDirectory(source)
      yield* Effect.sync(() => {
        execFileSync('git', ['init', source])
        execFileSync('git', [
          '-C',
          source,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--allow-empty',
          '-m',
          'fixture',
        ])
      })
      const roots = join(store, 'refs', 'heads')
      const paths = Object.fromEntries(
        ['foreign', 'unowned', 'locked', 'budget', 'leased'].map((name) => [
          name,
          join(roots, name),
        ]),
      )
      for (const worktree of Object.values(paths)) {
        yield* Effect.sync(() =>
          execFileSync('git', ['-C', source, 'worktree', 'add', '--detach', worktree, 'HEAD']),
        )
        yield* fs.writeFileString(join(worktree, '.buckroot'), '')
        yield* fs.writeFileString(
          join(worktree, '.buckconfig'),
          '[cells]\n  root = .\n[buck2]\n  file_watcher = fs_hash_crawler\n',
        )
        yield* fs.makeDirectory(join(worktree, 'buck-out', 'v2'), { recursive: true })
        yield* fs.writeFileString(
          join(worktree, 'buck-out', 'v2', 'fixture-bytes'),
          'x'.repeat(8192),
        )
        if (binary !== undefined) {
          yield* Effect.addFinalizer(() =>
            runBuck2({
              binary,
              daemon: { pid: 0, daemonId: '', isolation: 'v2', root: worktree, path: worktree },
              subcommand: 'kill',
            }).pipe(Effect.asVoid),
          )
        }
      }
      const foreign = paths['foreign']!
      const unowned = paths['unowned']!
      const locked = paths['locked']!
      const budget = paths['budget']!
      const leased = paths['leased']!
      yield* Effect.sync(() => execFileSync('git', ['-C', source, 'worktree', 'lock', locked]))
      const manifestPath = join(store, 'activity.json')
      yield* fs.writeFileString(
        manifestPath,
        encodeJson({
          schemaVersion: WORKSPACE_ACTIVITY_V2_SCHEMA,
          producer: { name: 'maintenance-fixture', version: '1' },
          epoch: { host: hostname(), snapshotId: 'fixture', storeIndex: 0 },
          capturedAt: new Date(Date.now() - 1000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          complete: true,
          errors: [],
          claims: [
            [foreign, 'seat/foreign'],
            [budget, 'seat/a'],
            [leased, 'seat/a'],
          ].map(([workspace, owner]) => ({
            workspace,
            sources: ['st3-seat'],
            agents: [owner],
            activeRuntimeIds: [],
            active: false,
          })),
        }),
      )
      yield* fs.makeDirectory(join(store, '.state'), { recursive: true })
      yield* fs.writeFileString(
        join(store, '.state', 'gc-config.json'),
        encodeJson({
          generatedArtifacts: {
            manifestPath,
            agentLivenessProducers: ['maintenance-fixture'],
            builtin: false,
          },
        }),
      )
      const configPath = join(store, 'maintain.json')
      const config = {
        version: 1,
        worktreeRoots: [roots],
        buckOut: { budgetBytes: 0, keepSince: '0s' },
        maintainOwners: ['seat/a'],
      }
      const storeBasePath = EffectPath.unsafe.absoluteDir(`${store}/`)
      const held = yield* acquireDeletionLease({
        storeBasePath,
        ownerPath: leased,
        now: Date.now(),
      })
      yield* Effect.addFinalizer(() => releaseDeletionLease(held))
      const budgetLease = deletionLeasePath({ storeBasePath, ownerPath: budget })
      const leaseAtCensus: boolean[] = []
      // Model a fully readable, idle process table, not the host's unrelated protected PIDs.
      // Git, worktrees, manifests, leases, du, and native Buck commands remain real.
      const idleFs: FileSystem.FileSystem = {
        ...fs,
        readDirectory: (path, options) =>
          path === '/proc'
            ? fs.exists(budgetLease).pipe(
                Effect.map((heldNow) => {
                  leaseAtCensus.push(heldNow)
                  return []
                }),
              )
            : fs.readDirectory(path, options),
      }
      const unsupportedReceipt = {
        version: 1,
        dryRun: false,
        entries: Object.values(paths)
          .toSorted()
          .map((worktree) => ({
            worktree,
            action: 'none',
            reason: 'census-unsupported-platform',
            bytesBefore: null,
            bytesAfter: null,
            daemon: [],
            ownerEvidence: [],
          })),
        summary: { worktrees: 5, actions: 0, skipped: 5 },
      }
      yield* fs.writeFileString(configPath, encodeJson({ ...config, maintainUnowned: false }))
      const first = yield* runBuckMaintain({ configPath, dryRun: false }).pipe(
        Effect.provideService(FileSystem.FileSystem, idleFs),
      )
      if (process.platform === 'linux') {
        const firstByPath = new Map(first.entries.map((entry) => [entry.worktree, entry]))
        expect(first.entries).toHaveLength(5)
        expect(firstByPath.get(foreign)?.reason).toBe('foreign-owner')
        expect(firstByPath.get(unowned)?.reason).toBe('unknown-owner')
        expect(firstByPath.get(locked)?.reason).toBe('git-locked')
        expect(firstByPath.get(leased)?.reason).toBe('lease-held')
        expect(firstByPath.get(budget)?.action).toBe('clean-stale')
        expect(firstByPath.get(budget)?.reason).toBe('completed')
        expect(firstByPath.get(budget)?.bytesBefore).toBeGreaterThan(0)
        expect(firstByPath.get(budget)?.bytesAfter).toEqual(expect.any(Number))
        expect(leaseAtCensus).toContain(true)
      } else {
        expect(first).toEqual(unsupportedReceipt)
        expect(leaseAtCensus).toEqual([])
        for (const worktree of Object.values(paths)) {
          expect(yield* fs.readFileString(join(worktree, 'buck-out', 'v2', 'fixture-bytes'))).toBe(
            'x'.repeat(8192),
          )
        }
      }
      expect(yield* fs.exists(budgetLease)).toBe(false)
      expect(yield* fs.exists(held.leasePath)).toBe(true)
      yield* fs.writeFileString(configPath, encodeJson({ ...config, maintainUnowned: true }))
      const second = yield* runBuckMaintain({ configPath, dryRun: false }).pipe(
        Effect.provideService(FileSystem.FileSystem, idleFs),
      )
      if (process.platform === 'linux') {
        expect(second.entries.find((entry) => entry.worktree === unowned)?.action).toBe(
          'clean-stale',
        )
        expect(second.entries.find((entry) => entry.worktree === foreign)?.reason).toBe(
          'foreign-owner',
        )
        expect(second.entries.find((entry) => entry.worktree === leased)?.reason).toBe('lease-held')
      } else {
        expect(second).toEqual(unsupportedReceipt)
        expect(leaseAtCensus).toEqual([])
        for (const worktree of Object.values(paths)) {
          expect(yield* fs.readFileString(join(worktree, 'buck-out', 'v2', 'fixture-bytes'))).toBe(
            'x'.repeat(8192),
          )
        }
        expect(yield* fs.exists(budgetLease)).toBe(false)
      }
      expect(yield* fs.exists(held.leasePath)).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  180_000,
)
