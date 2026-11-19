import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { encodeJson } from '../test-utils/mod.ts'
import { withExclusiveDirectoryLock } from './git-writer-lock.ts'
import { canonicalBuckMaintainRoot } from './store-buck-maintain-config.ts'
import { discoverBuckMaintainWorktrees } from './store-buck-maintain-evidence.ts'
import {
  BuckMaintainProgressError,
  canonicalBuckMaintainJson,
  type BuckMaintainProgressManifest,
} from './store-buck-maintain-progress-schema.ts'
import {
  buckMaintainProgressReceipt,
  openBuckMaintainProgress,
  selectBuckMaintainProgressRoots,
} from './store-buck-maintain-progress-store.ts'
import { runBuckMaintain } from './store-buck-maintain.ts'

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const scope = join(directory, 'worktrees')
  const progress = join(directory, 'progress')
  yield* fs.makeDirectory(progress, { mode: 0o700 })
  for (const name of ['a', 'b'])
    yield* fs.makeDirectory(join(scope, name, '.git'), { recursive: true })
  const inventory = yield* discoverBuckMaintainWorktrees([scope])
  const configPath = join(directory, 'policy.json')
  yield* fs.writeFileString(configPath, encodeJson({ version: 1, worktreeRoots: [scope] }))
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const previous = process.env['MEGAREPO_STORE']
      process.env['MEGAREPO_STORE'] = directory
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        if (previous === undefined) delete process.env['MEGAREPO_STORE']
        else process.env['MEGAREPO_STORE'] = previous
      }),
  )
  // These are storage bindings, NOT runtime attestation or positive holder evidence.
  const expected: Omit<BuckMaintainProgressManifest, 'createdAt'> = {
    version: 1,
    dryRun: true,
    inventory,
    runtime: {
      executable: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-fixture/bin/mr',
      executableSha256: 'a'.repeat(64),
      entrypoint: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-fixture/bin/mr',
      entrypointSha256: 'a'.repeat(64),
      platform: process.platform,
      arch: process.arch,
    },
    configuration: canonicalBuckMaintainJson({ worktreeRoots: [scope] }),
  }
  const open = (currentInventory: readonly string[] = inventory) =>
    openBuckMaintainProgress({
      directory: progress,
      expected: { ...expected, inventory: currentInventory },
    })
  const shard = () =>
    withExclusiveDirectoryLock(progress)(
      Effect.gen(function* () {
        const session = yield* open(yield* discoverBuckMaintainWorktrees([scope]))
        const native = yield* runBuckMaintain({
          configPath,
          dryRun: true,
          progress: {
            selectWorktrees: () => selectBuckMaintainProgressRoots(session, undefined),
            onEntry: session.append,
          },
        })
        return {
          native,
          historical: buckMaintainProgressReceipt(session, native.summary.worktrees),
        }
      }),
    )
  return { fs, directory, scope, progress, configPath, inventory, open, shard }
})

const unexpectedCapture = () =>
  Effect.fail(new BuckMaintainProgressError({ message: 'Unexpected native capture' }))

it.live('refuses acting progress before policy access or either hook', () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped()
    const error = yield* runBuckMaintain({
      configPath: join(directory, 'missing-policy.json'),
      dryRun: false,
      progress: { selectWorktrees: unexpectedCapture, onEntry: unexpectedCapture },
    }).pipe(Effect.flip)
    expect(error).toMatchObject({
      _tag: 'BuckMaintainProgressError',
      message: expect.stringContaining('dry-run'),
    })
    expect(yield* fs.readDirectory(directory)).toEqual([])
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('refuses duplicate, noncanonical and out-of-policy selections before capture', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    for (const selected of [
      [f.inventory[0]!, f.inventory[0]!],
      [`${f.scope}/child/../a`],
      [f.directory],
    ]) {
      const error = yield* runBuckMaintain({
        configPath: f.configPath,
        dryRun: true,
        progress: { selectWorktrees: () => Effect.succeed(selected), onEntry: unexpectedCapture },
      }).pipe(Effect.flip)
      expect(error).toMatchObject({
        _tag: 'BuckMaintainProgressError',
        message: 'Progress selection contains a duplicate or out-of-policy root',
      })
    }
    expect(yield* f.fs.readDirectory(f.progress)).toEqual([])
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live(
  'durably resumes one missing root per shard and discloses new roots outside frozen coverage',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      yield* withExclusiveDirectoryLock(f.progress)(f.open())
      yield* f.fs.remove(f.scope, { recursive: true })
      expect(yield* canonicalBuckMaintainRoot(f.fs, f.scope)).toBe(f.scope)
      const first = yield* f.shard()
      expect(first.native.entries).toMatchObject([
        { worktree: f.inventory[0], action: 'none', reason: 'worktree-unavailable' },
      ])
      expect(first.historical.progress).toMatchObject({
        completed: 1,
        remaining: 1,
        processedThisRun: 1,
        complete: false,
        authorizesApply: false,
      })
      const newcomer = join(f.scope, 'c')
      yield* f.fs.makeDirectory(join(newcomer, '.git'), { recursive: true })
      const second = yield* f.shard()
      expect(second.native.entries).toMatchObject([
        { worktree: f.inventory[1], action: 'none', reason: 'worktree-unavailable' },
      ])
      expect(second.historical.entries.map((entry) => entry.worktree)).toEqual(f.inventory)
      expect(second.historical.progress).toMatchObject({
        completed: 2,
        remaining: 0,
        processedThisRun: 1,
        complete: true,
        newlyDiscovered: [newcomer],
        authorizesApply: false,
      })
      expect(
        second.historical.entries.every(
          (entry) =>
            entry.action === 'none' && entry.bytesBefore === null && entry.bytesAfter === null,
        ),
      ).toBe(true)
      const reopened = yield* f.shard()
      expect(reopened.native.entries).toEqual([])
      expect(reopened.historical.progress).toMatchObject({
        completed: 2,
        processedThisRun: 0,
        complete: true,
        newlyDiscovered: [newcomer],
        authorizesApply: false,
      })
      expect(reopened.historical.progress.captures).toEqual(second.historical.progress.captures)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('records an unknown decision when a selected root is replaced by a real symlink', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const outside = join(f.directory, 'outside')
    yield* f.fs.makeDirectory(outside)
    yield* f.fs.writeFileString(join(outside, 'sentinel'), 'preserve outside')
    yield* withExclusiveDirectoryLock(f.progress)(
      Effect.gen(function* () {
        const session = yield* f.open()
        const selected = f.inventory[0]!
        const receipt = yield* runBuckMaintain({
          configPath: f.configPath,
          dryRun: true,
          progress: {
            selectWorktrees: () =>
              Effect.gen(function* () {
                yield* f.fs.rename(selected, `${selected}-moved`)
                yield* f.fs.symlink(outside, selected)
                return yield* selectBuckMaintainProgressRoots(session, 1)
              }).pipe(
                Effect.mapError(
                  (cause) => new BuckMaintainProgressError({ message: String(cause) }),
                ),
              ),
            onEntry: session.append,
          },
        })
        expect(receipt.entries).toMatchObject([
          {
            worktree: selected,
            action: 'none',
            reason: 'worktree-identity-changed',
            bytesBefore: null,
            bytesAfter: null,
          },
        ])
        expect(session.records.get(0)?.entry).toEqual(receipt.entries[0])
        expect(yield* f.fs.readFileString(join(outside, 'sentinel'))).toBe('preserve outside')
      }),
    )
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
