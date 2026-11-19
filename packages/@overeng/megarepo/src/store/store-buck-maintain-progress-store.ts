import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import {
  BuckMaintainProgressError,
  BuckMaintainProgressManifestSchema,
  BuckMaintainProgressRecordSchema,
  canonicalBuckMaintainJson,
  decodeBuckMaintainProgressManifest,
  decodeBuckMaintainProgressRecord,
  validateBuckMaintainProgressOptions,
  type BuckMaintainCaptureTimes,
  type BuckMaintainProgressManifest,
  type BuckMaintainProgressRecord,
} from './store-buck-maintain-progress-schema.ts'
import type { BuckMaintainEntry } from './store-buck-maintain.ts'

const fail = (message: string) => new BuckMaintainProgressError({ message })
const digest = (content: string) => createHash('sha256').update(content).digest('hex')

/** In-memory view of the immutable manifest and atomically completed observations. */
export interface BuckMaintainProgressSession {
  readonly manifest: BuckMaintainProgressManifest
  readonly records: ReadonlyMap<number, BuckMaintainProgressRecord>
  readonly newlyDiscovered: ReadonlyArray<string>
  readonly append: (entry: BuckMaintainEntry, capture: BuckMaintainCaptureTimes) => Effect.Effect<void, BuckMaintainProgressError, FileSystem.FileSystem>
}

/** fsync the complete temporary file, rename, then fsync the containing directory. */
const publish = Effect.fn('store.buckMaintain.progress.publish')(function* (path: string, value: unknown) {
  const fs = yield* FileSystem.FileSystem
  const temporary = join(dirname(path), `.pending-${randomUUID()}`)
  yield* Effect.gen(function* () {
    yield* Effect.scoped(Effect.gen(function* () {
      const file = yield* fs.open(temporary, { flag: 'wx', mode: 0o600, noFollow: true })
      yield* file.writeAll(new TextEncoder().encode(canonicalBuckMaintainJson(value)))
      yield* file.sync
    }))
    yield* fs.rename(temporary, path)
    yield* Effect.scoped(Effect.gen(function* () {
      const directory = yield* fs.open(dirname(path), { flag: 'r', noFollow: true })
      yield* directory.sync
    }))
  }).pipe(Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)))
})

const readRegular = Effect.fn('store.buckMaintain.progress.read')(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const info = yield* fs.lstat(path)
  if (info.type !== 'File' || Option.getOrUndefined(info.nlink) !== 1n ||
    Option.getOrUndefined(info.uid) !== process.getuid?.() || (info.mode & 0o022) !== 0)
    return yield* fail(`Expected owned non-shared-writable regular checkpoint file: ${path}`)
  return yield* fs.readFileString(path)
})

/** Storage boundary. Caller must retain exclusive progress-directory admission throughout use.
 * Runtime identity is compared, not attested; the caller must attest the actual immutable
 * entrypoint and executable and normalize configuration before opening storage.
 */
