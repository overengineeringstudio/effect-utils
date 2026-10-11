import { createHash, randomUUID } from 'node:crypto'
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { lstat, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import {
  managedEditorViewSnapshots,
  positiveEditorViewProcessReferences,
} from './editor-view-readers.ts'
import {
  collectEditorViewContentStore,
  defaultEditorViewContentStore,
  editorViewStagingCreatorIdentity,
  withEditorViewContentStoreLock,
} from './editor-view-sharing.ts'
import { emitCompletedSpan, type OtelSpanAttribute } from './otel-span-cli.ts'

/**
 * Host-wide byte budget for editor-view generations and their shared CAS.
 *
 * Accounting covers every discovered editor root (registered Git worktrees,
 * legacy roots and the publishing root): private generation trees, copy
 * fallbacks, retired `.gc-*`/`.legacy` leftovers and the whole content store,
 * deduplicated by inode so CAS hardlinks count once. Immutable generation
 * footprints are cached by validated identity in a private sibling of the CAS
 * (`<contentStore>.budget`), so warm touches never walk payloads.
 *
 * Locking: payload walks, CAS census, reader census and recursive cleanup run
 * outside the CAS flock. Root publication locks are acquired first via the
 * caller's nonblocking callback; the CAS flock is only ever taken while
 * already holding them, never the reverse.
 */

/** One editor state root and the repository (worktree) that encloses it. */
export type EditorViewBudgetRoot = { readonly repoRoot: string; readonly editorRoot: string }
/** A held root publication lock acquired by `tryLockRoot`. */
export type EditorViewBudgetRootLock = { readonly release: () => void }

/** Marker left at `<editorRoot>/.evicted-<view>.json` after a current generation is evicted. */
export const editorViewEvictedSchema = 'effect-utils/editor-view-evicted/v1' as const
/** Durable explanation consumed when an evicted current view is republished. */
export type EditorViewEvictedMarker = {
  readonly schema: typeof editorViewEvictedSchema
  readonly snapshot: string
  readonly reason: 'host-budget'
  readonly budgetBytes: number
  readonly usedBytes: number
}

const defaultBudgetBytes = 40_000_000_000
const graceMs = 5 * 60 * 1_000
/** Warm touches rewrite last use at most this often; eviction grace is extended by it. */
const touchRefreshMs = 60 * 1_000
const defaultRecencyMs = 24 * 60 * 60 * 1_000
const warningRatio = 0.8
const maxAdmissionRounds = 8
const journalLimit = 1_024
const statBatch = 64
const topHolderCount = 5
const stateSchema = 'effect-utils/editor-view-budget/v2'
const generationPattern = /^([A-Za-z0-9][A-Za-z0-9_-]*)-([0-9a-f]{64})$/
const snapshotPattern = /^\.store\/([A-Za-z0-9][A-Za-z0-9_-]*-[0-9a-f]{64})$/
/** Linked-inode sidecar record: dev, ino, size as little-endian u64. */
const entryBytes = 24

const fail: (message: string) => never = (message) => {
  throw new Error(`editor view host budget: ${message}`)
}

const hasCode = ({
  error,
  codes,
}: {
  readonly error: unknown
  readonly codes: readonly string[]
}) =>
  error instanceof Error &&
  'code' in error &&
  typeof error.code === 'string' &&
  codes.includes(error.code) === true

const vanished = (error: unknown): boolean => hasCode({ error, codes: ['ENOENT', 'ENOTDIR'] })

const isWithin = ({ root, candidate }: { readonly root: string; readonly candidate: string }) => {
  const path = relative(root, candidate)
  return (
    path === '' ||
    (path !== '..' && path.startsWith(`..${sep}`) === false && isAbsolute(path) === false)
  )
}

const userId = (): number => process.getuid?.() ?? fail('host budget requires a POSIX user id')

/** Parse `EDITOR_VIEW_HOST_BUDGET_BYTES`; strict positive safe integer, default 40 GB. */
export const editorViewHostBudgetBytes = (): number => {
  const raw = process.env.EDITOR_VIEW_HOST_BUDGET_BYTES
  if (raw === undefined) return defaultBudgetBytes
  const value = Number(raw)
  if (/^[1-9][0-9]*$/.test(raw) === false || Number.isSafeInteger(value) === false)
    return fail(`EDITOR_VIEW_HOST_BUDGET_BYTES must be a positive safe integer of bytes: ${raw}`)
  return value
}

/**
 * Parse `EDITOR_VIEW_HOST_RECENCY_MS`: a root published or explicitly used
 * within this window keeps its current generations. Default 24 h; 0 disables.
 */
export const editorViewHostRecencyMs = (): number => {
  const raw = process.env.EDITOR_VIEW_HOST_RECENCY_MS
  if (raw === undefined) return defaultRecencyMs
  const value = Number(raw)
  if (/^(?:0|[1-9][0-9]*)$/.test(raw) === false || Number.isSafeInteger(value) === false)
    return fail(
      `EDITOR_VIEW_HOST_RECENCY_MS must be a non-negative safe integer of milliseconds: ${raw}`,
    )
  return value
}

// ---------------------------------------------------------------------------
// Persistent ledger (private sibling of the CAS root; mutated only under its flock)
// ---------------------------------------------------------------------------

type Reservation = {
  readonly token: string
  readonly pid: number
  /** Process incarnation (boot id + start time); reclaim never trusts the PID alone. */
  readonly process: string
  readonly editorRoot: string
  readonly bytes: number
  /** Budget the reservation was admitted against; diagnostics after commit reuse it. */
  readonly budgetBytes: number
  readonly createdAtMs: number
}

type CachedGeneration = {
  readonly editorRoot: string
  readonly name: string
  readonly identity: string
  readonly ownedBytes: number
  readonly linkedBytes: number
  readonly sidecar: string
  readonly readOnly: boolean
  /** Owning package from a recognized record; absent records are never evicted. */
  readonly package?: string
}

type Usage = {
  readonly usedBytes: number
  readonly protectedBytes: number
  readonly measuredAtMs: number
}

type BudgetState = {
  epoch: number
  /** Census taken before this epoch can no longer see every later finish. */
  journalFloor: number
  /**
   * Conservative upper-bound estimates (full generation footprint, shared
   * inodes included) of generations finished after a census; admission adds
   * them to that census, and the next census measures the real usage.
   */
  journal: { readonly epoch: number; readonly estimatedBytes: number }[]
  roots: Map<string, string>
  generations: Map<string, CachedGeneration>
  lastUse: Map<string, number>
  reservations: Map<string, Reservation>
  usage: Usage | undefined
  warned: boolean
}

const emptyState = (): BudgetState => ({
  epoch: 0,
  journalFloor: 0,
  journal: [],
  roots: new Map(),
  generations: new Map(),
  lastUse: new Map(),
  reservations: new Map(),
  usage: undefined,
  warned: false,
})

const budgetDirectory = (contentStore: string): string => `${resolve(contentStore)}.budget`
const statePath = (contentStore: string): string =>
  join(budgetDirectory(contentStore), 'state-v2.json')
const footprintDirectory = (contentStore: string): string =>
  join(budgetDirectory(contentStore), 'footprints')

const ensureBudgetDirectory = (contentStore: string): void => {
  for (const path of [budgetDirectory(contentStore), footprintDirectory(contentStore)]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const status = lstatSync(path)
    if (status.isDirectory() === false || status.uid !== userId())
      fail(`budget metadata must be a real directory owned by the current user: ${path}`)
  }
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json }
const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) === true && value >= 0
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const decodeState = ({
  value,
  path,
}: {
  readonly value: unknown
  readonly path: string
}): BudgetState => {
  const invalid = (): never => fail(`ledger does not conform to ${stateSchema}: ${path}`)
  if (isObject(value) === false || value.schema !== stateSchema) return invalid()
  const state = emptyState()
  if (isCount(value.epoch) === false || isCount(value.journalFloor) === false) return invalid()
  state.epoch = value.epoch
  state.journalFloor = value.journalFloor
  if (typeof value.warned !== 'boolean') return invalid()
  state.warned = value.warned
  if (Array.isArray(value.journal) === false) return invalid()
  for (const entry of value.journal) {
    if (
      isObject(entry) === false ||
      isCount(entry.epoch) === false ||
      isCount(entry.estimatedBytes) === false
    )
      return invalid()
    state.journal.push({ epoch: entry.epoch, estimatedBytes: entry.estimatedBytes })
  }
  const records = (field: unknown): readonly (readonly [string, unknown])[] =>
    isObject(field) === true ? Object.entries(field) : invalid()
  for (const [editorRoot, repoRoot] of records(value.roots)) {
    if (isText(repoRoot) === false) return invalid()
    state.roots.set(editorRoot, repoRoot)
  }
  for (const [key, entry] of records(value.generations)) {
    if (
      isObject(entry) === false ||
      isText(entry.editorRoot) === false ||
      isAbsolute(entry.editorRoot) === false ||
      typeof entry.name !== 'string' ||
      generationPattern.test(entry.name) === false ||
      key !== generationKey({ editorRoot: entry.editorRoot, name: entry.name }) ||
      isText(entry.identity) === false ||
      isCount(entry.ownedBytes) === false ||
      isCount(entry.linkedBytes) === false ||
      typeof entry.sidecar !== 'string' ||
      /^[0-9a-f]{64}\.bin$/.test(entry.sidecar) === false ||
      typeof entry.readOnly !== 'boolean' ||
      (entry.package !== undefined && typeof entry.package !== 'string')
    )
      return invalid()
    state.generations.set(key, {
      editorRoot: entry.editorRoot,
      name: entry.name,
      identity: entry.identity,
      ownedBytes: entry.ownedBytes,
      linkedBytes: entry.linkedBytes,
      sidecar: entry.sidecar,
      readOnly: entry.readOnly,
      ...(typeof entry.package === 'string' ? { package: entry.package } : {}),
    })
  }
  for (const [key, at] of records(value.lastUse)) {
    if (isCount(at) === false) return invalid()
    state.lastUse.set(key, at)
  }
  for (const [token, entry] of records(value.reservations)) {
    if (
      isObject(entry) === false ||
      entry.token !== token ||
      isCount(entry.pid) === false ||
      isText(entry.process) === false ||
      isText(entry.editorRoot) === false ||
      isCount(entry.bytes) === false ||
      isCount(entry.budgetBytes) === false ||
      isCount(entry.createdAtMs) === false
    )
      return invalid()
    state.reservations.set(token, {
      token,
      pid: entry.pid,
      process: entry.process,
      editorRoot: entry.editorRoot,
      bytes: entry.bytes,
      budgetBytes: entry.budgetBytes,
      createdAtMs: entry.createdAtMs,
    })
  }
  if (value.usage !== undefined) {
    const usage = value.usage
    if (
      isObject(usage) === false ||
      isCount(usage.usedBytes) === false ||
      isCount(usage.protectedBytes) === false ||
      isCount(usage.measuredAtMs) === false
    )
      return invalid()
    state.usage = {
      usedBytes: usage.usedBytes,
      protectedBytes: usage.protectedBytes,
      measuredAtMs: usage.measuredAtMs,
    }
  }
  return state
}

