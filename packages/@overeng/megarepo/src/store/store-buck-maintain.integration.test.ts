import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import {
  BuckDaemonStatus,
  findWorktreeBuckDaemons,
  runBuck2,
  stopWorktreeBuckDaemons,
} from './store-buck-daemons.ts'
import { discoverBuckMaintainWorktrees, runBuckMaintain } from './store-buck-maintain.ts'

it.live('discovers nested slash refs without descending into worktrees or archives', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped()
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
      const configured = process.env['BUCK2_BIN']
      if (configured === undefined)
        return yield* Effect.die(
          'BUCK2_BIN must name the pinned Buck2 for the real-daemon integration test',
        )
      const real = yield* fs.realPath(configured)
      const sibling = join(dirname(dirname(real)), 'libexec', 'buck2')
      const binary = (yield* fs.exists(sibling)) === true ? sibling : real
      const root = yield* fs.makeTempDirectoryScoped()
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
