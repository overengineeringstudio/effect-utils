import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { withExclusiveDirectoryLock } from './git-writer-lock.ts'
import {
  buckMaintainProgressReceipt,
  canonicalBuckMaintainJson,
  openBuckMaintainProgress,
  selectBuckMaintainProgressRoots,
  type BuckMaintainProgressManifest,
} from './store-buck-maintain-progress-store.ts'
import type { BuckMaintainEntry } from './store-buck-maintain.ts'

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
  const inventory = [join(directory, 'a'), join(directory, 'b'), join(directory, 'c')]
  for (const root of inventory) yield* fs.makeDirectory(root)
  const progress = join(directory, 'progress')
  yield* fs.makeDirectory(progress)
  // Storage fixtures are deliberately not runtime attestation. The production wrapper
  // reads and hashes the actual immutable packaged entrypoint and executable itself.
  const expected: Omit<BuckMaintainProgressManifest, 'createdAt'> = {
    version: 1,
    dryRun: true,
    runtime: {
      entrypoint: '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-fixture/mr.js',
      entrypointSha256: 'a'.repeat(64),
      executable: '/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-runtime/bin/bun',
      executableSha256: 'b'.repeat(64),
      platform: process.platform,
      arch: process.arch,
    },
    configuration: canonicalBuckMaintainJson({ budgetBytes: 0, maintainUnowned: false }),
    inventory,
  }
  const entry = (worktree: string): BuckMaintainEntry => ({
    worktree, action: 'none', reason: 'within-budget', bytesBefore: 12, bytesAfter: 12,
    daemon: [], ownerEvidence: [],
  })
  const capture = () => ({ startedAt: Date.now(), completedAt: Date.now(), elapsedMs: 0 })
  const open = (identity = expected) => openBuckMaintainProgress({ directory: progress, expected: identity })
  return { fs, directory: progress, expected, inventory, entry, capture, open }
})

