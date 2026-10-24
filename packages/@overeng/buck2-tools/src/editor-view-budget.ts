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
import { lstat, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

import { probeEditorViewLeaseUnderFence } from './editor-view-leases.ts'
import {
  editorViewAutomaticEvictionEvidence,
  managedEditorViewSnapshots,
  classifyEditorViewProcessCandidates,
  observeEditorViewProcessCandidates,
  referencedEditorViewPaths,
  type EditorViewProcessCandidate,
} from './editor-view-readers.ts'
import {
  collectEditorViewContentStore,
  defaultEditorViewContentStore,
  editorViewStagingCreatorIdentity,
  withEditorViewContentStoreLock,
} from './editor-view-sharing.ts'
import { emitCompletedSpanAsync, type OtelSpanAttribute } from './otel-span-cli.ts'

/**
 * Host-wide byte budget for editor-view generations and their shared CAS.
 *
 * Accounting covers all registered content stores and editor roots: private
 * generations, copy fallbacks, retired leftovers and CAS bytes are deduplicated
 * by inode across the host, charging the larger of logical size and allocated
 * blocks. Immutable sidecars share the private host ledger directory, so warm
 * touches never walk payloads.
 *
 * Lock order is root publication lock, host ledger flock, then victim CAS flock.
 * Other root locks are always nonblocking. Payload walks, footprint I/O and
 * recursive cleanup run outside both flocks. Final reader observation runs
 * inside retirement exclusion. The host flock uses a separate empty CAS namespace.
 */

/** One editor state root and the repository (worktree) that encloses it. */
export type EditorViewBudgetRoot = { readonly repoRoot: string; readonly editorRoot: string }
/** A held root publication lock acquired by `tryLockRoot`. */
export type EditorViewBudgetRootLock = { readonly release: () => void }

/** Proven provenance of the publication exclusion authorizing startup cleanup. */
export type EditorViewPublicationLockProof = {
  readonly path: string
  readonly token: string
  readonly acquisition: 'normal' | 'recovered-dead-owner'
}

const holdsPublicationLock = ({
  editorRoot,
  proof,
}: {
  readonly editorRoot: string
  readonly proof: EditorViewPublicationLockProof
}): boolean => {
  if (
    (proof.acquisition !== 'normal' && proof.acquisition !== 'recovered-dead-owner') ||
    resolve(proof.path) !== join(resolve(editorRoot), '.publish.lock')
  )
    return false
  try {
    const owner: unknown = JSON.parse(readFileSync(join(proof.path, 'owner.json'), 'utf8'))
    const incarnation = editorViewStagingCreatorIdentity({ pid: process.pid })
    return (
      isObject(owner) === true &&
      owner.schema === 'effect-utils/editor-view-lock/v1' &&
      owner.token === proof.token &&
      owner.pid === process.pid &&
      owner.host === hostname() &&
      incarnation !== 'unknown' &&
      incarnation !== 'dead' &&
      owner.process === incarnation
    )
  } catch {
    return false
  }
}

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

/** Admission cannot safely reclaim enough space; publication has not been authorized. */
export class EditorViewCapacityError extends Error {
  readonly code = 'EDITOR_VIEW_CAPACITY'

  readonly budgetBytes: number
  readonly usedBytes: number
  readonly reservationBytes: number
  readonly blockedGenerations: number
  readonly reasons: readonly string[]

  constructor({
    budgetBytes,
    usedBytes,
    reservationBytes,
    blockedGenerations,
    reasons,
  }: {
    readonly budgetBytes: number
    readonly usedBytes: number
    readonly reservationBytes: number
    readonly blockedGenerations: number
    readonly reasons: readonly string[]
  }) {
    super(
      `editor view host budget: capacity exhausted (${usedBytes} used + ${reservationBytes} requested; ` +
        `${budgetBytes} budget; ${blockedGenerations} protected generations). ` +
        `${reasons.slice(0, 8).join('; ')}. Nothing further can be safely deleted. ` +
        'Close unmanaged editor sessions and explicitly release idle worktrees or pins, or raise EDITOR_VIEW_HOST_BUDGET_BYTES.',
    )
    this.name = 'EditorViewCapacityError'
    this.budgetBytes = budgetBytes
    this.usedBytes = usedBytes
    this.reservationBytes = reservationBytes
    this.blockedGenerations = blockedGenerations
    this.reasons = reasons
  }
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
const budgetTelemetryIntervalMs = 60_000
const stateSchema = 'effect-utils/editor-view-host-budget/v1'
const generationPattern = /^([A-Za-z0-9][A-Za-z0-9_-]*)-([0-9a-f]{64})$/
const snapshotPattern = /^\.store\/([A-Za-z0-9][A-Za-z0-9_-]*-[0-9a-f]{64})$/
/** Linked-inode sidecar record: dev, ino, accounted bytes as little-endian u64. */
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
// Persistent host registry and ledger (mutated only under the coordination flock)
// ---------------------------------------------------------------------------

type Reservation = {
  readonly token: string
  readonly pid: number
  /** Process incarnation (boot id + start time); reclaim never trusts the PID alone. */
  readonly process: string
  readonly editorRoot: string
  readonly contentStore: string
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

type RegisteredRoot = { readonly repoRoot: string; readonly contentStore: string }

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
  contentStores: Set<string>
  roots: Map<string, RegisteredRoot>
  generations: Map<string, CachedGeneration>
  lastUse: Map<string, number>
  reservations: Map<string, Reservation>
  /** Unmerged per-store writers settle these tokens in their source ledger. */
  legacyReservations: Set<string>
  usage: Usage | undefined
  warned: boolean
  /** Host-wide delivery permits and suppression counts, keyed by store and event. */
  telemetry: Map<string, { readonly emittedAtMs: number; readonly suppressed: number }>
}

const emptyState = (): BudgetState => ({
  epoch: 0,
  journalFloor: 0,
  journal: [],
  contentStores: new Set(),
  roots: new Map(),
  generations: new Map(),
  lastUse: new Map(),
  reservations: new Map(),
  legacyReservations: new Set(),
  usage: undefined,
  warned: false,
  telemetry: new Map(),
})

/** One private host-wide registry; CAS namespaces remain per Git common directory. */
export const editorViewHostBudgetStateDirectory = (): string => {
  const override = process.env.EDITOR_VIEW_HOST_BUDGET_STATE
  if (override !== undefined) {
    if (override.trim().length === 0) fail('EDITOR_VIEW_HOST_BUDGET_STATE must be nonempty')
    return resolve(override)
  }
  return resolve(
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'effect-utils',
    'editor-view-budget',
    'v1',
  )
}

const statePath = (): string => join(editorViewHostBudgetStateDirectory(), 'state-v1.json')
const footprintDirectory = (): string => join(editorViewHostBudgetStateDirectory(), 'footprints')

const ensureBudgetDirectory = (): void => {
  for (const path of [editorViewHostBudgetStateDirectory(), footprintDirectory()]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    const status = lstatSync(path)
    if (
      status.isDirectory() === false ||
      status.uid !== userId() ||
      (status.mode & 0o077) !== 0 ||
      realpathSync(path) !== path
    )
      fail(`budget metadata must be a private real directory owned by the current user: ${path}`)
  }
}

/** Serialize host metadata and abandoned root-lock recovery across independent CAS namespaces. */
export const withHostBudgetLock = async <T>(run: () => Promise<T>): Promise<T> => {
  ensureBudgetDirectory()
  return withEditorViewContentStoreLock({
    contentStore: join(editorViewHostBudgetStateDirectory(), 'coordination'),
    run,
  })
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
  if (Array.isArray(value.contentStores) === false) return invalid()
  for (const store of value.contentStores) {
    if (isText(store) === false || isAbsolute(store) === false) return invalid()
    state.contentStores.add(store)
  }
  if (Array.isArray(value.legacyReservations) === false) return invalid()
  for (const token of value.legacyReservations) {
    if (isText(token) === false) return invalid()
    state.legacyReservations.add(token)
  }
  for (const [editorRoot, entry] of records(value.roots)) {
    if (
      isAbsolute(editorRoot) === false ||
      isObject(entry) === false ||
      isText(entry.repoRoot) === false ||
      isAbsolute(entry.repoRoot) === false ||
      isText(entry.contentStore) === false ||
      state.contentStores.has(entry.contentStore) === false
    )
      return invalid()
    state.roots.set(editorRoot, { repoRoot: entry.repoRoot, contentStore: entry.contentStore })
  }
  for (const [key, entry] of records(value.generations)) {
    if (
      isObject(entry) === false ||
      isText(entry.editorRoot) === false ||
      isAbsolute(entry.editorRoot) === false ||
      typeof entry.name !== 'string' ||
      (generationPattern.test(entry.name) === false &&
        /^\.legacy\/[^/]+$/.test(entry.name) === false) ||
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
      isAbsolute(entry.editorRoot) === false ||
      isText(entry.contentStore) === false ||
      state.contentStores.has(entry.contentStore) === false ||
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
      contentStore: entry.contentStore,
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
  // Older ledgers have no delivery state; all authoritative budget state is retained.
  if (value.telemetry !== undefined)
    for (const [key, entry] of records(value.telemetry)) {
      const separator = key.lastIndexOf('\0')
      if (
        separator === -1 ||
        state.contentStores.has(key.slice(0, separator)) === false ||
        /^editor-view\.host-budget\.(warning|over-budget|evicted|underreserved)$/.test(
          key.slice(separator + 1),
        ) === false ||
        isObject(entry) === false ||
        isCount(entry.emittedAtMs) === false ||
        isCount(entry.suppressed) === false
      )
        return invalid()
      state.telemetry.set(key, {
        emittedAtMs: entry.emittedAtMs,
        suppressed: entry.suppressed,
      })
    }
  return state
}

/**
 * Atomic snapshot read; mutation callers hold the host coordination flock. The ledger must
 * be a private regular file owned by this user, opened without following links.
 */
const readLedgerValue = (path: string): unknown => {
  let text: string
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (vanished(error) === true) return undefined
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
  return value
}

const readState = (): BudgetState => {
  const path = statePath()
  const value = readLedgerValue(path)
  return value === undefined ? emptyState() : decodeState({ value, path })
}

const writeState = (state: BudgetState): void => {
  ensureBudgetDirectory()
  const value: { readonly [key: string]: Json } = {
    schema: stateSchema,
    epoch: state.epoch,
    journalFloor: state.journalFloor,
    journal: state.journal.map((entry) => ({
      epoch: entry.epoch,
      estimatedBytes: entry.estimatedBytes,
    })),
    contentStores: Array.from(state.contentStores),
    legacyReservations: Array.from(state.legacyReservations),
    roots: Object.fromEntries(
      Array.from(state.roots, ([key, entry]) => [
        key,
        { repoRoot: entry.repoRoot, contentStore: entry.contentStore },
      ]),
    ),
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
          contentStore: entry.contentStore,
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
    telemetry: Object.fromEntries(
      Array.from(state.telemetry, ([key, entry]) => [
        key,
        { emittedAtMs: entry.emittedAtMs, suppressed: entry.suppressed },
      ]),
    ),
  }
  const path = statePath()
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

const processGone = ({
  owner: { pid, process: incarnation },
  owners,
}: {
  readonly owner: { readonly pid: number; readonly process: string }
  readonly owners: ReadonlyMap<number, string>
}): boolean => {
  if (pid === process.pid && incarnation === selfIncarnation) return false
  const observed = owners.get(pid) ?? 'unknown'
  return (
    observed === 'dead' ||
    (observed !== 'unknown' && incarnation !== 'unknown' && observed !== incarnation)
  )
}

/** Process observation is always outside both flocks; unseen owners remain protected. */
const budgetProcessOwners = ({
  includeReservations = true,
}: { readonly includeReservations?: boolean } = {}): ReadonlyMap<number, string> => {
  selfProcess()
  const pids = new Set(
    includeReservations === true
      ? Array.from(readState().reservations.values(), (entry) => entry.pid)
      : [],
  )
  for (const name of readdirSync(footprintDirectory())) {
    const pid = /^\.([0-9a-f]{64}\.bin)\.tmp-([0-9]+)-/.exec(name)?.[2]
    if (pid !== undefined) pids.add(Number(pid))
  }
  return new Map(
    Array.from(pids, (pid) => [
      pid,
      pid === process.pid ? selfProcess() : editorViewStagingCreatorIdentity({ pid }),
    ]),
  )
}

/** Import the unmerged per-store ledger once; payloads remain the source of footprint truth. */
const registerRoot = async ({
  state,
  contentStore,
  root,
}: {
  readonly state: BudgetState
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
}): Promise<void> => {
  if (state.contentStores.has(contentStore) === false) {
    await withEditorViewContentStoreLock({
      contentStore,
      run: async () => {
        const directory = `${contentStore}.budget`
        try {
          const status = lstatSync(directory)
          if (
            status.isDirectory() === false ||
            status.uid !== userId() ||
            (status.mode & 0o077) !== 0 ||
            realpathSync(directory) !== directory
          )
            fail(`legacy budget metadata must be a private real owned directory: ${directory}`)
        } catch (error) {
          if (vanished(error) === false) throw error
        }
        const legacy = readLedgerValue(join(directory, 'state-v2.json'))
        if (legacy !== undefined) {
          if (
            isObject(legacy) === false ||
            legacy.schema !== 'effect-utils/editor-view-budget/v2' ||
            isObject(legacy.roots) === false ||
            isObject(legacy.lastUse) === false ||
            isObject(legacy.reservations) === false
          )
            fail(`unrecognized legacy budget ledger: ${directory}`)
          for (const [editorRoot, repoRoot] of Object.entries(legacy.roots)) {
            if (
              isAbsolute(editorRoot) === false ||
              isText(repoRoot) === false ||
              isAbsolute(repoRoot) === false
            )
              fail(`invalid legacy budget root: ${directory}`)
            state.roots.set(editorRoot, { repoRoot, contentStore })
          }
          for (const [key, at] of Object.entries(legacy.lastUse)) {
            if (isCount(at) === false) fail(`invalid legacy last use: ${directory}`)
            state.lastUse.set(key, Math.max(at, state.lastUse.get(key) ?? 0))
          }
          for (const [token, entry] of Object.entries(legacy.reservations)) {
            if (
              isObject(entry) === false ||
              entry.token !== token ||
              isCount(entry.pid) === false ||
              isText(entry.process) === false ||
              isText(entry.editorRoot) === false ||
              isAbsolute(entry.editorRoot) === false ||
              isCount(entry.bytes) === false ||
              isCount(entry.budgetBytes) === false ||
              isCount(entry.createdAtMs) === false
            )
              fail(`invalid legacy reservation: ${directory}`)
            state.legacyReservations.add(token)
            state.reservations.set(token, {
              token,
              pid: entry.pid,
              process: entry.process,
              editorRoot: entry.editorRoot,
              contentStore,
              bytes: entry.bytes,
              budgetBytes: entry.budgetBytes,
              createdAtMs: entry.createdAtMs,
            })
          }
        }
      },
    })
    state.contentStores.add(contentStore)
    state.epoch += 1
  }
  const editorRoot = resolve(root.editorRoot)
  const repoRoot = resolve(root.repoRoot)
  const previous = state.roots.get(editorRoot)
  if (
    previous === undefined ||
    previous.repoRoot !== repoRoot ||
    previous.contentStore !== contentStore
  ) {
    state.roots.set(editorRoot, { repoRoot, contentStore })
    state.epoch += 1
  }
}

/**
 * Drain the unmerged source ledger. Removal of an adopted token proves its
 * payload has settled even if the old writer is a long-lived process.
 */
const synchronizeLegacyStore = async (contentStore: string): Promise<void> => {
  const directory = `${contentStore}.budget`
  const retired = `${directory}.retired`
  const source = await lstatIfPresent(directory)
  const garbage = await lstatIfPresent(retired)
  const snapshot = readState()
  if (
    source === undefined &&
    garbage === undefined &&
    Array.from(snapshot.legacyReservations).some(
      (token) => snapshot.reservations.get(token)?.contentStore === contentStore,
    ) === false
  )
    return
  const owners = budgetProcessOwners()
  const removeRetired = await withHostBudgetLock(async () => {
    return withEditorViewContentStoreLock({
      contentStore,
      run: async () => {
        for (const path of [directory, retired]) {
          try {
            const status = lstatSync(path)
            if (
              status.isDirectory() === false ||
              status.uid !== userId() ||
              (status.mode & 0o077) !== 0 ||
              realpathSync(path) !== path
            )
              fail(`legacy budget metadata must be a private real owned directory: ${path}`)
          } catch (error) {
            if (vanished(error) === false) throw error
          }
        }
        const state = readState()
        const value = readLedgerValue(join(directory, 'state-v2.json'))
        if (
          value !== undefined &&
          (isObject(value) === false ||
            value.schema !== 'effect-utils/editor-view-budget/v2' ||
            isObject(value.reservations) === false ||
            isObject(value.lastUse) === false)
        )
          fail(`unrecognized legacy budget ledger: ${directory}`)
        const reservations =
          isObject(value) === true && isObject(value.reservations) === true
            ? value.reservations
            : {}
        for (const token of state.legacyReservations) {
          if (state.reservations.get(token)?.contentStore !== contentStore) continue
          if (Object.hasOwn(reservations, token) === false) {
            state.reservations.delete(token)
            state.legacyReservations.delete(token)
            state.epoch += 1
          }
        }
        if (isObject(value) === true && isObject(value.lastUse) === true)
          for (const [key, at] of Object.entries(value.lastUse))
            if (isCount(at) === true)
              state.lastUse.set(key, Math.max(at, state.lastUse.get(key) ?? 0))
        const liveWriter = Object.values(reservations).some(
          (entry) =>
            isObject(entry) === false ||
            isCount(entry.pid) === false ||
            isText(entry.process) === false ||
            processGone({ owner: { pid: entry.pid, process: entry.process }, owners }) === false,
        )
        reclaimDeadReservations({ state, owners })
        writeState(state)
        let remove = false
        if (liveWriter === false) {
          try {
            if (lstatSync(retired).isDirectory() === true) remove = true
          } catch (error) {
            if (vanished(error) === false) throw error
          }
          if (remove === false) {
            try {
              renameSync(directory, retired)
              remove = true
            } catch (error) {
              if (vanished(error) === false) throw error
            }
          }
        } else if (garbage !== undefined) remove = true
        return remove
      },
    })
  })
  if (removeRetired === true) rmSync(retired, { recursive: true, force: true })
}

const discardSidecarStages = (staged: ReadonlyMap<string, string>): void => {
  for (const path of staged.values()) {
    try {
      unlinkSync(path)
    } catch (error) {
      if (vanished(error) === false) throw error
    }
  }
}

/** Scope unpublished sidecars locally; the host flock only installs complete files. */
const withBudgetFootprints = async <T>({
  contentStore,
  root,
  run,
  maintenanceRoot,
}: {
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
  readonly run: (staged: Map<string, string>) => Promise<T>
  readonly maintenanceRoot?: string
}): Promise<T> => {
  const staged = new Map<string, string>()
  ensureBudgetDirectory()
  const owners = budgetProcessOwners({ includeReservations: false })
  const obsolete = obsoleteGenerationFootprints(maintenanceRoot)
  await withHostBudgetLock(async () => {
    const state = readState()
    await registerRoot({ state, contentStore, root })
    collectObsoleteSidecars({ state, owners, obsolete, scopedEditorRoot: maintenanceRoot })
    writeState(state)
  })
  try {
    await synchronizeLegacyStore(contentStore)
    return await run(staged)
  } finally {
    discardSidecarStages(staged)
    const finalOwners = budgetProcessOwners({ includeReservations: false })
    const finalObsolete = obsoleteGenerationFootprints(maintenanceRoot)
    await withHostBudgetLock(async () => {
      const state = readState()
      collectObsoleteSidecars({
        state,
        owners: finalOwners,
        obsolete: finalObsolete,
        scopedEditorRoot: maintenanceRoot,
      })
      writeState(state)
    })
  }
}

/** Drop only reservations whose recorded incarnation is recognizably gone. */
const reclaimDeadReservations = ({
  state,
  owners,
}: {
  readonly state: BudgetState
  readonly owners: ReadonlyMap<number, string>
}): number => {
  let reclaimed = 0
  for (const [token, reservation] of state.reservations) {
    if (processGone({ owner: reservation, owners }) === true) {
      state.reservations.delete(token)
      state.legacyReservations.delete(token)
      reclaimed += 1
    }
  }
  if (reclaimed > 0) state.epoch += 1
  return reclaimed
}

/** Requires the host fence; uncertainty about an owner always preserves its reservation. */
export const hasEditorViewBudgetReservation = ({
  editorRoot,
}: {
  readonly editorRoot: string
}): boolean =>
  Array.from(readState().reservations.values()).some(
    (entry) => entry.editorRoot === resolve(editorRoot),
  )

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

/** Called only inside the existing host-ledger transaction; logs never wait for delivery. */
const signal = ({
  state,
  contentStore,
  event,
  startedAtMs,
  exitCode,
}: {
  readonly state: BudgetState
  readonly contentStore: string
  readonly event: BudgetEvent
  readonly startedAtMs: number
  readonly exitCode: number
}): void => {
  const now = Date.now()
  const key = `${contentStore}\0${event.event}`
  const previous = state.telemetry.get(key)
  const suppressed = previous?.suppressed ?? 0
  const eligible = previous === undefined || now - previous.emittedAtMs >= budgetTelemetryIntervalMs
  let accepted = false
  if (eligible === true) {
    const attributes: OtelSpanAttribute[] = [
      ['editor_view.host_budget.event', event.event],
      ['editor_view.host_budget.content_store', contentStore],
      ['editor_view.host_budget.budget_bytes', event.budgetBytes],
      ['editor_view.host_budget.used_bytes', event.usedBytes],
      ['editor_view.host_budget.protected_bytes', event.protectedBytes],
      ['editor_view.host_budget.reserved_bytes', event.reservedBytes],
      ['editor_view.host_budget.pending_estimate_bytes', event.pendingEstimateBytes],
      ['editor_view.host_budget.reservation_bytes', event.reservationBytes],
      ['editor_view.host_budget.top_holders', JSON.stringify(event.topHolders)],
      ['editor_view.host_budget.suppressed_events', suppressed],
    ]
    if (event.evicted !== undefined)
      attributes.push(['editor_view.host_budget.evicted', event.evicted.join(',')])
    if (event.unaccounted !== undefined)
      attributes.push(['editor_view.host_budget.unaccounted_paths', event.unaccounted.length])
    accepted = emitCompletedSpanAsync({
      name: 'editor-view.host-budget',
      label: event.event.slice('editor-view.host-budget.'.length),
      attributes,
      startedAtMs,
      endedAtMs: now,
      exitCode,
    })
  }
  const nextSuppressed = accepted === true ? 0 : Math.min(Number.MAX_SAFE_INTEGER, suppressed + 1)
  state.telemetry.set(key, {
    emittedAtMs: accepted === true ? now : (previous?.emittedAtMs ?? 0),
    suppressed: nextSuppressed,
  })
  process.stderr.write(
    `${JSON.stringify({
      ...event,
      contentStore,
      otelSuppressedEvents: accepted === true ? suppressed : nextSuppressed,
    })}\n`,
  )
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
  contentStore,
  budgetBytes,
  topHolders,
  startedAtMs,
}: {
  readonly state: BudgetState
  readonly contentStore: string
  readonly budgetBytes: number
  readonly topHolders: readonly Holder[]
  readonly startedAtMs: number
}): void => {
  if (state.usage === undefined) return
  const reserved = reservedBytes(state)
  const crossing = state.usage.protectedBytes + reserved >= budgetBytes * warningRatio
  if (crossing === true && state.warned === false)
    signal({
      state,
      contentStore,
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

/** Directory st_size may be an entry count (ZFS); allocated blocks are always 512-byte units. */
const accountedBytes = (status: BigIntStats): bigint => {
  const allocated = status.blocks * 512n
  return allocated > status.size ? allocated : status.size
}

type TreeFootprint = {
  readonly ownedBytes: number
  /** dev/ino/accounted-byte triples of inodes with more than one link. */
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
  seal = false,
}: {
  readonly root: string
  readonly unknown: string[]
  readonly seal?: boolean
}): Promise<TreeFootprint | undefined> => {
  const rootStatus = await lstatIfPresent(root)
  if (rootStatus === undefined) return undefined
  if (
    seal === true &&
    rootStatus.isDirectory() === true &&
    rootStatus.uid === BigInt(userId()) &&
    (rootStatus.mode & 0o222n) !== 0n
  )
    chmodSync(root, Number(rootStatus.mode & 0o777n & ~0o222n))
  let ownedBytes = 0
  let linkedBytes = 0
  // Unreadable or writable trees are never evictable.
  let readOnly =
    rootStatus.isDirectory() === true && (seal === true || (rootStatus.mode & 0o222n) === 0n)
  const linked: bigint[] = []
  const admit = (status: BigIntStats): void => {
    const bytes = accountedBytes(status)
    if (status.isFile() === true && status.nlink > 1n) {
      linked.push(status.dev, status.ino, bytes)
      linkedBytes += Number(bytes)
    } else ownedBytes += Number(bytes)
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
        if (status.isSymbolicLink() === false && (status.mode & 0o222n) !== 0n) {
          if (
            seal === true &&
            status.uid === BigInt(userId()) &&
            (status.isDirectory() === true || (status.isFile() === true && status.nlink === 1n))
          )
            chmodSync(path, Number(status.mode & 0o777n & ~0o222n))
          else readOnly = false
        }
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

/** Legacy imports have no generation record; sealed directory identity owns their sidecar. */
const cachedTreeIdentity = ({
  editorRoot,
  name,
}: {
  readonly editorRoot: string
  readonly name: string
}) =>
  name.startsWith('.legacy/') === true
    ? orphanIdentity({ dir: join(editorRoot, name), immutable: true })
    : generationIdentity(join(editorRoot, '.store', name))

const orphanIdentity = ({
  dir,
  immutable = false,
}: {
  readonly dir: string
  readonly immutable?: boolean
}) => {
  try {
    const status = lstatSync(dir, { bigint: true })
    if (
      status.isDirectory() === false ||
      status.uid !== BigInt(userId()) ||
      (immutable === true && (status.mode & 0o222n) !== 0n)
    )
      return undefined
    return {
      identity: `${status.dev}:${status.ino}:${status.mode}:${status.mtimeNs}:${status.ctimeNs}`,
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

/** Enumerate candidate cache removals outside the flock; the commit rechecks each identity. */
const obsoleteGenerationFootprints = (
  editorRoot?: string,
): ReadonlyMap<string, CachedGeneration> => {
  const obsolete = new Map<string, CachedGeneration>()
  for (const [key, entry] of readState().generations) {
    if (editorRoot !== undefined && entry.editorRoot !== editorRoot) continue
    try {
      if (
        cachedTreeIdentity({ editorRoot: entry.editorRoot, name: entry.name })?.identity !==
          entry.identity ||
        lstatSync(join(footprintDirectory(), entry.sidecar)).isFile() === false
      )
        obsolete.set(key, entry)
    } catch (error) {
      if (vanished(error) === true) obsolete.set(key, entry)
    }
  }
  return obsolete
}

/** Metadata-only final-cache collection; complete staged files are fenced by their process owner. */
const collectObsoleteSidecars = ({
  state,
  owners,
  obsolete,
  scopedEditorRoot,
}: {
  readonly state: BudgetState
  readonly owners: ReadonlyMap<number, string>
  readonly obsolete: ReadonlyMap<string, CachedGeneration>
  readonly scopedEditorRoot?: string | undefined
}): void => {
  for (const [key, previous] of obsolete) {
    const entry = state.generations.get(key)
    if (entry === undefined || entry.identity !== previous.identity) continue
    try {
      if (
        cachedTreeIdentity({ editorRoot: entry.editorRoot, name: entry.name })?.identity !==
          entry.identity ||
        lstatSync(join(footprintDirectory(), entry.sidecar)).isFile() === false
      )
        state.generations.delete(key)
    } catch (error) {
      if (vanished(error) === true) state.generations.delete(key)
      // Unreadable generation metadata is not evidence that its cache is obsolete.
    }
  }
  for (const [editorRoot] of state.roots) {
    if (scopedEditorRoot !== undefined && editorRoot !== scopedEditorRoot) continue
    try {
      lstatSync(editorRoot)
    } catch (error) {
      if (
        vanished(error) === true &&
        Array.from(state.reservations.values()).some((entry) => entry.editorRoot === editorRoot) ===
          false
      )
        state.roots.delete(editorRoot)
    }
  }
  for (const key of state.lastUse.keys()) {
    const split = key.lastIndexOf('\0')
    if (split < 0) continue
    if (scopedEditorRoot !== undefined && key.slice(0, split) !== scopedEditorRoot) continue
    try {
      lstatSync(join(key.slice(0, split), '.store', key.slice(split + 1)))
    } catch (error) {
      if (vanished(error) === true) state.lastUse.delete(key)
    }
  }
  const retained = new Set(Array.from(state.generations.values(), (entry) => entry.sidecar))
  for (const name of readdirSync(footprintDirectory())) {
    const final = /^[0-9a-f]{64}\.bin$/.test(name)
    const staged = /^\.([0-9a-f]{64}\.bin)\.tmp-([0-9]+)-(.+)-[0-9a-f-]{36}$/.exec(name)
    const unreferenced =
      final === true
        ? retained.has(name) === false
        : staged?.[2] !== undefined &&
          staged[3] !== undefined &&
          processGone({ owner: { pid: Number(staged[2]), process: staged[3] }, owners }) === true
    if (unreferenced === false) continue
    try {
      unlinkSync(join(footprintDirectory(), name))
    } catch (error) {
      if (vanished(error) === false) throw error
    }
  }
}

/** Reclaim obsolete immutable footprint metadata after retention or root release. */
export const collectEditorViewBudgetFootprints = async ({
  editorRoot,
}: { readonly editorRoot?: string } = {}): Promise<void> => {
  ensureBudgetDirectory()
  const root = editorRoot === undefined ? undefined : resolve(editorRoot)
  const owners = budgetProcessOwners({ includeReservations: false })
  const obsolete = obsoleteGenerationFootprints(root)
  await withHostBudgetLock(async () => {
    const state = readState()
    collectObsoleteSidecars({ state, owners, obsolete, scopedEditorRoot: root })
    writeState(state)
  })
}

const writeSidecar = async ({
  staged,
  name,
  linked,
}: {
  readonly staged: Map<string, string>
  readonly name: string
  readonly linked: Buffer
}): Promise<void> => {
  if (staged.has(name) === true) return
  const path = join(
    footprintDirectory(),
    `.${name}.tmp-${process.pid}-${selfProcess()}-${randomUUID()}`,
  )
  try {
    await writeFile(path, linked, { flag: 'wx', mode: 0o600 })
    staged.set(name, path)
  } catch (error) {
    await unlink(path).catch(() => undefined)
    throw error
  }
}

/** Under the host flock, install a finished stage or require the cached final to still exist. */
const installSidecar = ({
  staged,
  entry,
}: {
  readonly staged: Map<string, string>
  readonly entry: CachedGeneration
}): boolean => {
  const path = join(footprintDirectory(), entry.sidecar)
  const candidate = staged.get(entry.sidecar)
  if (candidate !== undefined) {
    renameSync(candidate, path)
    staged.delete(entry.sidecar)
  }
  try {
    const status = lstatSync(path)
    if (status.isFile() === false || status.uid !== userId() || (status.mode & 0o077) !== 0)
      fail(`footprint sidecar must be a private regular owned file: ${path}`)
    return status.size % entryBytes === 0
  } catch (error) {
    if (vanished(error) === true) return false
    throw error
  }
}

const readSidecar = async ({
  entry,
}: {
  readonly entry: CachedGeneration
}): Promise<Buffer | undefined> => {
  try {
    const linked = await readFile(join(footprintDirectory(), entry.sidecar))
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
  readonly contentStore: string
  /** Owned, canonical, same-CAS root whose generations may be evicted under its lock. */
  readonly trusted: boolean
  readonly held: boolean
  /** Generation name -> view name of each canonical current pointer. */
  readonly currents: ReadonlyMap<string, string>
  /** Latest publication (pointer mtime) or recorded explicit use of this root. */
  readonly activeAtMs: number
  /** Advisory snapshot taken under the owning CAS flock; undefined means unreadable. */
  readonly pins: ReadonlySet<string> | undefined
}

type GenerationView = {
  readonly key: string
  readonly root: RootView
  readonly name: string
  readonly dir: string
  readonly kind: 'generation' | 'unmanaged' | 'orphan'
  readonly identity: string | undefined
  readonly ownedBytes: number
  readonly linked: Buffer
  readonly readOnly: boolean
  readonly package: string | undefined
  readonly lastUseMs: number
}

type Census = {
  readonly epoch: number
  readonly measuredAtMs: number
  readonly contentStores: readonly string[]
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

/** Invocation-scoped, single-flight accounting; never an authority for retirement. */
export type EditorViewBudgetCensusSession = {
  readonly censuses: Map<string, Promise<Census>>
  readonly pending: Map<string, Promise<Census>>
}

/** Creates the advisory census cache shared by one publication invocation. */
export const makeEditorViewBudgetCensusSession = (): EditorViewBudgetCensusSession => ({
  censuses: new Map(),
  pending: new Map(),
})

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
      resolve(defaultEditorViewContentStore({ repoRoot: repoRoot })) === resolve(contentStore)
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
    otherBytes += Number(accountedBytes(status))
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
          inodes.set(
            `${entry.status.dev}:${entry.status.ino}`,
            Number(accountedBytes(entry.status)),
          )
        else otherBytes += Number(accountedBytes(entry.status))
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
  const candidates = new Map<string, EditorViewBudgetRoot & { readonly contentStore: string }>()
  for (const [editorRoot, entry] of state.roots)
    candidates.set(editorRoot, { ...entry, editorRoot })
  for (const entry of [...discoverRoots(), root]) {
    const editorRoot = resolve(entry.editorRoot)
    if (candidates.has(editorRoot) === false || editorRoot === resolve(root.editorRoot))
      candidates.set(editorRoot, {
        repoRoot: resolve(entry.repoRoot),
        editorRoot,
        contentStore,
      })
  }
  const views: RootView[] = []
  for (const candidate of candidates.values()) {
    const held = candidate.editorRoot === resolve(heldEditorRoot)
    const registration = state.roots.get(candidate.editorRoot)
    const inspected = inspectRoot({
      root: candidate,
      contentStore: candidate.contentStore,
      held,
      registered:
        registration?.repoRoot === candidate.repoRoot &&
        registration.contentStore === candidate.contentStore,
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
    views.push({
      root: candidate,
      key: candidate.editorRoot,
      contentStore: candidate.contentStore,
      trusted: inspected.trusted,
      held,
      currents,
      activeAtMs,
      pins: undefined,
    })
  }
  return views
}

const censusStage = ({
  stage,
  durationMs,
  ...counts
}: { readonly stage: string; readonly durationMs: number } & Readonly<
  Record<string, string | number>
>): void => {
  process.stderr.write(
    `[editor-view-budget] ${JSON.stringify({ event: 'completed', stage, durationMs, ...counts })}\n`,
  )
}

/** One invocation-local inventory per candidate-bearing root, never every census root. */
const makePointerInventory = () => {
  const pointers = new Map<string, ReadonlySet<string> | undefined>()
  const observations: {
    readonly editorRoot: string
    readonly entries: number
    readonly durationMs: number
  }[] = []
  return {
    read: (root: EditorViewBudgetRoot): ReadonlySet<string> | undefined => {
      if (pointers.has(root.editorRoot) === false)
        pointers.set(
          root.editorRoot,
          referencedEditorViewPaths({
            ...root,
            onInventory: (observation) =>
              observations.push({ editorRoot: root.editorRoot, ...observation }),
          }),
        )
      return pointers.get(root.editorRoot)
    },
    report: (phase: 'census' | 'plan'): void => {
      if (observations.length === 0) return
      process.stderr.write(
        `[editor-view-budget] ${JSON.stringify({
          event: 'completed',
          stage: 'pointer-inventory',
          phase,
          roots: observations.length,
          entries: observations.reduce((total, observation) => total + observation.entries, 0),
          durationMs: observations.reduce(
            (total, observation) => total + observation.durationMs,
            0,
          ),
          inventories: observations,
        })}\n`,
      )
    },
  }
}

const takeCensus = async ({
  contentStore,
  root,
  heldEditorRoot,
  discoverRoots,
  staged,
}: {
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
  readonly heldEditorRoot: string
  readonly discoverRoots: () => readonly EditorViewBudgetRoot[]
  readonly staged: Map<string, string>
}): Promise<Census> => {
  const discoveryStarted = performance.now()
  /* eslint-disable no-await-in-loop -- Legacy reconciliation never waits for a root lock. */
  for (const store of readState().contentStores) await synchronizeLegacyStore(store)
  /* eslint-enable no-await-in-loop */
  const state = readState()
  const unknown: string[] = []
  const roots = listRoots({ contentStore, root, heldEditorRoot, discoverRoots, state, unknown })
  const pinRoots = new Map<string, number[]>()
  for (let index = 0; index < roots.length; index += 1) {
    const view = roots[index]
    if (view === undefined || view.trusted === false) continue
    const indexes = pinRoots.get(view.contentStore)
    if (indexes === undefined) pinRoots.set(view.contentStore, [index])
    else indexes.push(index)
  }
  /* eslint-disable no-await-in-loop -- One short pin metadata transaction per owning store. */
  for (const [store, indexes] of pinRoots) {
    try {
      await withEditorViewContentStoreLock({
        contentStore: store,
        run: async () => {
          for (const index of indexes) {
            const view = roots[index]
            if (view === undefined) continue
            let pins: ReadonlySet<string> | undefined
            try {
              pins = managedEditorViewSnapshots({ editorRoot: view.key })
            } catch {
              pins = undefined
            }
            roots[index] = { ...view, pins }
          }
        },
      })
    } catch {
      // Unreadable or vanished stores leave all their roots non-evictable.
    }
  }
  /* eslint-enable no-await-in-loop */
  censusStage({
    stage: 'root-discovery',
    durationMs: performance.now() - discoveryStarted,
    roots: roots.length,
  })
  const enumerationStarted = performance.now()
  let sidecarReadMs = 0
  let sidecarHits = 0
  let sidecarMisses = 0
  let sidecarBytes = 0
  let footprintMs = 0
  let footprintWalks = 0
  let footprintBytes = 0
  let sidecarWriteMs = 0
  let sidecarWrites = 0
  const measureFootprint = async ({
    dir,
    seal = false,
  }: {
    readonly dir: string
    readonly seal?: boolean
  }) => {
    const started = performance.now()
    const footprint = await walkTree({ root: dir, unknown, seal })
    footprintMs += performance.now() - started
    footprintWalks += 1
    footprintBytes += footprint?.linked.length ?? 0
    return footprint
  }
  const reservedRoots = new Set(
    Array.from(state.reservations.values(), (entry) => entry.editorRoot),
  )
  const cache = new Map<string, CachedGeneration>()
  const generations: GenerationView[] = []
  const rootBytes = new Map<string, number>()
  const pointerInventory = makePointerInventory()
  const addUnmanaged = async ({
    rootView,
    dir,
    name,
  }: {
    rootView: RootView
    dir: string
    name: string
  }) => {
    const pointers =
      name.startsWith('.legacy/') === true ? pointerInventory.read(rootView.root) : undefined
    const reachedLegacy =
      name.startsWith('.legacy/') === true &&
      pointers !== undefined &&
      (Array.from(pointers).some((path) => isWithin({ root: dir, candidate: path })) === true ||
        observeEditorViewProcessCandidates({
          candidates: [
            {
              key: dir,
              editorRoot: rootView.key,
              snapshotRoot: dir,
              linkedInodes: [],
            },
          ],
        }).has(dir) === true)
    if (name.startsWith('.legacy/') === true && reachedLegacy === true) {
      const key = generationKey({ editorRoot: rootView.key, name })
      const stamp = cachedTreeIdentity({ editorRoot: rootView.key, name })
      const existing = state.generations.get(key)
      const sidecarStarted = performance.now()
      if (stamp !== undefined && existing?.identity === stamp.identity) {
        const linked = await readSidecar({ entry: existing })
        if (linked !== undefined) {
          sidecarReadMs += performance.now() - sidecarStarted
          sidecarHits += 1
          sidecarBytes += linked.length
          cache.set(key, existing)
          generations.push({
            key,
            root: rootView,
            name,
            dir,
            kind: 'orphan',
            identity: existing.identity,
            ownedBytes: existing.ownedBytes,
            linked,
            readOnly: true,
            package: undefined,
            lastUseMs: stamp.mtimeMs,
          })
          return
        }
      }
      sidecarReadMs += performance.now() - sidecarStarted
      sidecarMisses += 1
    }
    const unknownBefore = unknown.length
    const footprint = await measureFootprint({
      dir,
      seal: reachedLegacy === true && rootView.held === true && rootView.trusted === true,
    })
    if (footprint === undefined) return
    const stamp = unknown.length === unknownBefore ? orphanIdentity({ dir }) : undefined
    if (reachedLegacy === true && footprint.readOnly === true && stamp !== undefined) {
      const key = generationKey({ editorRoot: rootView.key, name })
      const sidecar = sidecarName({ key, identity: stamp.identity })
      const writeStarted = performance.now()
      await writeSidecar({ staged, name: sidecar, linked: footprint.linked })
      sidecarWriteMs += performance.now() - writeStarted
      sidecarWrites += 1
      cache.set(key, {
        editorRoot: rootView.key,
        name,
        identity: stamp.identity,
        ownedBytes: footprint.ownedBytes,
        linkedBytes: footprint.linkedBytes,
        sidecar,
        readOnly: true,
      })
    }
    generations.push({
      key: generationKey({ editorRoot: rootView.key, name }),
      root: rootView,
      name,
      dir,
      kind:
        name.startsWith('.store/.candidate-') === true ||
        name.startsWith('.gc-') === true ||
        name.startsWith('.legacy/') === true
          ? 'orphan'
          : 'unmanaged',
      identity: stamp?.identity,
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
    const [rootStatus, storeStatus] = await Promise.all([
      lstatIfPresent(editorRoot),
      lstatIfPresent(storeDir),
    ])
    rootBytes.set(
      editorRoot,
      Number(rootStatus === undefined ? 0n : accountedBytes(rootStatus)) +
        Number(storeStatus === undefined ? 0n : accountedBytes(storeStatus)),
    )
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
      if (status.isDirectory() === true && name === '.legacy') {
        rootBytes.set(editorRoot, (rootBytes.get(editorRoot) ?? 0) + Number(accountedBytes(status)))
        for (const entry of readdirSync(path))
          await addUnmanaged({ rootView, dir: join(path, entry), name: `.legacy/${entry}` })
      } else if (status.isDirectory() === true) await addUnmanaged({ rootView, dir: path, name })
      else
        rootBytes.set(editorRoot, (rootBytes.get(editorRoot) ?? 0) + Number(accountedBytes(status)))
    }
    let storeEntries: string[] = []
    try {
      if (storeStatus?.isDirectory() === true) storeEntries = readdirSync(storeDir)
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
      const sidecarStarted = performance.now()
      if (stamp !== undefined && cached !== undefined && cached.identity === stamp.identity) {
        linked = await readSidecar({ entry: cached })
        if (linked !== undefined) entry = cached
      }
      sidecarReadMs += performance.now() - sidecarStarted
      if (linked === undefined) sidecarMisses += 1
      else {
        sidecarHits += 1
        sidecarBytes += linked.length
      }
      if (entry === undefined || linked === undefined) {
        const footprint = await measureFootprint({ dir })
        if (footprint === undefined) continue
        const recordedPackage = await recordPackage({ dir, name })
        linked = footprint.linked
        if (stamp !== undefined && footprint.readOnly === true) {
          const sidecar = sidecarName({ key, identity: stamp.identity })
          const writeStarted = performance.now()
          await writeSidecar({ staged, name: sidecar, linked })
          sidecarWriteMs += performance.now() - writeStarted
          sidecarWrites += 1
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
  pointerInventory.report('census')
  censusStage({
    stage: 'generation-enumeration',
    durationMs:
      performance.now() - enumerationStarted - sidecarReadMs - footprintMs - sidecarWriteMs,
    generations: generations.length,
  })
  censusStage({
    stage: 'sidecar-reads',
    durationMs: sidecarReadMs,
    hits: sidecarHits,
    misses: sidecarMisses,
    bytes: sidecarBytes,
  })
  censusStage({
    stage: 'footprint-walks',
    durationMs: footprintMs,
    walks: footprintWalks,
    linkedBytes: footprintBytes,
  })
  censusStage({ stage: 'sidecar-staging', durationMs: sidecarWriteMs, sidecars: sidecarWrites })
  const casStarted = performance.now()
  const cas = { inodes: new Map<string, number>(), otherBytes: 0 }
  const contentStores = new Set([...state.contentStores, ...roots.map((view) => view.contentStore)])
  let localMetadataBytes = 0
  const metadataLinked = new Map<string, number>()
  for (const store of contentStores) {
    try {
      const footprint = await casCensus(store)
      for (const [key, size] of footprint.inodes) cas.inodes.set(key, size)
      cas.otherBytes += footprint.otherBytes
      for (const path of [`${store}.budget`, `${store}.budget.retired`]) {
        const metadata = await walkTree({ root: path, unknown })
        if (metadata === undefined) continue
        localMetadataBytes += metadata.ownedBytes
        forEachLinked({
          linked: metadata.linked,
          visit: (key, size) => metadataLinked.set(key, size),
        })
      }
      const lockPath = `${store}.flock`
      const lock = await lstatIfPresent(lockPath)
      if (lock !== undefined) {
        if (lock.isFile() === true && lock.uid === BigInt(userId()))
          metadataLinked.set(`${lock.dev}:${lock.ino}`, Number(accountedBytes(lock)))
        else unknown.push(lockPath)
      }
    } catch (error) {
      if (vanished(error) === false) unknown.push(store)
    }
  }
  /* eslint-enable no-await-in-loop */
  // Host metadata participates in accounting, but obsolete sidecars are collected under its flock.
  const ledger = await walkTree({ root: editorViewHostBudgetStateDirectory(), unknown })
  censusStage({
    stage: 'cas-accounting',
    durationMs: performance.now() - casStarted,
    stores: contentStores.size,
    entries: cas.inodes.size,
  })
  const mergeStarted = performance.now()
  let linkedEntries = 0
  const distinct = new Map(cas.inodes)
  for (const [key, size] of metadataLinked) distinct.set(key, size)
  if (ledger !== undefined)
    forEachLinked({ linked: ledger.linked, visit: (key, size) => distinct.set(key, size) })
  const referenced = new Set<string>()
  const holders = new Map<string, { bytes: number; generations: number; seen: Set<string> }>()
  let usedBytes = cas.otherBytes + localMetadataBytes + (ledger?.ownedBytes ?? 0)
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
        linkedEntries += 1
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
  censusStage({
    stage: 'linked-inode-merge',
    durationMs: performance.now() - mergeStarted,
    entries: linkedEntries,
    distinctEntries: distinct.size,
  })
  return {
    epoch: state.epoch,
    measuredAtMs: Date.now(),
    contentStores: Array.from(contentStores),
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

const collectBudgetContentStores = async (contentStores: Iterable<string>): Promise<void> => {
  /* eslint-disable no-await-in-loop -- Each CAS owns its collection lock; neither host nor other-root flocks are held. */
  for (const contentStore of contentStores) {
    try {
      if ((await lstatIfPresent(contentStore))?.isDirectory() === true)
        await collectEditorViewContentStore({ contentStore })
    } catch (error) {
      if (vanished(error) === false) throw error
    }
  }
  /* eslint-enable no-await-in-loop */
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
  observed,
  recencyMs,
  now,
}: {
  readonly census: Census
  readonly blocked: ReadonlySet<string>
  /** Generations with positive kernel references (path or shared inode). */
  readonly live: ReadonlySet<string>
  /** When supplied, absence from the reader census cannot authorize deletion. */
  readonly observed?: ReadonlySet<string>
  readonly recencyMs: number
  readonly now: number
}): Plan => {
  const pointerInventory = makePointerInventory()
  const eligible = census.generations.filter((generation) => {
    if (observed !== undefined && observed.has(generation.key) === false) return false
    const current = generation.root.currents.has(generation.name)
    if (generation.kind === 'orphan') {
      if (
        generation.root.trusted === false ||
        generation.identity === undefined ||
        blocked.has(generation.key) === true ||
        live.has(generation.key) === true ||
        hasEditorViewBudgetReservation({ editorRoot: generation.root.key }) === true
      )
        return false
      // Ordinary generations need no package-pointer walk. Only a potentially
      // evictable orphan can request this invocation's root-local inventory.
      const pointers = pointerInventory.read(generation.root.root)
      return (
        pointers !== undefined &&
        Array.from(pointers).some((path) => isWithin({ root: generation.dir, candidate: path })) ===
          false
      )
    }
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
  pointerInventory.report('plan')
  const order = eligible.toSorted((left, right) => {
    if ((left.kind === 'orphan') !== (right.kind === 'orphan'))
      return left.kind === 'orphan' ? -1 : 1
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

const linkedInodes = function* (linked: Buffer): Generator<string> {
  for (let offset = 0; offset + entryBytes <= linked.length; offset += entryBytes)
    yield `${linked.readBigUInt64LE(offset)}:${linked.readBigUInt64LE(offset + 8)}`
}

/** Positive readers and incomplete migration evidence both protect a candidate. */
const observeGenerations = (generations: readonly GenerationView[]): ReadonlySet<string> => {
  const candidates: EditorViewProcessCandidate[] = []
  const generationCandidates: EditorViewProcessCandidate[] = []
  const protectedGenerations = new Set<string>()
  for (const generation of generations) {
    const candidate = {
      key: generation.key,
      editorRoot: generation.root.key,
      snapshotRoot: generation.dir,
      linkedInodes: linkedInodes(generation.linked),
    }
    candidates.push(candidate)
    if (generation.kind === 'generation') generationCandidates.push(candidate)
  }
  const evidence = classifyEditorViewProcessCandidates({ candidates })
  const protectedRoots = new Map<string, boolean>()
  for (const generation of generations) {
    if (generation.kind === 'orphan') {
      if (evidence.get(generation.key)?.state !== 'clear') protectedGenerations.add(generation.key)
      continue
    }
    let protectedRoot = protectedRoots.get(generation.root.key)
    if (protectedRoot === undefined) {
      protectedRoot =
        editorViewAutomaticEvictionEvidence({
          editorRoot: generation.root.key,
          candidates: generationCandidates,
          evidence,
        }).state !== 'clear'
      protectedRoots.set(generation.root.key, protectedRoot)
    }
    if (protectedRoot === true) protectedGenerations.add(generation.key)
  }
  return protectedGenerations
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

/** A reader proof is a bounded observation, never a durable permission to delete. */
const retirementProofMaxAgeMs = 30_000
type RetirementBatch = {
  readonly state: BudgetState
  readonly live: ReadonlySet<string>
  readonly observed: ReadonlySet<string>
  readonly proofAtMs: number
  readonly garbage: string[]
  readonly leases: { readonly release: () => void }[]
  readonly beforeCandidateRetirement:
    | ((candidate: { readonly key: string; readonly dir: string }) => void)
    | undefined
  expired: boolean
}

/**
 * Root/host/CAS fences are held. Fresh nonblocking EX ownership excludes managed
 * generation readers until the cleanup owner closes its retained descriptors.
 * Orphans were never published to the launcher and require no lease control.
 */
const checkEditorViewBudgetCandidateBeforeDelete = (
  options: {
    readonly candidate: OrphanCandidate
    readonly state: BudgetState
    readonly batch?: RetirementBatch | undefined
  } & (
    | { readonly kind: 'orphan' }
    | {
        readonly kind: 'generation'
        readonly editorRoot: string
        readonly leases: { readonly release: () => void }[]
      }
  ),
): boolean => {
  const { candidate, kind, state, batch } = options
  if (batch !== undefined && batch.observed.has(candidate.key) === false) return false
  batch?.beforeCandidateRetirement?.({ key: candidate.key, dir: candidate.dir })
  if (batch !== undefined && Date.now() - batch.proofAtMs >= retirementProofMaxAgeMs) {
    batch.expired = true
    return false
  }
  const identity =
    kind === 'orphan'
      ? orphanIdentity({ dir: candidate.dir })?.identity
      : generationIdentity(candidate.dir)?.identity
  if (
    candidate.identity === undefined ||
    identity !== candidate.identity ||
    readState().epoch !== state.epoch ||
    batch?.live.has(candidate.key) === true
  )
    return false
  if (options.kind === 'generation') {
    const lease = probeEditorViewLeaseUnderFence({
      editorRoot: options.editorRoot,
      snapshot: candidate.dir,
    })
    if (lease.state !== 'clear') {
      lease.release()
      return false
    }
    options.leases.push(lease)
  }
  return true
}

type OrphanCandidate = {
  readonly key: string
  readonly dir: string
  readonly identity: string | undefined
  readonly linked: Buffer
}

const retireOrphans = async ({
  editorRoot,
  repoRoot,
  candidates,
  censusEpoch,
  publisherCleanup = false,
  publicationLock,
  batch,
}: {
  readonly editorRoot: string
  readonly repoRoot?: string | undefined
  readonly candidates: readonly OrphanCandidate[]
  readonly censusEpoch?: number
  readonly publisherCleanup?: boolean
  readonly publicationLock?: EditorViewPublicationLockProof
  readonly batch?: RetirementBatch | undefined
}): Promise<Retirement> => {
  const owners = batch === undefined ? budgetProcessOwners() : new Map<number, string>()
  const retired: string[] = []
  const blocked: string[] = []
  const garbage: string[] = batch?.garbage ?? []
  const transaction = async () => {
    const state = batch?.state ?? readState()
    if (batch === undefined && censusEpoch !== undefined && censusEpoch !== state.epoch) return
    const reclaimed = reclaimDeadReservations({ state, owners })
    if (reclaimed > 0) writeState(state)
    if (hasEditorViewBudgetReservation({ editorRoot }) === true) {
      blocked.push(...candidates.map((candidate) => candidate.key))
      return
    }
    const registered = state.roots.get(editorRoot)
    const owningRepoRoot = repoRoot ?? registered?.repoRoot
    const contentStore =
      registered?.contentStore ??
      (owningRepoRoot === undefined
        ? undefined
        : defaultEditorViewContentStore({ repoRoot: owningRepoRoot }))
    if (contentStore === undefined) {
      blocked.push(...candidates.map((candidate) => candidate.key))
      return
    }
    const retire = async () => {
      const pointers = referencedEditorViewPaths({
        editorRoot,
        repoRoot: repoRoot ?? state.roots.get(editorRoot)?.repoRoot,
      })
      if (pointers === undefined) {
        blocked.push(...candidates.map((candidate) => candidate.key))
        return
      }
      // Normal acquisition follows the previous publisher's release; recovered
      // acquisition follows its same-host dead-owner proof. Both exclude writes.
      // Pointers must still prove unreachability, and stale cwd/fd readers keep
      // even unpublished candidates and already-committed .gc payloads.
      const live =
        batch?.live ??
        observeEditorViewProcessCandidates({
          candidates: candidates.map((candidate) => ({
            key: candidate.key,
            editorRoot,
            snapshotRoot: candidate.dir,
            linkedInodes: linkedInodes(candidate.linked),
          })),
        })
      for (const candidate of candidates) {
        if (
          (publisherCleanup === true &&
            (publicationLock === undefined ||
              holdsPublicationLock({ editorRoot, proof: publicationLock }) === false)) ||
          candidate.identity === undefined ||
          orphanIdentity({ dir: candidate.dir })?.identity !== candidate.identity ||
          live.has(candidate.key) === true ||
          Array.from(pointers).some((path) =>
            isWithin({ root: candidate.dir, candidate: path }),
          ) === true
        ) {
          blocked.push(candidate.key)
          continue
        }
        if (
          checkEditorViewBudgetCandidateBeforeDelete({
            candidate,
            kind: 'orphan',
            state,
            batch,
          }) === false
        ) {
          if (batch?.expired !== true) blocked.push(candidate.key)
          continue
        }
        const destination = join(editorRoot, `.gc-${randomUUID()}-orphan`)
        const mode = statSync(candidate.dir).mode & 0o777
        chmodSync(candidate.dir, mode | 0o200)
        try {
          renameSync(candidate.dir, destination)
        } catch (error) {
          chmodSync(candidate.dir, mode)
          throw error
        }
        chmodSync(destination, mode)
        garbage.push(destination)
        retired.push(candidate.key)
        state.generations.delete(candidate.key)
        state.lastUse.delete(candidate.key)
        state.epoch += 1
        writeState(state)
        process.stderr.write(
          `[editor-view-budget] ${JSON.stringify({
            event: 'editor-view.host-budget.retired',
            editorRoot,
            classification: 'orphan',
            evicted: [candidate.key],
            phase: 'committed',
            publisherCleanup,
            ...(publicationLock === undefined
              ? {}
              : { publicationLockAcquisition: publicationLock.acquisition }),
          })}\n`,
        )
      }
    }
    await withEditorViewContentStoreLock({ contentStore, run: retire })
  }
  if (batch === undefined) await withHostBudgetLock(transaction)
  else await transaction()
  // Failed/interrupted cleanup leaves another recognizable orphan for the next lock owner.
  for (const directory of batch === undefined ? garbage : []) {
    makeDirectoriesWritable(directory)
    rmSync(directory, { recursive: true })
  }
  return { retired, blocked }
}

/**
 * Reconcile abandoned publisher payloads before creating any new candidate.
 * Caller holds this root's publication lock; recursive work never holds the host fence.
 */
export const reclaimEditorViewOrphans = async ({
  editorRoot,
  repoRoot,
  publicationLock,
}: {
  readonly editorRoot: string
  readonly repoRoot?: string | undefined
  readonly publicationLock: EditorViewPublicationLockProof
}): Promise<boolean> => {
  if (
    publicationLock === undefined ||
    holdsPublicationLock({ editorRoot, proof: publicationLock }) === false
  )
    return false
  ensureBudgetDirectory()
  const root = resolve(editorRoot)
  const paths: string[] = []
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    if (name.startsWith('.gc-') === true) paths.push(path)
    else if (name === '.legacy' || name === '.store') {
      if (lstatSync(path).isDirectory() === false) continue
      for (const entry of readdirSync(path))
        if (name === '.legacy' || entry.startsWith('.candidate-') === true)
          paths.push(join(path, entry))
    }
  }
  if (paths.length === 0) return false
  const candidates: OrphanCandidate[] = []
  const pointers = referencedEditorViewPaths({
    editorRoot: root,
    repoRoot: repoRoot ?? readState().roots.get(root)?.repoRoot,
  })
  for (const dir of paths) {
    const identity = orphanIdentity({ dir })?.identity
    if (identity === undefined) continue
    if (
      dir.startsWith(join(root, '.legacy') + sep) === true &&
      relative(join(root, '.legacy'), dir).startsWith('.candidate-') === false &&
      (pointers === undefined ||
        Array.from(pointers).some((path) => isWithin({ root: dir, candidate: path })) === true ||
        observeEditorViewProcessCandidates({
          candidates: [
            {
              key: dir,
              editorRoot: root,
              snapshotRoot: dir,
              linkedInodes: [],
            },
          ],
        }).has(dir) === true)
    )
      continue
    const unknown: string[] = []
    // eslint-disable-next-line no-await-in-loop -- One payload at a time bounds footprint memory.
    const footprint = await walkTree({ root: dir, unknown })
    if (footprint === undefined || unknown.length > 0) continue
    candidates.push({
      key: generationKey({ editorRoot: root, name: relative(root, dir) }),
      dir,
      identity,
      linked: footprint.linked,
    })
  }
  return (
    (
      await retireOrphans({
        editorRoot: root,
        repoRoot,
        candidates,
        publisherCleanup: true,
        publicationLock,
      })
    ).retired.length > 0
  )
}

const retireRoot = async ({
  root,
  generations,
  readerGenerations,
  budgetBytes,
  usedBytes,
  recencyMs,
  censusEpoch,
  batch,
}: {
  readonly root: RootView
  readonly generations: readonly GenerationView[]
  readonly readerGenerations: readonly GenerationView[]
  readonly budgetBytes: number
  readonly usedBytes: number
  readonly recencyMs: number
  readonly censusEpoch: number
  readonly batch?: RetirementBatch | undefined
}): Promise<Retirement> => {
  const orphans = generations.filter((generation) => generation.kind === 'orphan')
  if (orphans.length > 0) {
    const result = await retireOrphans({
      editorRoot: root.key,
      repoRoot: root.root.repoRoot,
      candidates: orphans,
      censusEpoch,
      batch,
    })
    const normal = generations.filter((generation) => generation.kind !== 'orphan')
    if (normal.length === 0) return result
    const remaining = await retireRoot({
      root,
      generations: normal,
      readerGenerations,
      budgetBytes,
      usedBytes,
      recencyMs,
      censusEpoch: result.retired.length > 0 ? censusEpoch + 1 : censusEpoch,
      batch,
    })
    return {
      retired: [...result.retired, ...remaining.retired],
      blocked: [...result.blocked, ...remaining.blocked],
    }
  }
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
  const garbage: string[] = batch?.garbage ?? []
  const leases: { readonly release: () => void }[] = batch?.leases ?? []
  const retired: string[] = []
  const transaction = async () => {
    await withEditorViewContentStoreLock({
      contentStore: root.contentStore,
      run: async () => {
        const state = batch?.state ?? readState()
        // Journal changes after the fresh census require another admission round.
        if (batch === undefined && state.epoch !== censusEpoch) return
        const registration = state.roots.get(root.key)
        if (
          registration?.contentStore !== root.contentStore ||
          registration.repoRoot !== root.root.repoRoot
        ) {
          blocked.push(...admitted.map(({ generation }) => generation.key))
          return
        }
        // Legacy evidence covers every generation of the root, not only selected victims.
        const live = batch?.live ?? observeGenerations(readerGenerations)
        const pinned = managedEditorViewSnapshots({ editorRoot: root.key })
        let activeAtMs = 0
        for (const [key, at] of state.lastUse)
          if (key.startsWith(`${root.key}\0`) === true) activeAtMs = Math.max(activeAtMs, at)
        const pointers = new Map<string, string>()
        let entries: string[]
        try {
          entries = readdirSync(root.key)
        } catch (error) {
          if (vanished(error) === false) throw error
          blocked.push(...admitted.map(({ generation }) => generation.key))
          return
        }
        for (const name of entries) {
          const path = join(root.key, name)
          try {
            const status = lstatSync(path)
            if (status.isSymbolicLink() === true) {
              const target = readlinkSync(path)
              pointers.set(name, target)
              const snapshot = snapshotPattern.exec(target)?.[1]
              if (snapshot !== undefined && snapshot.startsWith(`${name}-`) === true)
                activeAtMs = Math.max(activeAtMs, status.mtimeMs)
            }
          } catch (error) {
            if (vanished(error) === false) throw error
          }
        }
        for (const { generation, view, firstHop } of admitted) {
          // Recent use is reread only after root → host → owning CAS exclusion.
          const stamp = generationIdentity(generation.dir)
          const now = Date.now()
          if (
            pinned.has(generation.name) === true ||
            live.has(generation.key) === true ||
            stamp?.identity !== generation.identity ||
            now - activeAtMs < recencyMs ||
            now - Math.max(stamp?.mtimeMs ?? 0, state.lastUse.get(generation.key) ?? 0) <
              graceMs + touchRefreshMs
          ) {
            blocked.push(generation.key)
            continue
          }
          if (
            checkEditorViewBudgetCandidateBeforeDelete({
              candidate: generation,
              kind: 'generation',
              editorRoot: root.key,
              leases,
              state,
              batch,
            }) === false
          ) {
            if (batch?.expired !== true) blocked.push(generation.key)
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
          state.generations.delete(generation.key)
          state.lastUse.delete(generation.key)
          state.epoch += 1
          writeState(state)
          process.stderr.write(
            `[editor-view-budget] ${JSON.stringify({
              event: 'editor-view.host-budget.retired',
              editorRoot: root.key,
              classification: 'generation',
              evicted: [generation.key],
              phase: 'committed',
            })}\n`,
          )
        }
      },
    })
  }
  try {
    try {
      if (batch === undefined) await withHostBudgetLock(transaction)
      else await transaction()
    } finally {
      // Batch cleanup owns shared probes; local cleanup runs even after a failed transaction.
      for (const path of batch === undefined ? garbage : []) {
        makeDirectoriesWritable(path)
        rmSync(path, { recursive: true })
      }
    }
    return { retired, blocked }
  } finally {
    // Close only: never LOCK_UN an open description inherited by another process.
    if (batch === undefined) for (const lease of leases) lease.release()
  }
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
  beforeRetireRoot,
  beforeCandidateRetirement,
  budgetBytes,
  recencyMs = editorViewHostRecencyMs(),
  censusSession = makeEditorViewBudgetCensusSession(),
  onCensus,
}: {
  readonly contentStore: string
  readonly root: EditorViewBudgetRoot
  readonly reservationBytes: number
  readonly heldEditorRoot: string
  readonly discoverRoots: () => readonly EditorViewBudgetRoot[]
  readonly tryLockRoot: (
    root: EditorViewBudgetRoot,
  ) => EditorViewBudgetRootLock | undefined | Promise<EditorViewBudgetRootLock | undefined>
  readonly budgetBytes: number
  /** Root recency window protecting current generations; defaults to EDITOR_VIEW_HOST_RECENCY_MS. */
  readonly recencyMs?: number
  readonly censusSession?: EditorViewBudgetCensusSession | undefined
  /** Coordination hook after an actual census, not after a shared-cache hit. */
  readonly onCensus?: (() => void | Promise<void>) | undefined
  /** Called with the victim root lock held and neither flock held, before final eligibility. */
  readonly beforeRetireRoot?: (() => void | Promise<void>) | undefined
  /** Synchronous coordination seam immediately before each fenced identity/epoch check. */
  readonly beforeCandidateRetirement?: (candidate: {
    readonly key: string
    readonly dir: string
  }) => void
}): Promise<{ readonly token: string }> => {
  if (Number.isSafeInteger(reservationBytes) === false || reservationBytes <= 0)
    fail(`reservation must be a positive safe integer of bytes: ${reservationBytes}`)
  if (Number.isSafeInteger(budgetBytes) === false || budgetBytes <= 0)
    fail(`budget must be a positive safe integer of bytes: ${budgetBytes}`)
  if (Number.isSafeInteger(recencyMs) === false || recencyMs < 0)
    fail(`recency must be a non-negative safe integer of milliseconds: ${recencyMs}`)
  const startedAtMs = Date.now()
  const store = resolve(contentStore)
  const ledger = editorViewHostBudgetStateDirectory()
  const callerKey = `${ledger}\0${resolve(root.repoRoot)}\0${resolve(root.editorRoot)}\0${store}`
  const coversCaller = (census: Census): boolean =>
    census.contentStores.includes(store) === true &&
    census.roots.some(
      (view) =>
        view.key === resolve(root.editorRoot) &&
        view.root.repoRoot === resolve(root.repoRoot) &&
        view.contentStore === store,
    )
  const invalidateCensus = (): void => {
    censusSession.pending.delete(ledger)
    for (const key of censusSession.censuses.keys())
      if (key.startsWith(`${ledger}\0`) === true) censusSession.censuses.delete(key)
  }
  const progress = (reason: string) => {
    const pressure: Record<string, string> = {}
    if (process.platform === 'linux')
      for (const resource of ['memory', 'io'])
        try {
          pressure[resource] = readFileSync(`/proc/pressure/${resource}`, 'utf8').trim()
        } catch {
          // Pressure information is optional, never part of the admission proof.
        }
    process.stderr.write(
      `[editor-view-budget] ${JSON.stringify({ event: 'working', reason, elapsedMs: Date.now() - startedAtMs, pressure })}\n`,
    )
  }
  return withBudgetFootprints({
    contentStore: store,
    root,
    run: async (staged) => {
      const token = randomUUID()
      const blocked = new Set<string>()
      const evicted: string[] = []
      let collected = false
      const loadCensus = async (): Promise<Census> => {
        progress('census')
        const measured = await takeCensus({
          contentStore: store,
          root,
          heldEditorRoot,
          discoverRoots,
          staged,
        })
        await onCensus?.()
        // Publish sidecars before releasing a shared result: their temporary files
        // belong to this reservation and disappear when its scope completes.
        const installationStarted = performance.now()
        await withHostBudgetLock(async () => {
          const state = readState()
          for (const [key, entry] of measured.cache)
            if (
              cachedTreeIdentity({ editorRoot: entry.editorRoot, name: entry.name })?.identity ===
                entry.identity &&
              installSidecar({ staged, entry }) === true
            )
              state.generations.set(key, entry)
          writeState(state)
        })
        censusStage({
          stage: 'sidecar-installation',
          durationMs: performance.now() - installationStarted,
          entries: measured.cache.size,
        })
        return measured
      }
      const startCensus = (): Promise<Census> => {
        const pending: Promise<Census> = loadCensus()
          .then((measured) => {
            // Do not repopulate an entry invalidated while its census was in flight.
            if (censusSession.pending.get(ledger) === pending)
              for (const view of measured.roots)
                censusSession.censuses.set(
                  `${ledger}\0${view.root.repoRoot}\0${view.key}\0${view.contentStore}`,
                  pending,
                )
            return measured
          })
          .finally(() => {
            if (censusSession.pending.get(ledger) === pending) censusSession.pending.delete(ledger)
          })
        censusSession.pending.set(ledger, pending)
        return pending
      }
      /** One short flock transaction: reconcile the ledger, then reserve only if it fits. */
      const admit = async ({ census, plan }: { readonly census: Census; readonly plan: Plan }) => {
        const admissionStarted = performance.now()
        const owners = budgetProcessOwners()
        const obsolete = obsoleteGenerationFootprints()
        const result = await withHostBudgetLock(async () => {
          const state = readState()
          reclaimDeadReservations({ state, owners })
          const stale =
            coversCaller(census) === false ||
            census.epoch < state.journalFloor ||
            Array.from(state.contentStores).some(
              (entry) => census.contentStores.includes(entry) === false,
            ) ||
            Array.from(state.roots.keys()).some((editorRoot) => {
              if (census.roots.some((view) => view.key === editorRoot) === true) return false
              try {
                return lstatSync(editorRoot).isDirectory() === true
              } catch (error) {
                return vanished(error) === false
              }
            })
          const pending = state.journal
            .filter((entry) => entry.epoch > census.epoch)
            .reduce((sum, entry) => sum + entry.estimatedBytes, 0)
          const reserved = reservedBytes(state)
          // Admission stays conservative: measured usage plus every outstanding estimate.
          const used = census.usedBytes + reserved + pending
          await registerRoot({ state, contentStore: store, root })
          for (const view of census.roots) {
            const registered = state.roots.get(view.key)
            if (
              view.trusted === true &&
              (registered === undefined ||
                (registered.contentStore === view.contentStore &&
                  registered.repoRoot === view.root.repoRoot))
            )
              state.roots.set(view.key, {
                repoRoot: view.root.repoRoot,
                contentStore: view.contentStore,
              })
          }
          for (const [key, entry] of census.cache)
            if (
              cachedTreeIdentity({ editorRoot: entry.editorRoot, name: entry.name })?.identity ===
                entry.identity &&
              installSidecar({ staged, entry }) === true
            )
              state.generations.set(key, entry)
          // Never erase a newer warm touch, finish, or registration using an older census.
          collectObsoleteSidecars({ state, owners, obsolete })
          // Usage records only measured census values; estimates stay in the journal.
          state.usage = {
            usedBytes: census.usedBytes,
            protectedBytes: plan.protectedBytes,
            measuredAtMs: census.measuredAtMs,
          }
          const admitted = stale === false && used + reservationBytes <= budgetBytes
          if (admitted === true) {
            state.reservations.set(token, {
              token,
              pid: process.pid,
              process: selfProcess(),
              editorRoot: resolve(heldEditorRoot),
              contentStore: store,
              bytes: reservationBytes,
              budgetBytes,
              createdAtMs: Date.now(),
            })
            state.epoch += 1
          }
          updateWarning({
            state,
            contentStore: store,
            budgetBytes,
            topHolders: census.topHolders,
            startedAtMs,
          })
          if (admitted === true && evicted.length > 0)
            signal({
              state,
              contentStore: store,
              event: {
                event: 'editor-view.host-budget.evicted',
                budgetBytes,
                usedBytes: census.usedBytes,
                protectedBytes: plan.protectedBytes,
                reservedBytes: reserved,
                pendingEstimateBytes: pending,
                reservationBytes,
                topHolders: census.topHolders,
                evicted,
                ...(census.unknown.length > 0 ? { unaccounted: census.unknown } : {}),
                message: `retired ${evicted.length} editor-view generation(s) to admit ${reservationBytes} bytes within the ${budgetBytes}-byte host budget`,
              },
              startedAtMs,
              exitCode: 0,
            })
          writeState(state)
          return { admitted, stale, used, reserved, pending }
        })
        censusStage({
          stage: 'fenced-admission',
          durationMs: performance.now() - admissionStarted,
          admitted: Number(result.admitted),
          usedBytes: result.used,
          reservationBytes,
          budgetBytes,
        })
        return result
      }
      let last: { census: Census; plan: Plan } | undefined
      for (let round = 0; round < maxAdmissionRounds; round += 1) {
        // eslint-disable-next-line no-await-in-loop -- Each round must observe the previous round's retirements.
        let measured = await (censusSession.censuses.get(callerKey) ??
          censusSession.pending.get(ledger) ??
          startCensus())
        // A different worker's discovery may omit a newly registered root/store.
        // Validate this caller independently of the pre-registration journal state.
        if (coversCaller(measured) === false) {
          // eslint-disable-next-line no-await-in-loop -- A coverage miss requires a fresh census.
          measured = await startCensus()
        }
        // Held-root status is caller-local; a different worker may have measured it.
        const roots = measured.roots.map((view) => ({
          ...view,
          held: view.key === resolve(heldEditorRoot),
        }))
        const byKey = new Map(roots.map((view) => [view.key, view]))
        let census: Census = {
          ...measured,
          roots,
          generations: measured.generations.map((generation) =>
            Object.assign({}, generation, {
              root: byKey.get(generation.root.key) ?? generation.root,
            }),
          ),
        }
        if (
          collected === false &&
          census.unreferencedCasBytes > 0 &&
          census.usedBytes + reservedBytes(readState()) + reservationBytes > budgetBytes
        ) {
          collected = true
          // Unreferenced CAS reclamation cannot retire a generation; observe readers
          // only if pressure remains after this cheapest, first-priority collection.
          // eslint-disable-next-line no-await-in-loop -- Recount after unlinking CAS-only entries.
          await collectBudgetContentStores(census.contentStores)
          invalidateCensus()
          continue
        }
        // An unscanned generation is protected for accounting, never presumed clear.
        const roundAtMs = Date.now()
        let plan = planEviction({
          census,
          blocked,
          live: new Set(census.generations.map((generation) => generation.key)),
          recencyMs,
          now: roundAtMs,
        })
        last = { census, plan }
        // eslint-disable-next-line no-await-in-loop -- Admission is a single short flock transaction per round.
        const admission = await admit({ census, plan })
        if (admission.admitted === true) {
          return { token }
        }
        if (admission.stale === true) {
          invalidateCensus()
          continue
        }
        // Shared accounting is advisory and can authorize admission, never eviction.
        // Retake before planning retirement; immutable payloads are the same invariant
        // used by footprint sidecars. retireRoot fences identity/epoch and reader proofs.
        progress('waiting for capacity')
        invalidateCensus()
        progress('census')
        // eslint-disable-next-line no-await-in-loop -- Eviction never trusts a shared census.
        census = await takeCensus({
          contentStore: store,
          root,
          heldEditorRoot,
          discoverRoots,
          staged,
        })
        // eslint-disable-next-line no-await-in-loop -- Coordination hook follows actual censuses only.
        await onCensus?.()
        plan = planEviction({
          census,
          blocked,
          // Candidates only: the fenced batch below supplies reader authorization.
          live: new Set<string>(),
          recencyMs,
          now: roundAtMs,
        })
        last = { census, plan }
        // Recheck fit with the fresh accounting before paying for reader observation.
        // eslint-disable-next-line no-await-in-loop -- The journal fence precedes any retirement.
        const freshAdmission = await admit({ census, plan })
        if (freshAdmission.admitted === true) return { token }
        if (freshAdmission.stale === true) continue
        if (collected === false && census.unreferencedCasBytes > 0) {
          collected = true
          // eslint-disable-next-line no-await-in-loop -- Collection takes the CAS flock itself; no locks are held here.
          await collectBudgetContentStores(census.contentStores)
          continue
        }
        if (plan.order.length === 0) break
        const retirementRoots = new Map(
          plan.order.map((generation) => [generation.root.key, generation.root]),
        )
        const locks: EditorViewBudgetRootLock[] = []
        const available = new Set<string>()
        const garbage: string[] = []
        const leases: { readonly release: () => void }[] = []
        const retiredBefore = evicted.length
        const retiredStores = new Set<string>()
        const batchStartedAtMs = Date.now()
        try {
          // Acquire every selected publication exclusion before taking the single host fence.
          // A live owner is never waited on; abandoned-owner recovery may perform async I/O.
          for (const rootView of retirementRoots.values()) {
            // eslint-disable-next-line no-await-in-loop -- Root locks are nonblocking and acquired in candidate order.
            const lock = rootView.held === true ? undefined : await tryLockRoot(rootView.root)
            if (rootView.held === false && lock === undefined) {
              for (const generation of plan.order)
                if (generation.root.key === rootView.key) blocked.add(generation.key)
              continue
            }
            if (lock !== undefined) locks.push(lock)
            available.add(rootView.key)
            // eslint-disable-next-line no-await-in-loop -- Coordination runs before either metadata flock.
            await beforeRetireRoot?.()
          }
          progress('reader-scan')
          // eslint-disable-next-line no-await-in-loop -- One held host fence covers the complete retirement batch.
          await withHostBudgetLock(async () => {
            const state = readState()
            const proofAtMs = Date.now()
            // Observe the full root generation inventories, including unselected
            // generations, before fencing the selected candidate membership.
            const candidates = plan.order
            const live = observeGenerations(census.generations)
            const observed = new Set(candidates.map((generation) => generation.key))
            // Freeze time AND reader-observed membership: pointer removal may
            // expose an orphan even without time advancing during the proof.
            plan = planEviction({ census, blocked, live, observed, recencyMs, now: roundAtMs })
            last = { census, plan }
            if (state.epoch !== census.epoch) return
            const batch: RetirementBatch = {
              state,
              live,
              observed,
              proofAtMs,
              garbage,
              leases,
              beforeCandidateRetirement,
              expired: false,
            }
            const needed = freshAdmission.used + reservationBytes - budgetBytes
            const prefix = plan.cumulative.findIndex((freed) => freed >= needed)
            const selected = plan.order.slice(0, prefix === -1 ? plan.order.length : prefix + 1)
            progress('eviction')
            try {
              for (const generation of selected) {
                if (batch.expired === true) break
                if (available.has(generation.root.key) === false) continue
                if (observed.has(generation.key) === false) continue
                try {
                  // eslint-disable-next-line no-await-in-loop -- Owning CAS exclusion nests under the held host fence.
                  const outcome = await retireRoot({
                    root: generation.root,
                    generations: [generation],
                    readerGenerations: census.generations,
                    budgetBytes,
                    usedBytes: census.usedBytes,
                    recencyMs,
                    censusEpoch: state.epoch,
                    batch,
                  })
                  for (const key of outcome.blocked) blocked.add(key)
                  evicted.push(...outcome.retired)
                  if (outcome.retired.length > 0) retiredStores.add(generation.root.contentStore)
                } catch (error) {
                  if (vanished(error) === false) throw error
                  blocked.add(generation.key)
                }
              }
            } finally {
              if (batch.expired === true) invalidateCensus()
              process.stderr.write(
                `[editor-view-budget] ${JSON.stringify({
                  event: 'editor-view.host-budget.retirement-batch',
                  evicted: evicted.slice(retiredBefore),
                  proofExpired: batch.expired,
                  candidates: candidates.length,
                  durationMs: Date.now() - batchStartedAtMs,
                })}\n`,
              )
            }
          })
        } finally {
          // Private recursive cleanup never extends either metadata fence.
          try {
            for (const directory of garbage) {
              makeDirectoriesWritable(directory)
              rmSync(directory, { recursive: true })
            }
          } finally {
            // Shared batch probes outlive every per-root transaction and its payload cleanup.
            for (const lease of leases) lease.release()
            for (const lock of locks) lock.release()
          }
        }
        if (evicted.length > retiredBefore) {
          // eslint-disable-next-line no-await-in-loop -- Retired payload links free CAS blobs only after collection.
          await collectBudgetContentStores(retiredStores)
          collected = true
          invalidateCensus()
        }
      }
      // Reader uncertainty is a retention boundary, never permission to force admission.
      const census =
        last?.census ??
        (await takeCensus({ contentStore: store, root, heldEditorRoot, discoverRoots, staged }))
      const capacityError = new EditorViewCapacityError({
        budgetBytes,
        usedBytes: census.usedBytes + reservedBytes(readState()),
        reservationBytes,
        blockedGenerations: census.generations.reduce(
          (count, generation) =>
            count +
            (generation.kind === 'generation' && evicted.includes(generation.key) === false
              ? 1
              : 0),
          0,
        ),
        reasons: [
          'reader protection requires complete legacy evidence and an exclusive generation lease',
          ...census.unknown.slice(0, 5),
          'persistent lease-control tombstones retain inode and metadata pressure and must not be unlinked',
          'held leases, pins, recent use, incomplete reader evidence, and contended locks remain protected',
        ],
      })
      await withHostBudgetLock(async () => {
        const state = readState()
        state.usage = {
          usedBytes: census.usedBytes,
          protectedBytes: last?.plan.protectedBytes ?? census.usedBytes,
          measuredAtMs: census.measuredAtMs,
        }
        updateWarning({
          state,
          contentStore: store,
          budgetBytes,
          topHolders: census.topHolders,
          startedAtMs,
        })
        signal({
          state,
          contentStore: store,
          event: {
            event: 'editor-view.host-budget.over-budget',
            budgetBytes,
            usedBytes: census.usedBytes,
            protectedBytes: last?.plan.protectedBytes ?? census.usedBytes,
            reservedBytes: reservedBytes(state),
            pendingEstimateBytes: state.journal
              .filter((entry) => entry.epoch > census.epoch)
              .reduce((sum, entry) => sum + entry.estimatedBytes, 0),
            reservationBytes,
            topHolders: census.topHolders,
            evicted,
            ...(census.unknown.length > 0 ? { unaccounted: census.unknown } : {}),
            message: capacityError.message,
          },
          startedAtMs,
          exitCode: 1,
        })
        writeState(state)
      })
      throw capacityError
    },
  })
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
  return withBudgetFootprints({
    contentStore: store,
    root,
    maintenanceRoot: resolve(root.editorRoot),
    run: async (staged) => {
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
            await writeSidecar({ staged, name: sidecar, linked: footprint.linked })
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
      await withHostBudgetLock(async () => {
        const state = readState()
        const reservation = state.reservations.get(token)
        // Only the reserving incarnation may settle its reservation, and only for its own root.
        if (
          reservation !== undefined &&
          (reservation.pid !== process.pid ||
            reservation.process !== selfProcess() ||
            reservation.editorRoot !== editorRoot ||
            reservation.contentStore !== store)
        )
          fail(
            `reservation ${token} belongs to process ${reservation.pid} for ${reservation.editorRoot}, not ${editorRoot}`,
          )
        state.reservations.delete(token)
        state.legacyReservations.delete(token)
        // Conservative estimate: an incomplete walk never shrinks the admitted reservation.
        const estimatedBytes = actualBytes ?? Math.max(partialBytes, reservation?.bytes ?? 0)
        appendJournal({ state, estimatedBytes })
        if (
          cached !== undefined &&
          generationIdentity(dir)?.identity === cached.identity &&
          installSidecar({ staged, entry: cached }) === true
        )
          state.generations.set(key, cached)
        state.lastUse.set(key, Date.now())
        await registerRoot({ state, contentStore: store, root })
        // Full footprint counts shared payload inodes, so this is an upper bound on new bytes.
        if (reservation !== undefined && estimatedBytes > reservation.bytes)
          signal({
            state,
            contentStore: store,
            event: {
              event: 'editor-view.host-budget.underreserved',
              budgetBytes: reservation.budgetBytes,
              usedBytes: state.usage?.usedBytes ?? 0,
              protectedBytes: state.usage?.protectedBytes ?? 0,
              reservedBytes: reservedBytes(state),
              pendingEstimateBytes: estimatedBytes,
              reservationBytes: reservation.bytes,
              topHolders: [],
              message: `generation ${snapshot} footprint is up to ${estimatedBytes} bytes (shared payload inodes included) but reserved only ${reservation.bytes}; the publisher's reservation formula may undercount`,
            },
            startedAtMs,
            exitCode: 0,
          })
        writeState(state)
      })
    },
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
  selfProcess()
  await withHostBudgetLock(async () => {
    const state = readState()
    const reservation = state.reservations.get(token)
    if (reservation === undefined) return
    if (
      reservation.pid !== process.pid ||
      reservation.process !== selfProcess() ||
      reservation.contentStore !== store
    )
      fail(`reservation ${token} belongs to process ${reservation.pid}`)
    state.reservations.delete(token)
    state.legacyReservations.delete(token)
    state.epoch += 1
    writeState(state)
  })
}

/**
 * Warm path: record last use and evaluate the warning threshold from cached
 * usage only. No payload walk, hash, link, census or root discovery; the host
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
      state.contentStores.has(store) === true &&
      state.roots.get(editorRoot)?.repoRoot === repoRoot &&
      state.roots.get(editorRoot)?.contentStore === store &&
      crossing === state.warned
    )
  }
  selfProcess()
  if (fresh(readState()) === true) return
  await withHostBudgetLock(async () => {
    const state = readState()
    if (fresh(state) === true) return
    state.lastUse.set(key, Date.now())
    // Registration is the durable proof of this root's actual content store.
    await registerRoot({ state, contentStore: store, root })
    updateWarning({ state, contentStore: store, budgetBytes, topHolders: [], startedAtMs })
    writeState(state)
  })
}