/**
 * Atomic snapshot read; mutation callers hold the CAS flock. The ledger must
 * be a private regular file owned by this user, opened without following links.
 */
const readState = (contentStore: string): BudgetState => {
  const path = statePath(contentStore)
  let text: string
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (vanished(error) === true) return emptyState()
    if (hasCode({ error, codes: ['ELOOP'] }) === true)
      return fail(`ledger must not be a symbolic link: ${path}`)
    throw error
  }
  try {
    const status = fstatSync(descriptor)
    if (status.isFile() === false || status.uid !== userId() || (status.mode & 0o077) !== 0)
      return fail(`ledger must be a regular 0600 file owned by the current user: ${path}`)
    text = readFileSync(descriptor, 'utf8')
  } finally {
    closeSync(descriptor)
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    return fail(
      `unreadable ledger ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return decodeState({ value, path })
}

const writeState = ({
  contentStore,
  state,
}: {
  readonly contentStore: string
  readonly state: BudgetState
}) => {
  ensureBudgetDirectory(contentStore)
  const value: { readonly [key: string]: Json } = {
    schema: stateSchema,
    epoch: state.epoch,
    journalFloor: state.journalFloor,
    journal: state.journal.map((entry) => ({
      epoch: entry.epoch,
      estimatedBytes: entry.estimatedBytes,
    })),
    roots: Object.fromEntries(state.roots),
    generations: Object.fromEntries(
      Array.from(state.generations, ([key, entry]) => [
        key,
        {
          editorRoot: entry.editorRoot,
          name: entry.name,
          identity: entry.identity,
          ownedBytes: entry.ownedBytes,
          linkedBytes: entry.linkedBytes,
          sidecar: entry.sidecar,
          readOnly: entry.readOnly,
          ...(entry.package === undefined ? {} : { package: entry.package }),
        },
      ]),
    ),
    lastUse: Object.fromEntries(state.lastUse),
    reservations: Object.fromEntries(
      Array.from(state.reservations, ([token, entry]) => [
        token,
        {
          token: entry.token,
          pid: entry.pid,
          process: entry.process,
          editorRoot: entry.editorRoot,
          bytes: entry.bytes,
          budgetBytes: entry.budgetBytes,
          createdAtMs: entry.createdAtMs,
        },
      ]),
    ),
    ...(state.usage === undefined
      ? {}
      : {
          usage: {
            usedBytes: state.usage.usedBytes,
            protectedBytes: state.usage.protectedBytes,
            measuredAtMs: state.usage.measuredAtMs,
          },
        }),
    warned: state.warned,
  }
  const path = statePath(contentStore)
  const candidate = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(candidate, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
    renameSync(candidate, path)
  } finally {
    rmSync(candidate, { force: true })
  }
}

const appendJournal = ({
  state,
  estimatedBytes,
}: {
  readonly state: BudgetState
  readonly estimatedBytes: number
}) => {
  state.epoch += 1
  state.journal.push({ epoch: state.epoch, estimatedBytes })
  while (state.journal.length > journalLimit) {
    const dropped = state.journal.shift()
    if (dropped !== undefined) state.journalFloor = Math.max(state.journalFloor, dropped.epoch)
  }
}

let selfIncarnation: string | undefined
const selfProcess = (): string =>
  (selfIncarnation ??= editorViewStagingCreatorIdentity({ pid: process.pid }))

/** Drop only reservations whose recorded incarnation is recognizably gone. */
const reclaimDeadReservations = (state: BudgetState): number => {
  let reclaimed = 0
  for (const [token, reservation] of state.reservations) {
    if (reservation.pid === process.pid && reservation.process === selfProcess()) continue
    const observed = editorViewStagingCreatorIdentity({ pid: reservation.pid })
    const dead =
      observed === 'dead' ||
      (observed !== 'unknown' &&
        reservation.process !== 'unknown' &&
        observed !== reservation.process)
    if (dead === true) {
      state.reservations.delete(token)
      reclaimed += 1
    }
  }
  if (reclaimed > 0) state.epoch += 1
  return reclaimed
}

const reservedBytes = (state: BudgetState): number =>
  Array.from(state.reservations.values()).reduce((sum, entry) => sum + entry.bytes, 0)

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

type Holder = { readonly editorRoot: string; readonly bytes: number; readonly generations: number }

type BudgetEvent = {
  readonly event:
    | 'editor-view.host-budget.over-budget'
    | 'editor-view.host-budget.warning'
    | 'editor-view.host-budget.evicted'
    | 'editor-view.host-budget.underreserved'
  readonly budgetBytes: number
  /** Measured by the last census: inode-deduplicated, so shared CAS counts once. */
  readonly usedBytes: number
  /** Measured bytes that eviction cannot free (pins, live readers, grace, recency, locks). */
  readonly protectedBytes: number
  /** Live reservations of in-flight publications (conservative estimates). */
  readonly reservedBytes: number
  /** Upper-bound estimates of generations finished since the census. */
  readonly pendingEstimateBytes: number
  /** The incoming request (reserve) or the reconciled reservation (finish). */
  readonly reservationBytes: number
  readonly topHolders: readonly Holder[]
  readonly message: string
  readonly evicted?: readonly string[]
  /** Paths whose bytes could not be read; usage is then a lower bound. */
  readonly unaccounted?: readonly string[]
}

const signal = ({
  event,
  startedAtMs,
  exitCode,
}: {
  readonly event: BudgetEvent
  readonly startedAtMs: number
  readonly exitCode: number
}): void => {
  process.stderr.write(`${JSON.stringify(event)}\n`)
  const attributes: OtelSpanAttribute[] = [
    ['editor_view.host_budget.event', event.event],
    ['editor_view.host_budget.budget_bytes', event.budgetBytes],
    ['editor_view.host_budget.used_bytes', event.usedBytes],
    ['editor_view.host_budget.protected_bytes', event.protectedBytes],
    ['editor_view.host_budget.reserved_bytes', event.reservedBytes],
    ['editor_view.host_budget.pending_estimate_bytes', event.pendingEstimateBytes],
    ['editor_view.host_budget.reservation_bytes', event.reservationBytes],
    ['editor_view.host_budget.top_holders', JSON.stringify(event.topHolders)],
  ]
  if (event.evicted !== undefined)
    attributes.push(['editor_view.host_budget.evicted', event.evicted.join(',')])
  if (event.unaccounted !== undefined)
    attributes.push(['editor_view.host_budget.unaccounted_paths', event.unaccounted.length])
  emitCompletedSpan({
    name: 'editor-view.host-budget',
    label: event.event.slice('editor-view.host-budget.'.length),
    attributes,
    startedAtMs,
    endedAtMs: Date.now(),
    exitCode,
  })
}

const formatHolders = (holders: readonly Holder[]): string =>
  holders.length === 0
    ? 'none'
    : holders
        .map((holder) => `${holder.editorRoot}=${holder.bytes}B/${holder.generations}gen`)
        .join(', ')

/** Emit once when protected use crosses the warning ratio; re-arm below it. */
const updateWarning = ({
  state,
  budgetBytes,
  topHolders,
  startedAtMs,
}: {
  readonly state: BudgetState
  readonly budgetBytes: number
  readonly topHolders: readonly Holder[]
  readonly startedAtMs: number
}): void => {
  if (state.usage === undefined) return
  const reserved = reservedBytes(state)
  const crossing = state.usage.protectedBytes + reserved >= budgetBytes * warningRatio
  if (crossing === true && state.warned === false)
    signal({
      event: {
        event: 'editor-view.host-budget.warning',
        budgetBytes,
        usedBytes: state.usage.usedBytes,
        protectedBytes: state.usage.protectedBytes,
        reservedBytes: reserved,
        pendingEstimateBytes: 0,
        reservationBytes: 0,
        topHolders,
        message: `editor views protect ${state.usage.protectedBytes} measured bytes plus ${reserved} reserved of the ${budgetBytes}-byte host budget (>=${warningRatio * 100}%); top holders: ${formatHolders(topHolders)}. Release idle worktrees, unpin generations, or raise EDITOR_VIEW_HOST_BUDGET_BYTES before publications run over budget.`,
      },
      startedAtMs,
      exitCode: 0,
    })
  state.warned = crossing
}

// ---------------------------------------------------------------------------
// Footprints (walked outside the flock; cached by validated immutable identity)
// ---------------------------------------------------------------------------

type TreeFootprint = {
  readonly ownedBytes: number
  /** dev/ino/size triples of inodes with more than one link (CAS or private hardlinks). */
  readonly linked: Buffer
  readonly linkedBytes: number
  readonly readOnly: boolean
}

const lstatIfPresent = async (path: string): Promise<BigIntStats | undefined> => {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if (vanished(error) === true) return undefined
    throw error
  }
}

/* eslint-disable no-await-in-loop -- Bounded stat batches keep payload walks from fanning out unboundedly. */
/** Unreadable directories are reported in `unknown`; usage is then a lower bound. */
const walkTree = async ({
  root,
  unknown,
}: {
  readonly root: string
  readonly unknown: string[]
}): Promise<TreeFootprint | undefined> => {
  const rootStatus = await lstatIfPresent(root)
  if (rootStatus === undefined) return undefined
  let ownedBytes = 0
  let linkedBytes = 0
  // Unreadable or writable trees are never evictable.
  let readOnly = rootStatus.isDirectory() === true && (rootStatus.mode & 0o222n) === 0n
  const linked: bigint[] = []
  const admit = (status: BigIntStats): void => {
    if (status.isFile() === true && status.nlink > 1n) {
      linked.push(status.dev, status.ino, status.size)
      linkedBytes += Number(status.size)
    } else ownedBytes += Number(status.size)
  }
  admit(rootStatus)
  if (rootStatus.isDirectory() === false) readOnly = false
  const pending = rootStatus.isDirectory() === true ? [root] : []
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (vanished(error) === true) continue
      if (hasCode({ error, codes: ['EACCES', 'EPERM'] }) === true) {
        readOnly = false
        unknown.push(directory)
        continue
      }
      throw error
    }
    for (let index = 0; index < names.length; index += statBatch) {
      const batch = await Promise.all(
        names.slice(index, index + statBatch).map(async (name) => {
          const path = join(directory, name)
          return { path, status: await lstatIfPresent(path) }
        }),
      )
      for (const { path, status } of batch) {
        if (status === undefined) continue
        admit(status)
        if (status.isDirectory() === true) pending.push(path)
        else if (status.isFile() === false && status.isSymbolicLink() === false) readOnly = false
        if (status.isSymbolicLink() === false && (status.mode & 0o222n) !== 0n) readOnly = false
      }
    }
  }
  const buffer = Buffer.alloc(linked.length * 8)
  linked.forEach((value, index) => buffer.writeBigUInt64LE(value, index * 8))
  return { ownedBytes, linked: buffer, linkedBytes, readOnly }
}
/* eslint-enable no-await-in-loop */

const forEachLinked = ({
  linked,
  visit,
}: {
  readonly linked: Buffer
  readonly visit: (key: string, size: number) => void
}): void => {
  for (let offset = 0; offset + entryBytes <= linked.length; offset += entryBytes)
    visit(
      `${linked.readBigUInt64LE(offset)}:${linked.readBigUInt64LE(offset + 8)}`,
      Number(linked.readBigUInt64LE(offset + 16)),
    )
}

/** Directory inode plus record inode/content stamp; directory mtime is lifecycle metadata. */
const generationIdentity = (
  dir: string,
): { readonly identity: string; readonly mtimeMs: number } | undefined => {
  try {
    const status = lstatSync(dir, { bigint: true })
    const record = lstatSync(join(dir, 'editor-view.json'), { bigint: true })
    if (
      status.isDirectory() === false ||
      record.isFile() === false ||
      (status.mode & 0o222n) !== 0n ||
      (record.mode & 0o222n) !== 0n ||
      status.uid !== BigInt(userId())
    )
      return undefined
    return {
      identity: `${status.dev}:${status.ino}:${status.mode}:${record.dev}:${record.ino}:${record.size}:${record.mtimeNs}`,
      mtimeMs: Number(status.mtimeMs),
    }
  } catch (error) {
    if (vanished(error) === true) return undefined
    throw error
  }
}

/** Recognize the owning package of a generation; unknown protocols stay protected. */
const recordPackage = async ({ dir, name }: { readonly dir: string; readonly name: string }) => {
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, 'editor-view.json'), 'utf8'))
    if (
      isObject(value) === true &&
      typeof value.schema === 'string' &&
      value.schema.startsWith('effect-utils/editor-view/') === true &&
      value.snapshot === `.store/${name}` &&
      typeof value.package === 'string'
    )
      return value.package
  } catch {}
  return undefined
}

const sidecarName = ({
  key,
  identity,
}: {
  readonly key: string
  readonly identity: string
}): string => `${createHash('sha256').update(`${key}\0${identity}`).digest('hex')}.bin`

const writeSidecar = async ({
  contentStore,
  name,
  linked,
}: {
  readonly contentStore: string
  readonly name: string
  readonly linked: Buffer
}): Promise<void> => {
  ensureBudgetDirectory(contentStore)
  const path = join(footprintDirectory(contentStore), name)
  const candidate = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(candidate, linked, { flag: 'wx', mode: 0o600 })
    await rename(candidate, path)
  } finally {
    await unlink(candidate).catch(() => undefined)
  }
}

const readSidecar = async ({
  contentStore,
  entry,
}: {
  readonly contentStore: string
  readonly entry: CachedGeneration
}): Promise<Buffer | undefined> => {
  try {
    const linked = await readFile(join(footprintDirectory(contentStore), entry.sidecar))
    return linked.length % entryBytes === 0 ? linked : undefined
  } catch (error) {
    if (vanished(error) === true) return undefined
    throw error
  }
}

// ---------------------------------------------------------------------------
// Census
// ---------------------------------------------------------------------------

type RootView = {
  readonly root: EditorViewBudgetRoot
  readonly key: string
  /** Owned, canonical, same-CAS root whose generations may be evicted under its lock. */
  readonly trusted: boolean
  readonly held: boolean
  /** Generation name -> view name of each canonical current pointer. */
  readonly currents: ReadonlyMap<string, string>
  /** Latest publication (pointer mtime) or recorded explicit use of this root. */
  readonly activeAtMs: number
  /** Advisory managed pins read outside the flock; undefined means unreadable. */
  readonly pins: ReadonlySet<string> | undefined
}

type GenerationView = {
  readonly key: string
  readonly root: RootView
  readonly name: string
  readonly dir: string
  readonly kind: 'generation' | 'unmanaged'
  readonly identity: string | undefined
  readonly ownedBytes: number
  readonly linked: Buffer
  readonly readOnly: boolean
  readonly package: string | undefined
  readonly lastUseMs: number
}

type Census = {
  readonly epoch: number
  readonly roots: readonly RootView[]
  readonly generations: readonly GenerationView[]
  readonly cas: ReadonlyMap<string, number>
  readonly usedBytes: number
  readonly unreferencedCasBytes: number
  readonly topHolders: readonly Holder[]
  readonly cache: ReadonlyMap<string, CachedGeneration>
  /** Paths whose bytes could not be read; usage is reported as a lower bound. */
  readonly unknown: readonly string[]
}

const generationKey = ({
  editorRoot,
  name,
}: {
  readonly editorRoot: string
  readonly name: string
}) => `${editorRoot}\0${name}`

/** Validate a discovered root's identity and ownership without trusting its contents. */
const inspectRoot = ({
  root,
  contentStore,
  held,
  registered,
}: {
  readonly root: EditorViewBudgetRoot
  readonly contentStore: string
  readonly held: boolean
  /** Registered by reserve/finish/touch in this content store's own ledger. */
  readonly registered: boolean
}): { readonly exists: boolean; readonly trusted: boolean } => {
  let status: BigIntStats
  try {
    status = lstatSync(root.editorRoot, { bigint: true })
  } catch (error) {
    if (vanished(error) === true) return { exists: false, trusted: false }
    throw error
  }
  if (status.isDirectory() === false) return { exists: false, trusted: false }
  try {
    const store = lstatSync(join(root.editorRoot, '.store'), { bigint: true })
    const repoRoot = realpathSync(root.repoRoot)
    const sameStore =
      held === true ||
      registered === true ||
      resolve(defaultEditorViewContentStore(repoRoot)) === resolve(contentStore)
    return {
      exists: true,
      trusted:
        status.uid === BigInt(userId()) &&
        realpathSync(root.editorRoot) === root.editorRoot &&
        repoRoot === root.repoRoot &&
        isWithin({ root: repoRoot, candidate: root.editorRoot }) === true &&
        store.isDirectory() === true &&
        store.uid === BigInt(userId()) &&
        sameStore === true,
    }
  } catch {
    return { exists: true, trusted: false }
  }
}

/* eslint-disable no-await-in-loop -- Content-store census streams shards; it is metadata only and never hashes. */
const casCensus = async (
  contentStore: string,
): Promise<{ readonly inodes: Map<string, number>; readonly otherBytes: number }> => {
  const inodes = new Map<string, number>()
  let otherBytes = 0
  const pending = [resolve(contentStore)]
  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    const status = await lstatIfPresent(directory)
    if (status === undefined || status.isDirectory() === false) continue
    otherBytes += Number(status.size)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (vanished(error) === true) continue
      throw error
    }
    for (let index = 0; index < names.length; index += statBatch) {
      const batch = await Promise.all(
        names.slice(index, index + statBatch).map(async (name) => {
          const path = join(directory, name)
          return { path, status: await lstatIfPresent(path) }
        }),
      )
      for (const entry of batch) {
        if (entry.status === undefined) continue
        if (entry.status.isDirectory() === true) pending.push(entry.path)
        else if (entry.status.isFile() === true)
          inodes.set(`${entry.status.dev}:${entry.status.ino}`, Number(entry.status.size))
        else otherBytes += Number(entry.status.size)
      }
    }
  }
  return { inodes, otherBytes }
}
/* eslint-enable no-await-in-loop */

const listRoots = ({
  contentStore,
  root,
  heldEditorRoot,
  discoverRoots,
  state,
  unknown,
}: {
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
  readonly heldEditorRoot: string
  readonly discoverRoots: () => readonly EditorViewBudgetRoot[]
  readonly state: BudgetState
  readonly unknown: string[]
}): RootView[] => {
  const candidates = new Map<string, EditorViewBudgetRoot>()
  for (const [editorRoot, repoRoot] of state.roots)
    candidates.set(editorRoot, { repoRoot, editorRoot })
  for (const entry of [...discoverRoots(), root])
    candidates.set(resolve(entry.editorRoot), {
      repoRoot: resolve(entry.repoRoot),
      editorRoot: resolve(entry.editorRoot),
    })
  const views: RootView[] = []
  for (const candidate of candidates.values()) {
    const held = candidate.editorRoot === resolve(heldEditorRoot)
    const inspected = inspectRoot({
      root: candidate,
      contentStore,
      held,
      registered: state.roots.get(candidate.editorRoot) === candidate.repoRoot,
    })
    if (inspected.exists === false) continue
    const currents = new Map<string, string>()
    let activeAtMs = 0
    for (const [key, at] of state.lastUse)
      if (key.startsWith(`${candidate.editorRoot}\0`) === true)
        activeAtMs = Math.max(activeAtMs, at)
    let entries: string[] = []
    try {
      entries = readdirSync(candidate.editorRoot)
    } catch (error) {
      if (vanished(error) === false) unknown.push(candidate.editorRoot)
    }
    for (const name of entries) {
      try {
        const path = join(candidate.editorRoot, name)
        const status = lstatSync(path)
        if (status.isSymbolicLink() === false) continue
        const target = snapshotPattern.exec(readlinkSync(path))?.[1]
        if (target !== undefined && target.startsWith(`${name}-`) === true) {
          currents.set(target, name)
          // Pointer replacement is publication; legacy roots without ledger use rely on it.
          activeAtMs = Math.max(activeAtMs, status.mtimeMs)
        }
      } catch (error) {
        if (vanished(error) === false) throw error
      }
    }
    let pins: ReadonlySet<string> | undefined
    try {
      pins = managedEditorViewSnapshots(candidate.editorRoot)
    } catch {
      pins = undefined
    }
    views.push({
      root: candidate,
      key: candidate.editorRoot,
      trusted: inspected.trusted,
      held,
      currents,
      activeAtMs,
      pins,
    })
  }
  return views
}

const takeCensus = async ({
  contentStore,
  root,
  heldEditorRoot,
  discoverRoots,
}: {
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
  readonly heldEditorRoot: string
  readonly discoverRoots: () => readonly EditorViewBudgetRoot[]
}): Promise<Census> => {
  const state = readState(contentStore)
  const unknown: string[] = []
  const roots = listRoots({ contentStore, root, heldEditorRoot, discoverRoots, state, unknown })
  const reservedRoots = new Set(
    Array.from(state.reservations.values(), (entry) => entry.editorRoot),
  )
  const cache = new Map<string, CachedGeneration>()
  const generations: GenerationView[] = []
  const rootBytes = new Map<string, number>()
  const addUnmanaged = async ({
    rootView,
    dir,
    name,
  }: {
    rootView: RootView
    dir: string
    name: string
  }) => {
    const footprint = await walkTree({ root: dir, unknown })
    if (footprint === undefined) return
    generations.push({
      key: generationKey({ editorRoot: rootView.key, name }),
      root: rootView,
      name,
      dir,
      kind: 'unmanaged',
      identity: undefined,
      ownedBytes: footprint.ownedBytes,
      linked: footprint.linked,
      readOnly: false,
      package: undefined,
      lastUseMs: Date.now(),
    })
  }
  // Bound filesystem requests and live footprint memory while accumulating one census.
  /* eslint-disable no-await-in-loop */
  for (const rootView of roots) {
    const editorRoot = rootView.key
    const storeDir = join(editorRoot, '.store')
    let rootEntries: string[] = []
    try {
      rootEntries = readdirSync(editorRoot)
    } catch (error) {
      if (vanished(error) === false) unknown.push(editorRoot)
    }
    for (const name of rootEntries) {
      if (name === '.store') continue
      const path = join(editorRoot, name)
      const status = await lstatIfPresent(path)
      if (status === undefined) continue
      if (status.isDirectory() === true) await addUnmanaged({ rootView, dir: path, name })
      else rootBytes.set(editorRoot, (rootBytes.get(editorRoot) ?? 0) + Number(status.size))
    }
    let storeEntries: string[] = []
    try {
      if (lstatSync(storeDir).isDirectory() === true) storeEntries = readdirSync(storeDir)
    } catch (error) {
      if (vanished(error) === false) unknown.push(storeDir)
    }
    for (const name of storeEntries) {
      const dir = join(storeDir, name)
      // Live candidates are covered by their publisher's reservation.
      if (name.startsWith('.candidate-') === true && reservedRoots.has(editorRoot) === true)
        continue
      if (generationPattern.test(name) === false) {
        await addUnmanaged({ rootView, dir, name: `.store/${name}` })
        continue
      }
      const key = generationKey({ editorRoot, name })
      const stamp = generationIdentity(dir)
      const cached = state.generations.get(key)
      let entry: CachedGeneration | undefined
      let linked: Buffer | undefined
      if (stamp !== undefined && cached !== undefined && cached.identity === stamp.identity) {
        linked = await readSidecar({ contentStore, entry: cached })
        if (linked !== undefined) entry = cached
      }
      if (entry === undefined || linked === undefined) {
        const footprint = await walkTree({ root: dir, unknown })
        if (footprint === undefined) continue
        const recordedPackage = await recordPackage({ dir, name })
        linked = footprint.linked
        if (stamp !== undefined && footprint.readOnly === true) {
          const sidecar = sidecarName({ key, identity: stamp.identity })
          await writeSidecar({ contentStore, name: sidecar, linked })
          entry = {
            editorRoot,
            name,
            identity: stamp.identity,
            ownedBytes: footprint.ownedBytes,
            linkedBytes: footprint.linkedBytes,
            sidecar,
            readOnly: true,
            ...(recordedPackage === undefined ? {} : { package: recordedPackage }),
          }
        } else {
          generations.push({
            key,
            root: rootView,
            name,
            dir,
            kind: 'generation',
            identity: undefined,
            ownedBytes: footprint.ownedBytes,
            linked,
            readOnly: false,
            package: recordedPackage,
            lastUseMs: Date.now(),
          })
          continue
        }
      }
      cache.set(key, entry)
      generations.push({
        key,
        root: rootView,
        name,
        dir,
        kind: 'generation',
        identity: entry.identity,
        ownedBytes: entry.ownedBytes,
        linked,
        readOnly: entry.readOnly,
        package: entry.package,
        lastUseMs: Math.max(stamp?.mtimeMs ?? 0, state.lastUse.get(key) ?? 0),
      })
    }
  }
  /* eslint-enable no-await-in-loop */
  const cas = await casCensus(contentStore)
  // The ledger and footprint sidecars live beside the CAS and occupy host bytes too.
  const ledger = await walkTree({ root: budgetDirectory(contentStore), unknown })
  const distinct = new Map(cas.inodes)
  const referenced = new Set<string>()
  const holders = new Map<string, { bytes: number; generations: number; seen: Set<string> }>()
  let usedBytes = cas.otherBytes + (ledger?.ownedBytes ?? 0) + (ledger?.linkedBytes ?? 0)
  for (const bytes of rootBytes.values()) usedBytes += bytes
  for (const generation of generations) {
    usedBytes += generation.ownedBytes
    const holder = holders.get(generation.root.key) ?? {
      bytes: rootBytes.get(generation.root.key) ?? 0,
      generations: 0,
      seen: new Set<string>(),
    }
    holders.set(generation.root.key, holder)
    holder.bytes += generation.ownedBytes
    if (generation.kind === 'generation') holder.generations += 1
    forEachLinked({
      linked: generation.linked,
      visit: (key, size) => {
        distinct.set(key, size)
        referenced.add(key)
        if (holder.seen.has(key) === false) {
          holder.seen.add(key)
          holder.bytes += size
        }
      },
    })
  }
  for (const size of distinct.values()) usedBytes += size
  let unreferencedCasBytes = 0
  for (const [key, size] of cas.inodes)
    if (referenced.has(key) === false) unreferencedCasBytes += size
  const topHolders = Array.from(holders, ([editorRoot, holder]) => ({
    editorRoot,
    bytes: holder.bytes,
    generations: holder.generations,
  }))
    .toSorted((left, right) => right.bytes - left.bytes)
    .slice(0, topHolderCount)
  return {
    epoch: state.epoch,
    roots,
    generations,
    cas: cas.inodes,
    usedBytes,
    unreferencedCasBytes,
    topHolders,
    cache,
    unknown,
  }
}

// ---------------------------------------------------------------------------
// LRU eviction plan
// ---------------------------------------------------------------------------

type Plan = {
  /** Evictable generations in eviction order (old before current, least recently used first). */
  readonly order: readonly GenerationView[]
  /** Bytes freed by evicting the corresponding prefix (inode-aware). */
  readonly cumulative: readonly number[]
  readonly protectedBytes: number
}

const planEviction = ({
  census,
  blocked,
  live,
  recencyMs,
  now,
}: {
  readonly census: Census
  readonly blocked: ReadonlySet<string>
  /** Generations with positive kernel references (path or shared inode). */
  readonly live: ReadonlySet<string>
  readonly recencyMs: number
  readonly now: number
}): Plan => {
  const eligible = census.generations.filter((generation) => {
    const current = generation.root.currents.has(generation.name)
    return (
      generation.kind === 'generation' &&
      generation.root.trusted === true &&
      generation.readOnly === true &&
      generation.identity !== undefined &&
      generation.package !== undefined &&
      blocked.has(generation.key) === false &&
      live.has(generation.key) === false &&
      generation.root.pins !== undefined &&
      generation.root.pins.has(generation.name) === false &&
      // The admitting publisher's current generation is in active use.
      (generation.root.held === false || current === false) &&
      // A root published or explicitly used within the recency window keeps every generation.
      now - generation.root.activeAtMs >= recencyMs &&
      // Warm touches refresh last use at most once per window; extend grace to cover it.
      now - generation.lastUseMs >= graceMs + touchRefreshMs
    )
  })
  const order = eligible.toSorted((left, right) => {
    const leftCurrent = left.root.currents.has(left.name) === true ? 1 : 0
    const rightCurrent = right.root.currents.has(right.name) === true ? 1 : 0
    if (leftCurrent !== rightCurrent) return leftCurrent - rightCurrent
    if (left.lastUseMs !== right.lastUseMs) return left.lastUseMs - right.lastUseMs
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  })
  const references = new Map<string, number>()
  for (const generation of census.generations)
    forEachLinked({
      linked: generation.linked,
      visit: (key) => references.set(key, (references.get(key) ?? 0) + 1),
    })
  const cumulative: number[] = []
  let freed = census.unreferencedCasBytes
  for (const generation of order) {
    freed += generation.ownedBytes
    forEachLinked({
      linked: generation.linked,
      visit: (key, size) => {
        const remaining = (references.get(key) ?? 1) - 1
        references.set(key, remaining)
        if (remaining === 0) freed += size
      },
    })
    cumulative.push(freed)
  }
  return { order, cumulative, protectedBytes: Math.max(0, census.usedBytes - freed) }
}

// ---------------------------------------------------------------------------
// Retirement (root lock held by caller; CAS flock only for the metadata transaction)
// ---------------------------------------------------------------------------

/**
 * Map positive references to generations: a path inside `.store/<name>`
 * protects that generation, any other path inside the editor root protects
 * every generation of the root, and a shared payload inode protects each
 * generation linking it.
 */
const liveGenerations = (census: Census): Set<string> => {
  const references = positiveEditorViewProcessReferences()
  const live = new Set<string>()
  const liveRoots = new Set<string>()
  const roots = census.roots.map((view) => ({ view, prefix: `${view.key}${sep}` }))
  for (const path of references.paths)
    for (const { view, prefix } of roots) {
      if (path !== view.key && path.startsWith(prefix) === false) continue
      const within = relative(join(view.key, '.store'), path)
      const name = within.split(sep)[0]
      if (
        name !== undefined &&
        name.length > 0 &&
        name !== '..' &&
        isAbsolute(within) === false &&
        generationPattern.test(name) === true
      )
        live.add(generationKey({ editorRoot: view.key, name }))
      else liveRoots.add(view.key)
    }
  for (const generation of census.generations)
    if (liveRoots.has(generation.root.key) === true) live.add(generation.key)
  if (references.inodes.size > 0)
    for (const generation of census.generations) {
      if (live.has(generation.key) === true) continue
      forEachLinked({
        linked: generation.linked,
        visit: (key) => {
          if (references.inodes.has(key) === true) live.add(generation.key)
        },
      })
    }
  return live
}

type FirstHop = { readonly path: string; readonly target: string } | 'absent' | 'protect'

/** Locate the consumer first hop a current generation owns; ambiguous ownership protects. */
const ownedFirstHop = ({
  root,
  view,
  packageName,
}: {
  readonly root: RootView
  readonly view: string
  readonly packageName: string
}): FirstHop => {
  if (
    packageName !== '.' &&
    (packageName.length === 0 ||
      isAbsolute(packageName) === true ||
      packageName.split('/').some((part) => part === '' || part === '.' || part === '..') === true)
  )
    return 'protect'
  const packageDir =
    packageName === '.' ? root.root.repoRoot : resolve(root.root.repoRoot, packageName)
  const derivedRoot =
    packageName === '.'
      ? resolve(packageDir, '.editor-view')
      : resolve(packageDir, '..', '..', '.editor-view')
  if (derivedRoot !== root.key) return 'protect'
  const path = join(packageDir, 'node_modules')
  const target = relative(packageDir, join(root.key, view, 'node_modules'))
  try {
    const status = lstatSync(path)
    if (status.isSymbolicLink() === false) return 'absent'
    const actual = readlinkSync(path)
    if (actual === target) return { path, target }
    return isWithin({ root: join(root.key, view), candidate: resolve(packageDir, actual) }) === true
      ? 'protect'
      : 'absent'
  } catch (error) {
    if (vanished(error) === true) return 'absent'
    throw error
  }
}

const makeDirectoriesWritable = (directory: string): void => {
  chmodSync(directory, (statSync(directory).mode & 0o777) | 0o700)
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (lstatSync(path).isDirectory() === true) makeDirectoriesWritable(path)
  }
}

const writeMarker = ({
  root,
  view,
  marker,
}: {
  readonly root: RootView
  readonly view: string
  readonly marker: EditorViewEvictedMarker
}): void => {
  const path = join(root.key, `.evicted-${view}.json`)
  const candidate = `${path}.tmp-${randomUUID()}`
  try {
    writeFileSync(candidate, `${JSON.stringify(marker)}\n`, { flag: 'wx' })
    renameSync(candidate, path)
  } finally {
    rmSync(candidate, { force: true })
  }
}

type Retirement = { readonly retired: readonly string[]; readonly blocked: readonly string[] }

const retireRoot = async ({
  contentStore,
  root,
  generations,
  budgetBytes,
  usedBytes,
}: {
  readonly contentStore: string
  readonly root: RootView
  readonly generations: readonly GenerationView[]
  readonly budgetBytes: number
  readonly usedBytes: number
}): Promise<Retirement> => {
  const blocked: string[] = []
  const admitted: { generation: GenerationView; view: string | undefined; firstHop: FirstHop }[] =
    []
  for (const generation of generations) {
    const view = root.currents.get(generation.name)
    if (view === undefined) {
      admitted.push({ generation, view, firstHop: 'absent' })
      continue
    }
    const firstHop =
      generation.package === undefined
        ? 'protect'
        : ownedFirstHop({ root, view, packageName: generation.package })
    if (firstHop === 'protect') blocked.push(generation.key)
    else admitted.push({ generation, view, firstHop })
  }
  if (admitted.length === 0) return { retired: [], blocked }
  const token = randomUUID()
  const garbage: string[] = []
  const retired: string[] = []
  await withEditorViewContentStoreLock({
    contentStore,
    run: async () => {
      const pinned = managedEditorViewSnapshots(root.key)
      const pointers = new Map<string, string>()
      for (const name of readdirSync(root.key)) {
        const path = join(root.key, name)
        try {
          if (lstatSync(path).isSymbolicLink() === true) pointers.set(name, readlinkSync(path))
        } catch (error) {
          if (vanished(error) === false) throw error
        }
      }
      for (const { generation, view, firstHop } of admitted) {
        // Pins are rechecked immediately before the canonical rename.
        if (
          pinned.has(generation.name) === true ||
          generationIdentity(generation.dir)?.identity !== generation.identity
        ) {
          blocked.push(generation.key)
          continue
        }
        const target = `.store/${generation.name}`
        const pointed = Array.from(pointers).filter(([, link]) => link === target)
        if (view === undefined) {
          if (pointed.length > 0) {
            blocked.push(generation.key)
            continue
          }
        } else {
          if (pointed.length !== 1 || pointed[0]?.[0] !== view) {
            blocked.push(generation.key)
            continue
          }
          if (typeof firstHop === 'object') {
            try {
              if (readlinkSync(firstHop.path) !== firstHop.target) {
                blocked.push(generation.key)
                continue
              }
            } catch (error) {
              if (vanished(error) === false) throw error
            }
          }
          writeMarker({
            root,
            view,
            marker: {
              schema: editorViewEvictedSchema,
              snapshot: target,
              reason: 'host-budget',
              budgetBytes,
              usedBytes,
            },
          })
          if (typeof firstHop === 'object') {
            try {
              unlinkSync(firstHop.path)
            } catch (error) {
              if (vanished(error) === false) throw error
            }
          }
          unlinkSync(join(root.key, view))
        }
        const destination = join(root.key, `.gc-${token}-${generation.name}`)
        const mode = statSync(generation.dir).mode & 0o777
        chmodSync(generation.dir, mode | 0o200)
        try {
          renameSync(generation.dir, destination)
        } catch (error) {
          chmodSync(generation.dir, mode)
          throw error
        }
        chmodSync(destination, mode)
        garbage.push(destination)
        retired.push(generation.key)
      }
    },
  })
  // Directory-only unlock of private retired trees; payload inodes are never chmodded.
  for (const path of garbage) {
    makeDirectoriesWritable(path)
    rmSync(path, { recursive: true })
  }
  return { retired, blocked }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const requireSnapshotName = (snapshot: string): string =>
  snapshotPattern.exec(snapshot)?.[1] ??
  fail(`snapshot must be a .store/<view>-<digest> pointer: ${snapshot}`)

/**
 * Reserve conservative incoming bytes before materialization. Unreferenced CAS
 * blobs, then old and idle current generations are retired LRU-first until the
 * reservation fits. The budget is advisory: when protected bytes cannot fit,
 * the reservation is still recorded and an over-budget signal is emitted.
 */
export const reserveEditorViewBudget = async ({
  contentStore,
  root,
  reservationBytes,
  heldEditorRoot,
  discoverRoots,
  tryLockRoot,
  budgetBytes,
  recencyMs = editorViewHostRecencyMs(),
}: {
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
  readonly reservationBytes: number
  readonly heldEditorRoot: string
  readonly discoverRoots: () => readonly EditorViewBudgetRoot[]
  readonly tryLockRoot: (root: EditorViewBudgetRoot) => EditorViewBudgetRootLock | undefined
  readonly budgetBytes: number
  /** Root recency window protecting current generations; defaults to EDITOR_VIEW_HOST_RECENCY_MS. */
  readonly recencyMs?: number
}): Promise<{ readonly token: string }> => {
  if (Number.isSafeInteger(reservationBytes) === false || reservationBytes <= 0)
    fail(`reservation must be a positive safe integer of bytes: ${reservationBytes}`)
  if (Number.isSafeInteger(budgetBytes) === false || budgetBytes <= 0)
    fail(`budget must be a positive safe integer of bytes: ${budgetBytes}`)
  if (Number.isSafeInteger(recencyMs) === false || recencyMs < 0)
    fail(`recency must be a non-negative safe integer of milliseconds: ${recencyMs}`)
  const startedAtMs = Date.now()
  const store = resolve(contentStore)
  ensureBudgetDirectory(store)
  const token = randomUUID()
  const blocked = new Set<string>()
  const evicted: string[] = []
  let collected = false
  /** One short flock transaction: reconcile the ledger, then reserve if it fits (or when forced). */
  const admit = ({
    census,
    plan,
    force,
  }: {
    readonly census: Census
    readonly plan: Plan
    readonly force: boolean
  }) =>
    withEditorViewContentStoreLock({
      contentStore: store,
      run: async () => {
        const state = readState(store)
        reclaimDeadReservations(state)
        const stale = census.epoch < state.journalFloor
        const pending = state.journal
          .filter((entry) => entry.epoch > census.epoch)
          .reduce((sum, entry) => sum + entry.estimatedBytes, 0)
        const reserved = reservedBytes(state)
        // Admission stays conservative: measured usage plus every outstanding estimate.
        const used = census.usedBytes + reserved + pending
        // Only active registrations in this ledger prove a root shares this content store.
        state.roots.set(resolve(root.editorRoot), resolve(root.repoRoot))
        for (const editorRoot of state.roots.keys())
          if (census.roots.some((view) => view.key === editorRoot) === false)
            state.roots.delete(editorRoot)
        for (const key of state.generations.keys())
          if (census.cache.has(key) === false) state.generations.delete(key)
        for (const [key, entry] of census.cache) state.generations.set(key, entry)
        for (const key of state.lastUse.keys())
          if (census.generations.some((generation) => generation.key === key) === false)
            state.lastUse.delete(key)
        // Usage records only measured census values; estimates stay in the journal.
        state.usage = {
          usedBytes: census.usedBytes,
          protectedBytes: plan.protectedBytes,
          measuredAtMs: Date.now(),
        }
        const admitted =
          force === true || (stale === false && used + reservationBytes <= budgetBytes)
        if (admitted === true) {
          state.reservations.set(token, {
            token,
            pid: process.pid,
            process: selfProcess(),
            editorRoot: resolve(heldEditorRoot),
            bytes: reservationBytes,
            budgetBytes,
            createdAtMs: Date.now(),
          })
          state.epoch += 1
        }
        updateWarning({ state, budgetBytes, topHolders: census.topHolders, startedAtMs })
        writeState({ contentStore: store, state })
        return { admitted, stale, used, reserved, pending }
      },
    })
  let last: { census: Census; plan: Plan } | undefined
  for (let round = 0; round < maxAdmissionRounds; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each round must observe the previous round's retirements.
    const census = await takeCensus({ contentStore: store, root, heldEditorRoot, discoverRoots })
    if (
      collected === false &&
      census.unreferencedCasBytes > 0 &&
      census.usedBytes + reservedBytes(readState(store)) + reservationBytes > budgetBytes
    ) {
      collected = true
      // Unreferenced CAS reclamation cannot retire a generation; observe readers
      // only if pressure remains after this cheapest, first-priority collection.
      // eslint-disable-next-line no-await-in-loop -- Recount after unlinking CAS-only entries.
      await collectEditorViewContentStore({ contentStore: store })
      continue
    }
    let plan = planEviction({
      census,
      blocked,
      live: new Set(),
      recencyMs,
      now: Date.now(),
    })
    // Recent/grace/pinned roots already have complete protection. A host process
    // walk cannot change their eligibility and must not tax ordinary publication.
    const observesReaders =
      plan.order.length > 0 &&
      census.usedBytes + reservedBytes(readState(store)) + reservationBytes >= budgetBytes * warningRatio
    if (observesReaders === true)
      plan = planEviction({
        census,
        blocked,
        live: liveGenerations(census),
        recencyMs,
        now: Date.now(),
      })
    last = { census, plan }
    // eslint-disable-next-line no-await-in-loop -- Admission is a single short flock transaction per round.
    const admission = await admit({ census, plan, force: false })
    if (admission.admitted === true) {
      if (evicted.length > 0)
        signal({
          event: {
            event: 'editor-view.host-budget.evicted',
            budgetBytes,
            usedBytes: census.usedBytes,
            protectedBytes: plan.protectedBytes,
            reservedBytes: admission.reserved,
            pendingEstimateBytes: admission.pending,
            reservationBytes,
            topHolders: census.topHolders,
            evicted,
            ...(census.unknown.length > 0 ? { unaccounted: census.unknown } : {}),
            message: `retired ${evicted.length} editor-view generation(s) to admit ${reservationBytes} bytes within the ${budgetBytes}-byte host budget`,
          },
          startedAtMs,
          exitCode: 0,
        })
      return { token }
    }
    if (admission.stale === true) continue
    // A concurrent reservation can consume headroom after the outside-lock census.
    // Observe readers before any pressure-driven retirement in that case too.
    if (observesReaders === false && plan.order.length > 0) {
      plan = planEviction({
        census,
        blocked,
        live: liveGenerations(census),
        recencyMs,
        now: Date.now(),
      })
      last = { census, plan }
    }
    if (collected === false && census.unreferencedCasBytes > 0) {
      collected = true
      // eslint-disable-next-line no-await-in-loop -- Collection takes the CAS flock itself; no locks are held here.
      await collectEditorViewContentStore({ contentStore: store })
      continue
    }
    // Evict the LRU prefix that reaches the budget, or every eligible generation when none does.
    const needed = admission.used + reservationBytes - budgetBytes
    const prefix = plan.cumulative.findIndex((freed) => freed >= needed)
    const selected = plan.order.slice(0, prefix === -1 ? plan.order.length : prefix + 1)
    if (selected.length === 0) break
    const byRoot = new Map<string, GenerationView[]>()
    for (const generation of selected)
      byRoot.set(generation.root.key, [...(byRoot.get(generation.root.key) ?? []), generation])
    const retiredBefore = evicted.length
    for (const generations of byRoot.values()) {
      const rootView = generations[0]?.root
      if (rootView === undefined) continue
      // The admitting publisher already holds its own root; other roots never wait.
      const lock = rootView.held === true ? undefined : tryLockRoot(rootView.root)
      if (rootView.held === false && lock === undefined) {
        for (const generation of census.generations)
          if (generation.root.key === rootView.key) blocked.add(generation.key)
        continue
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Root locks are held one root at a time.
        const outcome = await retireRoot({
          contentStore: store,
          root: rootView,
          generations,
          budgetBytes,
          usedBytes: census.usedBytes,
        })
        for (const key of outcome.blocked) blocked.add(key)
        evicted.push(...outcome.retired)
      } finally {
        lock?.release()
      }
    }
    if (evicted.length > retiredBefore) {
      // eslint-disable-next-line no-await-in-loop -- Retired payload links free CAS blobs only after collection.
      await collectEditorViewContentStore({ contentStore: store })
      collected = true
    }
  }
  // Advisory budget: protected bytes do not fit, so record the overrun and publish anyway.
  const census =
    last?.census ?? (await takeCensus({ contentStore: store, root, heldEditorRoot, discoverRoots }))
  const plan =
    last?.plan ??
    planEviction({ census, blocked, live: liveGenerations(census), recencyMs, now: Date.now() })
  const admission = await admit({ census, plan, force: true })
  signal({
    event: {
      event: 'editor-view.host-budget.over-budget',
      budgetBytes,
      usedBytes: census.usedBytes,
      protectedBytes: plan.protectedBytes,
      reservedBytes: admission.reserved,
      pendingEstimateBytes: admission.pending,
      reservationBytes,
      topHolders: census.topHolders,
      evicted,
      ...(census.unknown.length > 0 ? { unaccounted: census.unknown } : {}),
      message: `editor views exceed the host budget: ${census.usedBytes} of ${budgetBytes} bytes measured (${plan.protectedBytes} protected: pinned, open by a process, within ${graceMs / 60_000}min grace, root used within ${recencyMs}ms, or lock contended) plus ${admission.reserved} reserved and ${admission.pending} estimated since the census, before admitting ${reservationBytes}${census.unknown.length > 0 ? `; ${census.unknown.length} unreadable path(s) uncounted` : ''}; evicted ${evicted.length} generation(s); top holders: ${formatHolders(census.topHolders)}. Publishing anyway; release idle worktrees or pins, or raise EDITOR_VIEW_HOST_BUDGET_BYTES.`,
    },
    startedAtMs,
    exitCode: 0,
  })
  return { token }
}

/**
 * Reconcile a reservation to the committed generation's footprint after the
 * pointer commit. The budget is advisory; this never fails over budget.
 */
export const finishEditorViewBudgetReservation = async ({
  contentStore,
  root,
  token,
  snapshot,
}: {
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
  readonly token: string
  /** Current-pointer target relative to editorRoot: `.store/<view>-<digest>`, not the bare name. */
  readonly snapshot: string
}): Promise<void> => {
  const startedAtMs = Date.now()
  const store = resolve(contentStore)
  const name = requireSnapshotName(snapshot)
  const editorRoot = resolve(root.editorRoot)
  const key = generationKey({ editorRoot, name })
  const dir = join(editorRoot, '.store', name)
  const stamp = generationIdentity(dir)
  let cached: CachedGeneration | undefined
  let actualBytes: number | undefined
  let partialBytes = 0
  try {
    const unreadable: string[] = []
    const footprint = await walkTree({ root: dir, unknown: unreadable })
    if (footprint !== undefined) {
      partialBytes = footprint.ownedBytes + footprint.linkedBytes
      if (unreadable.length === 0) actualBytes = partialBytes
      if (stamp !== undefined && footprint.readOnly === true) {
        const sidecar = sidecarName({ key, identity: stamp.identity })
        await writeSidecar({ contentStore: store, name: sidecar, linked: footprint.linked })
        const recordedPackage = await recordPackage({ dir, name })
        cached = {
          editorRoot,
          name,
          identity: stamp.identity,
          ownedBytes: footprint.ownedBytes,
          linkedBytes: footprint.linkedBytes,
          sidecar,
          readOnly: true,
          ...(recordedPackage === undefined ? {} : { package: recordedPackage }),
        }
      }
    }
  } catch {
    // The committed generation stays accounted at its reserved size until the next census.
  }
  const outcome = await withEditorViewContentStoreLock({
    contentStore: store,
    run: async () => {
      const state = readState(store)
      const reservation = state.reservations.get(token)
      // Only the reserving incarnation may settle its reservation, and only for its own root.
      if (
        reservation !== undefined &&
        (reservation.pid !== process.pid ||
          reservation.process !== selfProcess() ||
          reservation.editorRoot !== editorRoot)
      )
        fail(
          `reservation ${token} belongs to process ${reservation.pid} for ${reservation.editorRoot}, not ${editorRoot}`,
        )
      state.reservations.delete(token)
      // Conservative estimate: an incomplete walk never shrinks the admitted reservation.
      const estimatedBytes = actualBytes ?? Math.max(partialBytes, reservation?.bytes ?? 0)
      appendJournal({ state, estimatedBytes })
      if (cached !== undefined) state.generations.set(key, cached)
      state.lastUse.set(key, Date.now())
      state.roots.set(editorRoot, resolve(root.repoRoot))
      writeState({ contentStore: store, state })
      return { reservation, estimatedBytes, usage: state.usage, reserved: reservedBytes(state) }
    },
  })
  // Full footprint counts shared payload inodes, so this is an upper bound on new bytes.
  if (outcome.reservation !== undefined && outcome.estimatedBytes > outcome.reservation.bytes)
    signal({
      event: {
        event: 'editor-view.host-budget.underreserved',
        budgetBytes: outcome.reservation.budgetBytes,
        usedBytes: outcome.usage?.usedBytes ?? 0,
        protectedBytes: outcome.usage?.protectedBytes ?? 0,
        reservedBytes: outcome.reserved,
        pendingEstimateBytes: outcome.estimatedBytes,
        reservationBytes: outcome.reservation.bytes,
        topHolders: [],
        message: `generation ${snapshot} footprint is up to ${outcome.estimatedBytes} bytes (shared payload inodes included) but reserved only ${outcome.reservation.bytes}; the publisher's reservation formula may undercount`,
      },
      startedAtMs,
      exitCode: 0,
    })
}