it.live('persists each completed root across interruption, resumes unfinished roots, and aggregates exact coverage', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* f.open()
    expect(yield* selectBuckMaintainProgressRoots(first, undefined)).toEqual([f.inventory[0]])
    yield* first.append(f.entry(f.inventory[0]!), f.capture())
    // Simulate a process disappearing during the next decision/publication. No
    // complete entry exists for b, so it must remain eligible after reopening.
    yield* f.fs.writeFileString(join(f.directory, '.pending-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), '{')
    const second = yield* f.open()
    expect(yield* selectBuckMaintainProgressRoots(second, 1)).toEqual([f.inventory[1]])
    const partial = buckMaintainProgressReceipt(second, 0)
    expect(partial.progress).toMatchObject({ complete: false, total: 3, completed: 1, remaining: 2, authorizesApply: false })
    expect(partial.entries).toEqual([f.entry(f.inventory[0]!)])
    expect(partial.progress.captures[0]?.capture).toEqual(first.records.get(0)?.capture)
    for (const root of yield* selectBuckMaintainProgressRoots(second, 2)) yield* second.append(f.entry(root), f.capture())
    const complete = yield* f.open()
    expect(yield* selectBuckMaintainProgressRoots(complete, 10)).toEqual([])
    const receipt = buckMaintainProgressReceipt(complete, 2)
    expect(receipt.entries.map((entry) => entry.worktree)).toEqual(f.inventory)
    expect(receipt.summary).toEqual({ worktrees: 3, actions: 0, skipped: 3 })
    expect(receipt.progress).toMatchObject({
      complete: true, total: 3, completed: 3, remaining: 0,
      evidence: 'historical-per-root-not-atomic-census', authorizesApply: false,
    })
    expect(new Set(receipt.progress.captures.map((record) => record.index)).size).toBe(3)
    expect((yield* complete.append(f.entry(f.inventory[0]!), f.capture()).pipe(Effect.result))._tag).toBe('Failure')
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('rejects changed source, runtime, or normalized policy without rewriting progress', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const session = yield* f.open()
    yield* session.append(f.entry(f.inventory[0]!), f.capture())
    const before = yield* f.fs.readFileString(join(f.directory, 'manifest.json'))
    for (const expected of [
      { ...f.expected, runtime: { ...f.expected.runtime, entrypointSha256: 'c'.repeat(64) } },
      { ...f.expected, runtime: { ...f.expected.runtime, executableSha256: 'c'.repeat(64) } },
      { ...f.expected, configuration: '{"budgetBytes":1}' },
    ]) expect((yield* f.open(expected).pipe(Effect.result))._tag).toBe('Failure')
    expect(yield* f.fs.readFileString(join(f.directory, 'manifest.json'))).toBe(before)
    expect((yield* f.open()).records.size).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('preserves the declared historical scope when worktrees appear or disappear between shards', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const first = yield* f.open()
    yield* first.append(f.entry(f.inventory[0]!), f.capture())
    const manifest = yield* f.fs.readFileString(join(f.directory, 'manifest.json'))
    const added = `${f.inventory[2]!}-new`
    yield* f.fs.makeDirectory(added)
    yield* f.fs.remove(f.inventory[1]!)
    const resumed = yield* f.open({
      ...f.expected,
      inventory: [f.inventory[0]!, f.inventory[2]!, added].sort(),
    })
    expect(resumed.manifest.inventory).toEqual(f.inventory)
    expect(yield* selectBuckMaintainProgressRoots(resumed, 2)).toEqual(f.inventory.slice(1))
    const receipt = buckMaintainProgressReceipt(resumed, 0)
    expect(receipt.progress).toMatchObject({
      scope: 'initial-frozen-inventory',
      authorizesApply: false,
      total: 3,
      completed: 1,
      remaining: 2,
      newlyDiscovered: [added],
    })
    expect(receipt.entries).toEqual([f.entry(f.inventory[0]!)])
    expect(yield* f.fs.readFileString(join(f.directory, 'manifest.json'))).toBe(manifest)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('rejects unknown, malformed, or missing manifests and malformed complete records rather than resetting', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.fs.writeFileString(join(f.directory, 'unrecognized.json'), '{}')
    expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
    yield* f.fs.remove(join(f.directory, 'unrecognized.json'))
    for (const content of [
      '{',
      '{"version":2}',
      canonicalBuckMaintainJson({ ...f.expected, createdAt: Date.now(), unexpected: true }),
      canonicalBuckMaintainJson({ ...f.expected, inventory: [...f.inventory].reverse(), createdAt: Date.now() }),
    ]) {
      yield* f.fs.writeFileString(join(f.directory, 'manifest.json'), content)
      expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
      expect(yield* f.fs.readFileString(join(f.directory, 'manifest.json'))).toBe(content)
    }
    yield* f.fs.remove(join(f.directory, 'manifest.json'))
    const session = yield* f.open()
    yield* session.append(f.entry(f.inventory[0]!), f.capture())
    yield* f.fs.writeFileString(join(f.directory, 'entry-0.json'), '{')
    expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
    yield* f.fs.remove(join(f.directory, 'manifest.json'))
    expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('rejects duplicate, renamed, foreign-manifest, out-of-range, and acting observations', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const session = yield* f.open()
    expect((yield* session.append(f.entry(join(f.directory, 'foreign')), f.capture()).pipe(Effect.result))._tag).toBe('Failure')
    expect((yield* session.append({ ...f.entry(f.inventory[0]!), bytesAfter: 0 }, f.capture()).pipe(Effect.result))._tag).toBe('Failure')
    expect((yield* session.append({ ...f.entry(f.inventory[0]!), daemon: [{ pid: 123, isolation: 'fixture', outcome: 'stopped' }] }, f.capture()).pipe(Effect.result))._tag).toBe('Failure')
    expect((yield* session.append(f.entry(f.inventory[0]!), { startedAt: 2, completedAt: 1, elapsedMs: 0 }).pipe(Effect.result))._tag).toBe('Failure')
    yield* session.append(f.entry(f.inventory[0]!), f.capture())
    const record = session.records.get(0)!
    for (const damaged of [
      { ...record, index: 99 },
      { ...record, manifestSha256: 'c'.repeat(64) },
      { ...record, entry: f.entry(f.inventory[1]!) },
      { ...record, entry: { ...record.entry, reason: 'schema-valid-but-corrupted' } },
      { ...record, unexpected: true },
    ]) {
      yield* f.fs.writeFileString(join(f.directory, 'entry-0.json'), canonicalBuckMaintainJson(damaged))
      expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
    }
    yield* f.fs.writeFileString(join(f.directory, 'entry-0.json'), canonicalBuckMaintainJson(record))
    yield* f.fs.copyFile(join(f.directory, 'entry-0.json'), join(f.directory, 'entry-00.json'))
    expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('enforces positive safe root bounds and unique canonical inventory', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const session = yield* f.open()
    for (const bound of [0, -1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])
      expect((yield* selectBuckMaintainProgressRoots(session, bound).pipe(Effect.result))._tag).toBe('Failure')
    expect(yield* selectBuckMaintainProgressRoots(session, 2)).toEqual(f.inventory.slice(0, 2))
    expect(yield* selectBuckMaintainProgressRoots(session, 99)).toEqual(f.inventory)
    for (const inventory of [[f.inventory[0]!, f.inventory[0]!], [...f.inventory].reverse(), ['relative']])
      expect((yield* f.open({ ...f.expected, inventory }).pipe(Effect.result))._tag).toBe('Failure')
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('publishes a root only once when two fibers submit the same completed decision', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const session = yield* f.open()
    const outcomes = yield* Effect.all([
      session.append(f.entry(f.inventory[0]!), f.capture()).pipe(Effect.result),
      session.append(f.entry(f.inventory[0]!), f.capture()).pipe(Effect.result),
    ], { concurrency: 'unbounded' })
    expect(outcomes.map((outcome) => outcome._tag).sort()).toEqual(['Failure', 'Success'])
    expect((yield* f.open()).records.size).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('refuses a concurrent checkpoint writer and releases admission after interruption', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const lock = withExclusiveDirectoryLock(f.directory)
    const result = yield* lock(Effect.gen(function* () {
      yield* f.open()
      return yield* lock(f.open()).pipe(Effect.result)
    }))
    expect(result._tag).toBe('Failure')
    expect((yield* lock(f.open()).pipe(Effect.result))._tag).toBe('Success')
    expect((yield* lock(Effect.interrupt).pipe(Effect.exit))._tag).toBe('Failure')
    expect((yield* lock(f.open()).pipe(Effect.result))._tag).toBe('Success')
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.live('refuses symlinked, hardlinked, or shared-writable checkpoint state without repairing it', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const session = yield* f.open()
    yield* session.append(f.entry(f.inventory[0]!), f.capture())
    for (const name of ['manifest.json', 'entry-0.json']) {
      const path = join(f.directory, name)
      const saved = `${f.directory}-${name}`
      yield* f.fs.rename(path, saved)
      yield* f.fs.symlink(saved, path)
      expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
      yield* f.fs.remove(path)
      yield* f.fs.link(saved, path)
      expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
      yield* f.fs.remove(path)
      yield* f.fs.rename(saved, path)
      yield* f.fs.chmod(path, 0o666)
      expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
      expect((yield* f.fs.stat(path)).mode & 0o777).toBe(0o666)
      yield* f.fs.chmod(path, 0o600)
    }
    const alias = `${f.directory}-alias`
    yield* f.fs.symlink(f.directory, alias)
    expect((yield* openBuckMaintainProgress({ directory: alias, expected: f.expected }).pipe(Effect.result))._tag).toBe('Failure')
    yield* f.fs.chmod(f.directory, 0o777)
    expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
    yield* f.fs.chmod(f.directory, 0o700)
    expect((yield* f.open()).records.size).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

// Changing ownership needs root; non-root runs still exercise real mode/link refusal.
it.live.skipIf(process.getuid?.() !== 0)('refuses foreign-owned checkpoint files and directories', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    yield* f.open()
    for (const path of [join(f.directory, 'manifest.json'), f.directory]) {
      yield* Effect.acquireRelease(
        f.fs.chown(path, 1, 1),
        () => f.fs.chown(path, 0, process.getgid!()).pipe(Effect.orDie),
      ).pipe(Effect.flatMap(() => Effect.gen(function* () {
        expect((yield* f.open().pipe(Effect.result))._tag).toBe('Failure')
      })), Effect.scoped)
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