export const openBuckMaintainProgress = Effect.fn('store.buckMaintain.progress.open')(function* ({
  directory, expected,
}: { directory: string; expected: Omit<BuckMaintainProgressManifest, 'createdAt'> }) {
  const fs = yield* FileSystem.FileSystem
  const directoryInfo = yield* fs.lstat(directory)
  if (directoryInfo.type !== 'Directory' || Option.getOrUndefined(directoryInfo.uid) !== process.getuid?.() ||
    (directoryInfo.mode & 0o022) !== 0 || resolve(directory) !== directory || (yield* fs.realPath(directory)) !== directory)
    return yield* fail('Expected an owned canonical non-shared-writable progress directory')
  const validInventory = (inventory: ReadonlyArray<string>) => inventory.every((root, index) =>
    resolve(root) === root && (index === 0 || root > inventory[index - 1]!))
  if (!validInventory(expected.inventory))
    return yield* fail('Checkpoint inventory must contain sorted unique absolute canonical roots')
  const names = yield* fs.readDirectory(directory)
  for (const name of names) {
    if (name !== 'manifest.json' && !/^entry-\d+\.json$/u.test(name) && !/^\.pending-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(name))
      return yield* fail(`Unknown checkpoint state: ${name}`)
  }
  const manifestPath = join(directory, 'manifest.json')
  const exists = names.includes('manifest.json')
  if (exists === false && names.some((name) => name.startsWith('entry-'))) return yield* fail('Checkpoint entries have no manifest')
  const manifest = exists === true
    ? yield* readRegular(manifestPath).pipe(Effect.flatMap(decodeBuckMaintainProgressManifest))
    : yield* Schema.decodeEffect(BuckMaintainProgressManifestSchema, { onExcessProperty: 'error' })({ ...expected, createdAt: Date.now() })
  if (!validInventory(manifest.inventory))
    return yield* fail('Invalid frozen checkpoint root inventory')
  const { createdAt: _createdAt, inventory: _frozenInventory, ...actual } = manifest
  const { inventory: _discoveredInventory, ...binding } = expected
  if (canonicalBuckMaintainJson(actual) !== canonicalBuckMaintainJson(binding))
    return yield* fail('Checkpoint runtime or configuration mismatch; use a new progress directory')
  if (exists === false) yield* publish(manifestPath, manifest)
  const manifestSha256 = digest(canonicalBuckMaintainJson(manifest))
  const frozenRoots = new Set(manifest.inventory)
  const records = new Map<number, BuckMaintainProgressRecord>()
  const writing = new Set<number>()
  for (const name of names.filter((name) => name.startsWith('entry-'))) {
    const record = yield* readRegular(join(directory, name)).pipe(Effect.flatMap(decodeBuckMaintainProgressRecord))
    const { recordSha256, ...payload } = record
    if (recordSha256 !== digest(canonicalBuckMaintainJson(payload))) return yield* fail(`Checkpoint record checksum mismatch: ${name}`)
    if (name !== `entry-${record.index}.json` || record.manifestSha256 !== manifestSha256 ||
      record.index >= manifest.inventory.length || record.entry.worktree !== manifest.inventory[record.index] ||
      records.has(record.index) || record.capture.completedAt < record.capture.startedAt ||
      record.capture.startedAt < manifest.createdAt || record.entry.bytesAfter !== record.entry.bytesBefore ||
      record.entry.daemon.some((daemon) => daemon.outcome === 'stopped'))
      return yield* fail(`Inconsistent checkpoint record: ${name}`)
    records.set(record.index, record)
  }
  return {
    manifest,
    records,
    newlyDiscovered: expected.inventory.filter((root) => !frozenRoots.has(root)),
    append: Effect.fn('store.buckMaintain.progress.append')(function* (entry: BuckMaintainEntry, capture: BuckMaintainCaptureTimes) {
      const index = manifest.inventory.indexOf(entry.worktree)
      if (index < 0 || records.has(index)) return yield* fail('Duplicate or out-of-inventory checkpoint entry')
      const payload = { version: 1 as const, manifestSha256, index, entry, capture }
      const record = yield* Schema.decodeEffect(BuckMaintainProgressRecordSchema, { onExcessProperty: 'error' })({
        ...payload, recordSha256: digest(canonicalBuckMaintainJson(payload)),
      })
      if (capture.completedAt < capture.startedAt || capture.startedAt < manifest.createdAt ||
        entry.bytesAfter !== entry.bytesBefore || entry.daemon.some((daemon) => daemon.outcome === 'stopped'))
        return yield* fail('Checkpoint requires a complete dry-run decision with valid capture times')
      if (records.has(index) || writing.has(index)) return yield* fail('Duplicate concurrent checkpoint entry')
      writing.add(index)
      yield* Effect.gen(function* () {
        yield* publish(join(directory, `entry-${index}.json`), record)
        records.set(index, record)
      }).pipe(Effect.ensuring(Effect.sync(() => { writing.delete(index) })))
    }, Effect.mapError((cause) => cause instanceof BuckMaintainProgressError ? cause : fail(String(cause)))),
  }
}, Effect.mapError((cause) => cause instanceof BuckMaintainProgressError ? cause : fail(String(cause))))

/** Select unfinished roots only; a shard defaults to one complete root decision. */
export const selectBuckMaintainProgressRoots = Effect.fn('store.buckMaintain.progress.select')(
  function* (session: BuckMaintainProgressSession, maxWorktrees: number | undefined) {
    const invalid = validateBuckMaintainProgressOptions({ dryRun: true, progressDir: '.', maxWorktrees })
    if (invalid !== undefined) return yield* invalid
    return session.manifest.inventory.filter((_, index) => !session.records.has(index)).slice(0, maxWorktrees ?? 1)
  },
)

/** Aggregate every completed historical observation, explicitly retaining its capture interval. */
export const buckMaintainProgressReceipt = (session: BuckMaintainProgressSession, processedThisRun: number) => {
  const captures = [...session.records.values()].sort((a, b) => a.index - b.index)
  const entries = captures.map((capture) => capture.entry)
  const actions = entries.filter((entry) => entry.action !== 'none').length
  const remaining = session.manifest.inventory.length - entries.length
  return {
    version: 1 as const, dryRun: true as const, entries,
    summary: { worktrees: entries.length, actions, skipped: entries.length - actions },
    progress: {
      version: 1 as const,
      evidence: 'historical-per-root-not-atomic-census' as const,
      authorizesApply: false as const,
      scope: 'initial-frozen-inventory' as const,
      newlyDiscovered: session.newlyDiscovered,
      complete: remaining === 0,
      total: session.manifest.inventory.length,
      completed: entries.length,
      remaining,
      processedThisRun,
      manifest: session.manifest,
      captures,
    },
  }
}