/** Release this process's reservation after its candidate was removed. */
export const cancelEditorViewBudgetReservation = async ({
  contentStore,
  token,
}: {
  readonly contentStore: string
  readonly token: string
}): Promise<void> => {
  const store = resolve(contentStore)
  await withEditorViewContentStoreLock({
    contentStore: store,
    run: async () => {
      const state = readState(store)
      const reservation = state.reservations.get(token)
      if (reservation === undefined) return
      if (reservation.pid !== process.pid || reservation.process !== selfProcess())
        fail(`reservation ${token} belongs to process ${reservation.pid}`)
      state.reservations.delete(token)
      state.epoch += 1
      writeState({ contentStore: store, state })
    },
  })
}

/**
 * Warm path: record last use and evaluate the warning threshold from cached
 * usage only. No payload walk, hash, link, census or root discovery; the CAS
 * flock is taken only when last use is stale, the root is unregistered, or the
 * warning state flips.
 */
export const touchEditorViewBudgetGeneration = async ({
  contentStore,
  root,
  snapshot,
  budgetBytes,
}: {
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
  /** Current-pointer target relative to editorRoot: `.store/<view>-<digest>`, not the bare name. */
  readonly snapshot: string
  /** Accepted for API symmetry; warm touches never discover roots (admission does). */
  readonly discoverRoots: () => readonly EditorViewBudgetRoot[]
  readonly budgetBytes: number
}): Promise<void> => {
  const startedAtMs = Date.now()
  const store = resolve(contentStore)
  const editorRoot = resolve(root.editorRoot)
  const key = generationKey({ editorRoot, name: requireSnapshotName(snapshot) })
  const repoRoot = resolve(root.repoRoot)
  const fresh = (state: BudgetState): boolean => {
    const crossing =
      state.usage !== undefined &&
      state.usage.protectedBytes + reservedBytes(state) >= budgetBytes * warningRatio
    return (
      startedAtMs - (state.lastUse.get(key) ?? 0) < touchRefreshMs &&
      state.roots.get(editorRoot) === repoRoot &&
      crossing === state.warned
    )
  }
  if (fresh(readState(store)) === true) return
  await withEditorViewContentStoreLock({
    contentStore: store,
    run: async () => {
      const state = readState(store)
      if (fresh(state) === true) return
      state.lastUse.set(key, Date.now())
      // Registration in this ledger is the proof that the root shares this content store.
      state.roots.set(editorRoot, repoRoot)
      updateWarning({ state, budgetBytes, topHolders: [], startedAtMs })
      writeState({ contentStore: store, state })
    },
  })
}
