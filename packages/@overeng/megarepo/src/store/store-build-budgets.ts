import { createHash } from 'node:crypto'
import { constants, type BigIntStats, type Dir } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve } from 'node:path'

import { Clock, Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import {
  canonicalizeOwnerPath,
  deletionLeasePath,
  withDeletionLease,
} from './store-deletion-lease.ts'
import { recordGcDeletion, withGcPinnedDeletion } from './store-gc-receipts.ts'
import { isInsideWorktree, readProcessReferences } from './store-inuse.ts'
import { isPathProtected, type StoreLiveSet } from './store-liveness.ts'
import {
  captureDeletionIdentity,
  PinnedDeletionError,
  readDirectoryEvidence,
  storeDeletionPlatform,
  type DeletionIdentity,
  type DirectoryEvidence,
} from './store-pinned-deletion.ts'
import {
  isWorkspaceActive,
  readBudgetWorkspaceActivity,
  readBudgetWorktreeInUse,
  type BudgetActivityConfig,
  type BudgetWorkspaceActivity,
} from './store-workspace-activity.ts'

const Bytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const AbsolutePath = Schema.NonEmptyString.check(
  Schema.makeFilter((path) => isAbsolute(path) && !path.includes('\0')),
)
const RootPattern = Schema.NonEmptyString.check(
  Schema.makeFilter((pattern) => {
    const path = pattern.startsWith('**/') === true ? pattern.slice(3) : pattern
    return (
      path.length > 0 &&
      !path.startsWith('/') &&
      !path.endsWith('/') &&
      !path.includes('\0') &&
      !path.includes('\\') &&
      !path.includes('*') &&
      path.split('/').every((part) => part !== '.' && part !== '..' && part !== '.git') &&
      path !== 'tmp/worklog' &&
      !path.startsWith('tmp/worklog/') &&
      !(pattern.startsWith('**/') && path.includes('/'))
    )
  }),
)

/** Strict host policy: accounting is allocated bytes, not logical size or exclusive ZFS usage. */
export const BuildOutputBudgets = Schema.Struct({
  schemaVersion: Schema.Literal('megarepo.build-output-budgets.v2'),
  host: Schema.NonEmptyString,
  storeRoots: Schema.Array(AbsolutePath).check(Schema.isMinLength(1)),
  quotaBytes: Bytes,
  idleRetentionMs: Bytes,
  classes: Schema.Record(
    Schema.NonEmptyString,
    Schema.Struct({
      budgetBytes: Bytes,
      paths: Schema.optionalKey(Schema.Array(RootPattern).check(Schema.isMinLength(1))),
      repoRoots: Schema.optionalKey(Schema.Literal('*-target')),
    }),
  ),
  worklog: Schema.optionalKey(
    Schema.Struct({
      path: Schema.Literal('tmp/worklog'),
      teardown: Schema.Literals(['delete', 'retain']),
    }),
  ),
}).annotate({ identifier: 'Megarepo.BuildOutputBudgets' })
export type BuildOutputBudgets = typeof BuildOutputBudgets.Type

/** Closed set of budget eligibility and retention reasons. */
export const BudgetReason = Schema.Literals([
  'eligible',
  'within-budget',
  'live',
  'lease-held',
  'lease-unknown',
  'retention',
  'agent-liveness-unavailable',
  'process-liveness-unavailable',
  'artifact-tracked',
  'artifact-tracked-unknown',
  'artifact-not-ignored',
  'artifact-ignore-unknown',
  'artifact-scan-incomplete',
  'scan-incomplete',
  'deletion-partial',
  'artifact-authority-missing',
])
const CandidateFields = {
  path: AbsolutePath,
  livenessKey: AbsolutePath,
  admissionIdentity: Schema.NonEmptyString,
  artifactClass: Schema.NonEmptyString,
  allocatedBytes: Bytes,
  reclaimableBytes: Bytes,
  mtimeMs: Schema.Finite,
  fingerprint: Schema.String,
  outcome: Schema.Literals(['would-delete', 'keep', 'unknown', 'deleted', 'partial']),
  reason: BudgetReason,
  recoverPath: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
}
/** Ownership is truthful: repository build outputs have no worktree ref identity. */
export const BudgetCandidate = Schema.Union([
  Schema.Struct({
    ...CandidateFields,
    kind: Schema.Literal('worktree'),
    repo: Schema.String,
    ref: Schema.String,
    refType: Schema.Literals(['heads', 'tags', 'commits', 'symbolic']),
    workspacePath: AbsolutePath,
  }),
  Schema.Struct({
    ...CandidateFields,
    kind: Schema.Literal('repo-build-output'),
    containerPath: AbsolutePath,
    outputRoot: AbsolutePath,
    ref: Schema.optionalKey(Schema.Never),
    refType: Schema.optionalKey(Schema.Never),
    workspacePath: Schema.optionalKey(Schema.Never),
  }),
]).annotate({ identifier: 'Megarepo.BuildOutputBudgetCandidate' })
export type BudgetCandidate = typeof BudgetCandidate.Type
type Mutable<TValue> = { -readonly [TKey in keyof TValue]: TValue[TKey] }
type MutableCandidate = Mutable<BudgetCandidate>
/** Per-class allocated-byte accounting, reclamation and safety summary. */
export const BudgetClassSummary = Schema.Struct({
  totalBytes: Bytes,
  budgetBytes: Bytes,
  idleCandidateBytes: Bytes,
  evictedBytes: Bytes,
  projectedBytes: Bytes,
  keptByReason: Schema.Record(Schema.String, Bytes),
  scanStatus: Schema.Literals(['complete', 'scan-incomplete']),
  status: Schema.Literals(['within-budget', 'over-budget-no-idle-candidate']),
})
/** Plan-hash-bound budget dry-run or single-root apply receipt. */
export const BudgetPlan = Schema.Struct({
  schemaVersion: Schema.Literal('megarepo.build-output-budget-plan.v2'),
  planSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  results: Schema.Array(BudgetCandidate),
  classes: Schema.Record(Schema.String, BudgetClassSummary),
}).annotate({ identifier: 'Megarepo.BuildOutputBudgetPlan' })
export type BudgetPlan = typeof BudgetPlan.Type

/** Invalid policy or changed safety evidence refuses reclamation. */
export class BuildOutputBudgetError extends Schema.TaggedError<BuildOutputBudgetError>()(
  'BuildOutputBudgetError',
  {
    message: Schema.String,
  },
) {}
const fail = (message: string) => new BuildOutputBudgetError({ message })

/** The receipt binds lifecycle teardown to the exact policy file bytes decoded. */
export const loadBuildOutputBudgetPolicyReceipt = Effect.fn(
  'store.loadBuildOutputBudgetPolicyReceipt',
)(function* ({ path }: { path: string }) {
  const fs = yield* FileSystem.FileSystem
  const content = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError(() => fail(`Cannot read build-output budget policy: ${path}`)))
  const policy = yield* Schema.decodeEffect(Schema.fromJsonString(BuildOutputBudgets), {
    onExcessProperty: 'error',
  })(content).pipe(
    Effect.mapError(() => fail(`Cannot decode megarepo.build-output-budgets.v2 policy: ${path}`)),
  )
  const patterns = new Map<string, string>()
  for (const [name, entry] of Object.entries(policy.classes)) {
    if (entry.paths === undefined && entry.repoRoots === undefined)
      return yield* fail(`Budget class ${name} has no root selector`)
    for (const pattern of [
      ...(entry.paths ?? []),
      ...(entry.repoRoots === undefined ? [] : [`repo:${entry.repoRoots}`]),
    ]) {
      const owner = patterns.get(pattern)
      if (owner !== undefined && owner !== name)
        return yield* fail(`Budget path ${pattern} belongs to multiple classes`)
      patterns.set(pattern, name)
    }
  }
  if (Object.keys(policy.classes).length === 0)
    return yield* fail('Budget policy contains no classes')
  if (policy.host !== hostname() && policy.host !== `host/${hostname()}`)
    return yield* fail('Budget policy belongs to another host')
  return {
    policy,
    policyPath: path,
    policySha256: createHash('sha256').update(content).digest('hex'),
  }
})

/** Decode the strict host budgets policy without lifecycle provenance metadata. */
export const loadBuildOutputBudgets = Effect.fn('store.loadBuildOutputBudgets')(function* ({
  path,
}: {
  path: string
}) {
  const receipt = yield* loadBuildOutputBudgetPolicyReceipt({ path })
  return receipt.policy
})

/** Store inventory consumed by discovery and budget accounting. */
export type BudgetRepoWorktrees = ReadonlyArray<{
  readonly repo: { readonly relativePath: string }
  readonly censusIncomplete?: boolean
  readonly worktrees: ReadonlyArray<{
    readonly ref: string
    readonly refType: 'heads' | 'tags' | 'commits' | 'symbolic'
    readonly path: AbsoluteDirPath
    readonly broken: boolean
    readonly requiresExpandedProcessCoverage?: boolean
  }>
}>

const ENTRY_LIMIT = 100_000
const SCAN_DEADLINE_MS = 30_000
const fingerprint = ({
  path,
  info,
  directory = info.isDirectory() === true ? readDirectoryEvidence(path) : undefined,
}: {
  path: string
  info: BigIntStats
  directory?: DirectoryEvidence | undefined
}): string =>
  `${directory?.overlay === true ? `mount:${directory.mountId}` : `${info.dev}:${info.ino}`}:${info.mode}:${info.size}:${info.blocks}:${info.nlink}:${info.mtimeNs}:${info.ctimeNs}`
// Array sorting requires a positional comparator.
// eslint-disable-next-line overeng/named-args
const comparePaths = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
/** Serialize the complete typed receipt together with opaque policy/admission evidence. */
export const encodeBudgetPlanEvidence = (
  evidence: Omit<BudgetPlan, 'planSha256'> & Readonly<Record<string, unknown>>,
): string => encode(evidence)
// The candidate fingerprint also binds every ancestor's persisted deletion evidence.
const deletionFingerprint = ({
  artifactFingerprint,
  identity,
}: {
  artifactFingerprint: string
  identity: DeletionIdentity
}): string => createHash('sha256').update(encode({ artifactFingerprint, identity })).digest('hex')

/** Persisted Git admission evidence is recaptured even under the deletion lease. */
const worktreeAdmissionIdentity = Effect.fn('store.worktreeAdmissionIdentity')(function* ({
  owner,
  barePath,
}: {
  owner: string
  barePath: string
}) {
  const fs = yield* FileSystem.FileSystem
  const bare = yield* fs.realPath(barePath)
  const dotGit = `${owner}/.git`
  const pointer = yield* fs.readFileString(dotGit)
  if (pointer.startsWith('gitdir: ') === false) return yield* fail('Missing worktree gitdir')
  const gitdir = yield* fs.realPath(resolve(owner, pointer.slice(8).trim()))
  const backlink = yield* fs.readFileString(`${gitdir}/gitdir`)
  const common = yield* fs.readFileString(`${gitdir}/commondir`)
  if (
    (yield* fs.realPath(resolve(gitdir, backlink.trim()))) !== dotGit ||
    (yield* fs.realPath(resolve(gitdir, common.trim()))) !== bare
  )
    return yield* fail('Worktree admission ownership changed')
  const evidence = yield* Effect.forEach(
    [dotGit, `${gitdir}/gitdir`, `${gitdir}/commondir`, `${gitdir}/HEAD`],
    (path) =>
      Effect.gen(function* () {
        const content = yield* fs.readFileString(path)
        const info = yield* Effect.tryPromise(() => lstat(path, { bigint: true }))
        if (info.isFile() === false) return yield* fail('Worktree admission is not a regular file')
        return { path, content, identity: fingerprint({ path, info }) }
      }),
  )
  const info = yield* Effect.tryPromise(() => lstat(bare, { bigint: true }))
  return createHash('sha256')
    .update(
      encode({
        bare,
        gitdir,
        bareIdentity: `${info.dev}:${info.ino}:${info.birthtimeNs}`,
        evidence,
      }),
    )
    .digest('hex')
})

/** Native lstat is required: the platform FileSystem stat does not expose allocated blocks. */
const boundedScan = <TScanResult>({
  deadlineAt,
  scan,
}: {
  deadlineAt: number
  scan: (context: {
    inspect: (path: string) => Promise<BigIntStats>
    children: (path: string) => Promise<ReadonlyArray<string>>
  }) => Promise<TScanResult>
}) =>
  Effect.callback<TScanResult | undefined>((resume) => {
    let stopped = false
    let count = 0
    const directories = new Set<Dir>()
    const finish = (value: TScanResult | undefined) => {
      if (stopped === true) return
      stopped = true
      clearTimeout(timer)
      for (const directory of directories) void directory.close().catch(() => undefined)
      directories.clear()
      resume(Effect.succeed(value))
    }
    const timer = setTimeout(() => finish(undefined), Math.max(0, deadlineAt - performance.now()))
    const check = () => {
      if (stopped === true || performance.now() >= deadlineAt || ++count > ENTRY_LIMIT)
        throw fail('Budget scan incomplete')
    }
    void scan({
      inspect: async (path) => {
        check()
        return lstat(path, { bigint: true })
      },
      children: async (path) => {
        check()
        const directory = await opendir(path)
        directories.add(directory)
        const children: string[] = []
        try {
          while (true) {
            check()
            // eslint-disable-next-line no-await-in-loop
            const entry = await directory.read()
            if (entry === null) break
            children.push(join(path, entry.name))
          }
        } finally {
          directories.delete(directory)
          await directory.close().catch(() => undefined)
        }
        return children.toSorted(comparePaths)
      },
    }).then(finish, () => finish(undefined))
    return Effect.sync(() => {
      stopped = true
      clearTimeout(timer)
      for (const directory of directories) void directory.close().catch(() => undefined)
      directories.clear()
    })
  })

const cargoOutputAuthority = (path: string) =>
  Effect.tryPromise(async () => {
    const marker = `${path}/CACHEDIR.TAG`
    if ((await lstat(marker)).isFile() === false) return false
    const file = await open(
      marker,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      if ((await file.stat()).isFile() === false) return false
      const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(44), position: 0 })
      return (
        buffer.toString('utf8', 0, bytesRead) === 'Signature: 8a477f597d28d172789f06886806bc55\n'
      )
    } finally {
      await file.close()
    }
  }).pipe(Effect.orElseSucceed(() => false))

const repoAdmissionIdentity = Effect.fn('store.repoAdmissionIdentity')(function* ({
  store,
  container,
}: {
  store: string
  container: string
}) {
  const fs = yield* FileSystem.FileSystem
  const identity = yield* captureDeletionIdentity({ rootPath: store, path: `${container}/.bare` })
  const registrations = yield* Git.listWorktrees(`${container}/.bare`)
  const worktrees = yield* Effect.forEach(registrations, (entry) =>
    fs.realPath(entry.path).pipe(Effect.orElseSucceed(() => entry.path)),
  )
  const registryPath = `${container}/.bare/worktrees`
  const registry =
    (yield* fs.exists(registryPath)) === true
      ? fingerprint({
          path: registryPath,
          info: yield* Effect.tryPromise(() => lstat(registryPath, { bigint: true })),
        })
      : 'missing'
  return {
    identity: createHash('sha256')
      .update(encode({ identity, registrations, registry }))
      .digest('hex'),
    worktrees,
  }
})

const repoOutputActive = ({
  activity,
  container,
  output,
}: {
  activity: BudgetWorkspaceActivity
  container: string
  output: string
}) => {
  if (isWorkspaceActive({ activity, canonicalWorktree: output }) === true) return true
  for (const path of activity.activePaths)
    if (isInsideWorktree({ candidate: path, worktreePath: container }) === true) return true
  return false
}

const discoverRepoOutputs = ({
  container,
  worktrees,
  deadlineAt,
}: {
  container: string
  worktrees: ReadonlyArray<string>
  deadlineAt: number
}) =>
  boundedScan({
    deadlineAt,
    scan: async ({ inspect, children }) => {
      const before = fingerprint({ path: container, info: await inspect(container) })
      const mount = readDirectoryEvidence(container).mountId
      const matches: string[] = []
      for (const path of await children(container)) {
        // eslint-disable-next-line no-await-in-loop
        const info = await inspect(path)
        if (
          path.endsWith('-target') === false ||
          info.isDirectory() === false ||
          info.isSymbolicLink() === true ||
          readDirectoryEvidence(path).mountId !== mount ||
          worktrees.some(
            (owner) =>
              isInsideWorktree({ candidate: path, worktreePath: owner }) ||
              isInsideWorktree({ candidate: owner, worktreePath: path }),
          ) === true
        )
          continue
        matches.push(path)
      }
      if (fingerprint({ path: container, info: await inspect(container) }) !== before)
        throw fail('Repository output census changed')
      return matches
    },
  })

const discoverRoots = ({
  workspacePath,
  policy,
  deadlineAt,
}: {
  workspacePath: string
  policy: BuildOutputBudgets
  deadlineAt: number
}) =>
  boundedScan({
    deadlineAt,
    scan: async ({ inspect, children }) => {
      const root = readDirectoryEvidence(workspacePath)
      const matches: Array<{ path: string; artifactClass: string }> = []
      const snapshots = new Map<string, string>()
      const pending = [workspacePath]
      const configuredClasses = Object.entries(policy.classes).filter(
        ([, entry]) => entry.paths !== undefined,
      )
      if (configuredClasses.length === 0) return matches
      while (pending.length > 0) {
        const path = pending.pop()!
        // eslint-disable-next-line no-await-in-loop
        const info = await inspect(path)
        const rel = relative(workspacePath, path)
        if (
          rel === '.git' ||
          rel.endsWith('/.git') === true ||
          rel === 'tmp/worklog' ||
          rel.startsWith('tmp/worklog/') === true
        )
          continue
        let artifactClass: string | undefined
        for (const [name, entry] of configuredClasses) {
          if (
            (entry.paths ?? []).some((pattern) =>
              pattern.startsWith('**/') === true
                ? rel.slice(rel.lastIndexOf('/') + 1) === pattern.slice(3)
                : rel === pattern,
            ) === false
          )
            continue
          if (artifactClass !== undefined) throw fail('Ambiguous budget root')
          artifactClass = name
        }
        if (artifactClass !== undefined) {
          matches.push({ path, artifactClass })
          continue
        }
        if (info.isDirectory() === false || info.isSymbolicLink() === true) continue
        const directory = readDirectoryEvidence(path)
        if (directory.mountId !== root.mountId) continue
        snapshots.set(path, fingerprint({ path, info, directory }))
        // eslint-disable-next-line no-await-in-loop
        pending.push(...(await children(path)))
      }
      for (const [path, observed] of snapshots) {
        // eslint-disable-next-line no-await-in-loop
        if (fingerprint({ path, info: await inspect(path) }) !== observed)
          throw fail('Discovery changed during scan')
      }
      return matches.toSorted((left, right) => comparePaths(left.path, right.path))
    },
  })

type ArtifactScan = {
  readonly inodes: ReadonlyMap<string, number>
  readonly newestMtimeMs: number
  readonly fingerprint: string
  readonly symlink: boolean
}
const scanRoot = ({
  path,
  workspacePath,
  policy,
  deadlineAt,
}: {
  path: string
  workspacePath: string
  policy: BuildOutputBudgets
  deadlineAt: number
}) =>
  boundedScan<ArtifactScan>({
    deadlineAt,
    scan: async ({ inspect, children }) => {
      const root = await inspect(path)
      const rootDirectory = readDirectoryEvidence(path)
      const workspace = readDirectoryEvidence(workspacePath)
      if (rootDirectory.mountId !== workspace.mountId) throw fail('Budget root is a mount point')
      if (root.isDirectory() === false || root.isSymbolicLink() === true)
        throw fail('Budget root is not a directory')
      const pending = [path]
      const snapshots = new Map<string, string>()
      const inodes = new Map<string, number>()
      let newestMtimeMs = 0
      let symlink = false
      const patterns = Object.values(policy.classes).flatMap((entry) => entry.paths ?? [])
      while (pending.length > 0) {
        const current = pending.pop()!
        // eslint-disable-next-line no-await-in-loop
        const info = await inspect(current)
        if (current !== path && (info.isDirectory() === true || info.isSymbolicLink() === true)) {
          const rel = relative(workspacePath, current)
          if (
            patterns.some((pattern) =>
              pattern.startsWith('**/') === true
                ? rel.slice(rel.lastIndexOf('/') + 1) === pattern.slice(3)
                : rel === pattern,
            ) === true
          )
            throw fail('Artifact contains another class root')
        }
        const directory = info.isDirectory() === true ? readDirectoryEvidence(current) : undefined
        if (directory !== undefined && directory.mountId !== rootDirectory.mountId)
          throw fail('Budget root crosses a mount point')
        const allocated = Number(info.blocks * 512n)
        if (Number.isSafeInteger(allocated) === false || allocated < 0)
          throw fail('Allocated bytes overflow')
        // Directories cannot be hardlinked; overlay inode numbers may be recycled after
        // dentry eviction, so key these by mount/path instead of aliasing distinct directories.
        inodes.set(
          directory?.overlay === true
            ? `directory:${directory.mountId}:${current}`
            : `${info.dev}:${info.ino}`,
          allocated,
        )
        snapshots.set(current, fingerprint({ path: current, info, directory }))
        newestMtimeMs = Math.max(newestMtimeMs, Number(info.mtimeNs) / 1_000_000)
        if (info.isSymbolicLink() === true) symlink = true
        if (info.isDirectory() === true) {
          // eslint-disable-next-line no-await-in-loop
          const entries = await children(current)
          if (entries.some((entry) => entry.endsWith('/.git')) === true)
            throw fail('Artifact contains a git boundary')
          pending.push(...entries)
        }
      }
      const hash = createHash('sha256')
      for (const [entry, observed] of [...snapshots].toSorted(([left], [right]) =>
        comparePaths(left, right),
      )) {
        // eslint-disable-next-line no-await-in-loop
        if (fingerprint({ path: entry, info: await inspect(entry) }) !== observed)
          throw fail('Artifact changed during scan')
        hash.update(encode([relative(path, entry), observed]))
      }
      return { inodes, newestMtimeMs, fingerprint: hash.digest('hex'), symlink }
    },
  })

const unknownReasons: Record<string, true> = {
  'lease-unknown': true,
  'agent-liveness-unavailable': true,
  'process-liveness-unavailable': true,
  'artifact-tracked-unknown': true,
  'artifact-ignore-unknown': true,
  'artifact-scan-incomplete': true,
  'scan-incomplete': true,
}
const totalInodes = (inodes: ReadonlyMap<string, number>): number => {
  let total = 0
  for (const bytes of inodes.values()) total += bytes
  return total
}

/** Discover bounded output roots and select deterministic proven-idle LRU eviction. */
export const planBuildOutputBudgets = Effect.fn('store.planBuildOutputBudgets')(function* ({
  policy,
  storeBasePath,
  repoWorktrees,
  liveSet,
  activity,
  now,
  ignoreLeaseOwner,
}: {
  policy: BuildOutputBudgets
  storeBasePath: AbsoluteDirPath
  repoWorktrees: BudgetRepoWorktrees
  liveSet: StoreLiveSet
  activity: BudgetWorkspaceActivity | undefined
  now: number
  ignoreLeaseOwner?: string | undefined
}) {
  if ((yield* storeDeletionPlatform) !== 'linux')
    return yield* fail('unsupported-platform: build-output budgets require Linux pinned deletion')
  const fs = yield* FileSystem.FileSystem
  const canonicalStore = yield* fs.realPath(storeBasePath)
  const admittedRoots = yield* Effect.forEach(policy.storeRoots, (root) =>
    fs.realPath(root).pipe(Effect.orElseSucceed(() => undefined)),
  )
  if (admittedRoots.some((root) => root === canonicalStore) === false)
    return yield* fail('Current store is not admitted by budget policy')
  const coveredStore =
    activity?.processCoverage?.roots.some((root) =>
      isInsideWorktree({ candidate: canonicalStore, worktreePath: root }),
    ) === true
  // Capture once per plan, not once per worktree. Apply still probes the
  // selected owner freshly under the deletion lease.
  const processScan = yield* readProcessReferences({
    fs,
    selfPid: process.pid,
    scope: coveredStore === true ? 'own-uid' : 'all-uids',
    ...(coveredStore === true
      ? { coveredProcesses: activity?.processCoverage?.processIdentities }
      : {}),
  })
  const deadlineAt = performance.now() + SCAN_DEADLINE_MS
  const results: MutableCandidate[] = []
  const admissions: Array<{ owner: string; identity: string }> = []
  const inodeRoots = new Map<string, Map<string, { bytes: number; roots: Set<string> }>>()
  const incomplete = new Set<string>()
  for (const name of Object.keys(policy.classes)) inodeRoots.set(name, new Map())
  for (const { repo, worktrees, censusIncomplete } of repoWorktrees) {
    if (censusIncomplete === true)
      for (const name of Object.keys(policy.classes)) incomplete.add(name)
    for (const worktree of worktrees) {
      if (worktree.broken === true) {
        for (const name of Object.keys(policy.classes)) incomplete.add(name)
        continue
      }
      const canonicalOwner = yield* fs
        .realPath(worktree.path)
        .pipe(Effect.orElseSucceed(() => undefined))
      if (
        canonicalOwner === undefined ||
        isInsideWorktree({ candidate: canonicalOwner, worktreePath: canonicalStore }) === false
      ) {
        for (const name of Object.keys(policy.classes)) incomplete.add(name)
        continue
      }
      const admissionIdentity = yield* worktreeAdmissionIdentity({
        owner: canonicalOwner,
        barePath: join(canonicalStore, repo.relativePath, '.bare'),
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (admissionIdentity === undefined) {
        for (const name of Object.keys(policy.classes)) incomplete.add(name)
        continue
      }
      admissions.push({ owner: canonicalOwner, identity: admissionIdentity })
      const roots = yield* discoverRoots({ workspacePath: canonicalOwner, policy, deadlineAt })
      if (roots === undefined) {
        for (const name of Object.keys(policy.classes)) incomplete.add(name)
        continue
      }
      // Record the complete absolute chain before any root's retention/authority predicates.
      const rootsWithIdentity = yield* Effect.forEach(roots, (root) =>
        captureDeletionIdentity({ rootPath: canonicalStore, path: root.path }).pipe(
          Effect.orElseSucceed(() => undefined),
          Effect.map((identity) => ({ ...root, identity })),
        ),
      )
      const holder =
        processScan._tag === 'complete'
          ? processScan.references.find((entry) =>
              isInsideWorktree({ candidate: entry.path, worktreePath: canonicalOwner }),
            )
          : undefined
      const lease =
        canonicalOwner === ignoreLeaseOwner
          ? false
          : yield* fs
              .exists(deletionLeasePath({ storeBasePath, ownerPath: canonicalOwner }))
              .pipe(Effect.orElseSucceed(() => undefined))
      for (const root of rootsWithIdentity) {
        const scan = yield* scanRoot({
          path: root.path,
          workspacePath: canonicalOwner,
          policy,
          deadlineAt,
        })
        if (root.identity === undefined || scan === undefined || scan.symlink === true)
          incomplete.add(root.artifactClass)
        const canonicalRoot = yield* fs
          .realPath(root.path)
          .pipe(Effect.orElseSucceed(() => undefined))
        const contained =
          canonicalRoot === root.path &&
          isInsideWorktree({ candidate: root.path, worktreePath: canonicalOwner })
        const rel = relative(canonicalOwner, root.path)
        const tracked = yield* Git.hasTrackedFiles({ cwd: worktree.path, path: rel }).pipe(
          Effect.orElseSucceed(() => undefined),
        )
        const ignored = yield* Git.runCommand({
          args: ['check-ignore', '--quiet', '--', rel],
          cwd: worktree.path,
        }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.succeed(
              error instanceof Git.GitCommandError && error.exitCode === 1 ? false : undefined,
            ),
          ),
        )
        const reason: typeof BudgetReason.Type =
          root.identity === undefined ||
          scan === undefined ||
          contained === false ||
          scan.symlink === true
            ? 'artifact-scan-incomplete'
            : activity === undefined
              ? 'agent-liveness-unavailable'
              : processScan._tag === 'unknown'
                ? 'process-liveness-unavailable'
                : holder !== undefined ||
                    isWorkspaceActive({ activity, canonicalWorktree: canonicalOwner }) === true ||
                    isPathProtected({ liveSet, path: worktree.path }) === true
                  ? 'live'
                  : lease === undefined
                    ? 'lease-unknown'
                    : lease === true
                      ? 'lease-held'
                      : tracked === undefined
                        ? 'artifact-tracked-unknown'
                        : tracked === true
                          ? 'artifact-tracked'
                          : ignored === undefined
                            ? 'artifact-ignore-unknown'
                            : ignored === false
                              ? 'artifact-not-ignored'
                              : now - scan.newestMtimeMs < policy.idleRetentionMs
                                ? 'retention'
                                : worktree.requiresExpandedProcessCoverage === true &&
                                    activity.processWorktreeCoverage !== 'registered-worktrees'
                                  ? 'process-liveness-unavailable'
                                  : 'eligible'
        const candidate: MutableCandidate = {
          kind: 'worktree',
          livenessKey: canonicalOwner,
          admissionIdentity,
          repo: repo.relativePath,
          ref: worktree.ref,
          refType: worktree.refType,
          path: root.path,
          workspacePath: canonicalOwner,
          artifactClass: root.artifactClass,
          allocatedBytes: scan === undefined ? 0 : totalInodes(scan.inodes),
          reclaimableBytes: 0,
          mtimeMs: scan?.newestMtimeMs ?? 0,
          fingerprint:
            root.identity === undefined || scan === undefined
              ? ''
              : deletionFingerprint({
                  artifactFingerprint: scan.fingerprint,
                  identity: root.identity,
                }),
          reason,
          outcome: unknownReasons[reason] === true ? 'unknown' : 'keep',
        }
        results.push(candidate)
        if (scan !== undefined) {
          const classInodes = inodeRoots.get(root.artifactClass)!
          for (const [id, bytes] of scan.inodes) {
            const existing = classInodes.get(id)
            if (existing !== undefined && existing.bytes !== bytes)
              incomplete.add(root.artifactClass)
            if (existing === undefined) classInodes.set(id, { bytes, roots: new Set([root.path]) })
            else existing.roots.add(root.path)
          }
        }
      }
    }
    const selectedClass = Object.entries(policy.classes).find(
      ([, config]) => config.repoRoots !== undefined,
    )
    if (selectedClass === undefined) continue
    const [artifactClass] = selectedClass
    const container = resolve(canonicalStore, repo.relativePath)
    const admission = yield* repoAdmissionIdentity({ store: canonicalStore, container }).pipe(
      Effect.orElseSucceed(() => undefined),
    )
    const roots =
      admission === undefined
        ? undefined
        : yield* discoverRepoOutputs({
            container,
            worktrees: admission.worktrees,
            deadlineAt,
          })
    if (roots === undefined || admission === undefined) {
      incomplete.add(artifactClass)
      continue
    }
    const admissionIdentity = admission.identity
    admissions.push({ owner: container, identity: admissionIdentity })
    const lease =
      container === ignoreLeaseOwner
        ? false
        : yield* fs
            .exists(deletionLeasePath({ storeBasePath, ownerPath: container }))
            .pipe(Effect.orElseSucceed(() => undefined))
    for (const path of roots) {
      const identity = yield* captureDeletionIdentity({ rootPath: canonicalStore, path }).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      const scan = yield* scanRoot({ path, workspacePath: container, policy, deadlineAt })
      const authority = yield* cargoOutputAuthority(path)
      const reason: typeof BudgetReason.Type =
        identity === undefined || scan === undefined || scan.symlink === true
          ? 'artifact-scan-incomplete'
          : activity === undefined
            ? 'agent-liveness-unavailable'
            : authority === false
              ? 'artifact-authority-missing'
              : repoOutputActive({ activity, container, output: path }) === true ||
                  (processScan._tag === 'complete' &&
                    processScan.references.some((entry) =>
                      isInsideWorktree({ candidate: entry.path, worktreePath: path }),
                    ) === true)
                ? 'live'
                : processScan._tag === 'unknown' ||
                    activity.processWorktreeCoverage !== 'registered-worktrees' ||
                    activity.processRepoOutputCoverage !== 'repo-build-outputs'
                  ? 'process-liveness-unavailable'
                  : lease === undefined
                    ? 'lease-unknown'
                    : lease === true
                      ? 'lease-held'
                      : now - scan.newestMtimeMs < policy.idleRetentionMs
                        ? 'retention'
                        : 'eligible'
      if (scan === undefined || identity === undefined || scan.symlink === true)
        incomplete.add(artifactClass)
      results.push({
        kind: 'repo-build-output',
        containerPath: container,
        outputRoot: path,
        livenessKey: path,
        admissionIdentity,
        path,
        artifactClass,
        allocatedBytes: scan === undefined ? 0 : totalInodes(scan.inodes),
        reclaimableBytes: 0,
        mtimeMs: scan?.newestMtimeMs ?? 0,
        fingerprint:
          scan === undefined || identity === undefined
            ? ''
            : deletionFingerprint({ artifactFingerprint: scan.fingerprint, identity }),
        reason,
        outcome: unknownReasons[reason] === true ? 'unknown' : 'keep',
      })
      if (scan === undefined) continue
      const classInodes = inodeRoots.get(artifactClass)!
      for (const [id, bytes] of scan.inodes) {
        const existing = classInodes.get(id)
        if (existing !== undefined && existing.bytes !== bytes) incomplete.add(artifactClass)
        if (existing === undefined) classInodes.set(id, { bytes, roots: new Set([path]) })
        else existing.roots.add(path)
      }
    }
  }
  const classSummaries = new Map<string, typeof BudgetClassSummary.Type>()
  for (const [name, config] of Object.entries(policy.classes)) {
    const classInodes = inodeRoots.get(name)!
    const candidates = results.filter((row) => row.artifactClass === name)
    const idle = candidates
      .filter((row) => row.reason === 'eligible')
      .toSorted(
        (left, right) => left.mtimeMs - right.mtimeMs || comparePaths(left.path, right.path),
      )
    const idlePaths = new Set(idle.map((row) => row.path))
    const candidatesByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]))
    const candidateInodes = new Map<string, Array<{ bytes: number; roots: Set<string> }>>()
    for (const candidate of candidates) candidateInodes.set(candidate.path, [])
    let totalBytes = 0
    let idleCandidateBytes = 0
    for (const inode of classInodes.values()) {
      totalBytes += inode.bytes
      let allIdle = true
      for (const path of inode.roots) {
        if (idlePaths.has(path) === false) allIdle = false
        candidateInodes.get(path)!.push(inode)
        if (inode.roots.size === 1) candidatesByPath.get(path)!.reclaimableBytes += inode.bytes
      }
      if (allIdle === true) idleCandidateBytes += inode.bytes
    }
    if (Number.isSafeInteger(totalBytes) === false)
      return yield* fail('Class allocated byte count overflows safe integer')
    let projectedBytes = totalBytes
    const scanStatus =
      incomplete.has(name) === true ? ('scan-incomplete' as const) : ('complete' as const)
    for (const candidate of idle) {
      if (scanStatus === 'scan-incomplete') {
        candidate.reason = 'scan-incomplete'
        candidate.outcome = 'unknown'
        continue
      }
      if (projectedBytes <= config.budgetBytes) {
        candidate.reason = 'within-budget'
        continue
      }
      candidate.outcome = 'would-delete'
      // Only the final owning root releases a hardlinked inode's allocation.
      for (const inode of candidateInodes.get(candidate.path)!) {
        inode.roots.delete(candidate.path)
        if (inode.roots.size === 0) projectedBytes -= inode.bytes
      }
    }
    const keptByReason: Record<string, number> = {}
    for (const candidate of candidates) {
      if (
        candidate.outcome === 'would-delete' ||
        candidate.reason === 'scan-incomplete' ||
        candidate.reason === 'artifact-scan-incomplete'
      )
        continue
      keptByReason[candidate.reason] = (keptByReason[candidate.reason] ?? 0) + 1
    }
    classSummaries.set(name, {
      totalBytes,
      budgetBytes: config.budgetBytes,
      idleCandidateBytes,
      evictedBytes: 0,
      projectedBytes,
      keptByReason,
      scanStatus,
      status:
        projectedBytes <= config.budgetBytes ? 'within-budget' : 'over-budget-no-idle-candidate',
    })
  }
  const classes = Object.fromEntries(classSummaries)
  const sorted = results.toSorted((left, right) => comparePaths(left.path, right.path))
  const planSha256 = createHash('sha256')
    .update(
      encodeBudgetPlanEvidence({
        schemaVersion: 'megarepo.build-output-budget-plan.v2',
        policy,
        activityEpoch: activity?.epoch,
        processWorktreeCoverage: activity?.processWorktreeCoverage,
        processRepoOutputCoverage: activity?.processRepoOutputCoverage,
        census: repoWorktrees
          .map(({ repo, worktrees, censusIncomplete }) => ({
            repo: repo.relativePath,
            censusIncomplete: censusIncomplete === true,
            worktrees: worktrees.toSorted((a, b) => comparePaths(a.path, b.path)),
          }))
          .toSorted((a, b) => comparePaths(a.repo, b.repo)),
        admissions: admissions.toSorted((a, b) => comparePaths(a.owner, b.owner)),
        results: sorted,
        classes,
      }),
    )
    .digest('hex')
  return {
    schemaVersion: 'megarepo.build-output-budget-plan.v2' as const,
    planSha256,
    results: sorted,
    classes,
  }
})

/** Revalidate the global plan and candidate under the owner's deletion lease before removal. */
export const applyBuildOutputBudgetCandidate = Effect.fn('store.applyBuildOutputBudgetCandidate')(
  function* ({
    policyPath,
    storeBasePath,
    repoWorktrees,
    liveSet,
    now,
    expectedPlan,
    candidatePath,
    activityConfig,
  }: {
    policyPath: string
    storeBasePath: AbsoluteDirPath
    repoWorktrees: BudgetRepoWorktrees
    liveSet: StoreLiveSet
    now: number
    expectedPlan: string
    candidatePath: string
    activityConfig: BudgetActivityConfig
  }) {
    if ((yield* storeDeletionPlatform) !== 'linux')
      return yield* fail('unsupported-platform: build-output budgets require Linux pinned deletion')
    const fs = yield* FileSystem.FileSystem
    const policy = yield* loadBuildOutputBudgets({ path: policyPath })
    const activity = yield* readBudgetWorkspaceActivity({ fs, config: activityConfig })
    const initial = yield* planBuildOutputBudgets({
      policy,
      storeBasePath,
      repoWorktrees,
      liveSet,
      activity,
      now,
    })
    if (initial.planSha256 !== expectedPlan)
      return yield* fail('Budget plan changed; refusing candidate application')
    const selected = initial.results.filter(
      (row) => normalize(row.path) === normalize(candidatePath) && row.outcome === 'would-delete',
    )
    if (selected.length !== 1)
      return yield* fail('Budget candidate is missing, ambiguous, or not eligible')
    const candidate = selected[0]!
    const requiresExpandedCoverage =
      candidate.kind === 'repo-build-output' ||
      repoWorktrees.some(({ worktrees }) =>
        worktrees.some(
          (worktree) =>
            worktree.path.replace(/\/+$/u, '') === candidate.workspacePath &&
            worktree.requiresExpandedProcessCoverage === true,
        ),
      )
    const deletionRoot = yield* fs.realPath(storeBasePath)
    const identity = yield* captureDeletionIdentity({
      rootPath: deletionRoot,
      path: candidate.path,
    })
    const ownerPath = yield* canonicalizeOwnerPath(
      candidate.kind === 'worktree' ? candidate.workspacePath : candidate.containerPath,
    )
    return yield* Effect.gen(function* () {
      const freshPolicy = yield* loadBuildOutputBudgets({ path: policyPath })
      const freshActivity = yield* readBudgetWorkspaceActivity({
        fs,
        config: activityConfig,
        ...(activity === undefined ? {} : { admittedEpoch: activity.epoch }),
      })
      const freshNow = yield* Clock.currentTimeMillis
      const fresh = yield* planBuildOutputBudgets({
        policy: freshPolicy,
        storeBasePath,
        repoWorktrees,
        liveSet,
        activity: freshActivity,
        now: freshNow,
        ignoreLeaseOwner: ownerPath,
      })
      if (fresh.planSha256 !== expectedPlan)
        return yield* fail('Budget plan changed under deletion lease; refusing deletion')
      const current = fresh.results.find(
        (row) => row.path === candidate.path && row.outcome === 'would-delete',
      )
      if (current === undefined) return yield* fail('Budget candidate no longer eligible')
      const removal = yield* withGcPinnedDeletion({
        rootPath: deletionRoot,
        path: current.path,
        identity,
        beforeRemove: () =>
          Effect.gen(function* () {
            const finalScan = yield* scanRoot({
              path: current.path,
              workspacePath: ownerPath,
              policy: freshPolicy,
              deadlineAt: performance.now() + SCAN_DEADLINE_MS,
            })
            if (
              finalScan === undefined ||
              finalScan.symlink === true ||
              deletionFingerprint({ artifactFingerprint: finalScan.fingerprint, identity }) !==
                current.fingerprint ||
              freshNow - finalScan.newestMtimeMs < freshPolicy.idleRetentionMs
            )
              return yield* fail('Candidate changed before deletion')
            const canonicalRoot = yield* fs.realPath(current.path)
            const canonicalOwner = yield* fs.realPath(
              current.kind === 'worktree' ? current.workspacePath : current.containerPath,
            )
            if (
              canonicalRoot !== current.path ||
              canonicalOwner !== ownerPath ||
              isInsideWorktree({ candidate: canonicalRoot, worktreePath: canonicalOwner }) === false
            )
              return yield* fail('Budget candidate containment changed')
            const ownerDir = EffectPath.unsafe.absoluteDir(`${ownerPath}/`)
            const rel = relative(ownerPath, current.path)
            if (current.kind === 'worktree') {
              const tracked = yield* Git.hasTrackedFiles({ cwd: ownerDir, path: rel }).pipe(
                Effect.orElseSucceed(() => undefined),
              )
              const ignored = yield* Git.runCommand({
                args: ['check-ignore', '--quiet', '--', rel],
                cwd: ownerDir,
              }).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              )
              if (tracked !== false || ignored === false)
                return yield* fail('Candidate tracked/ignore predicates changed')
            } else if (
              freshPolicy.classes[current.artifactClass]?.repoRoots !== '*-target' ||
              rel.includes('/') === true ||
              rel.endsWith('-target') === false ||
              current.livenessKey !== current.path ||
              current.outputRoot !== current.path ||
              (yield* cargoOutputAuthority(current.path)) === false
            ) {
              return yield* fail('Repository output authority changed')
            }
            const finalActivity = yield* readBudgetWorkspaceActivity({
              fs,
              config: activityConfig,
              ...(freshActivity === undefined ? {} : { admittedEpoch: freshActivity.epoch }),
            })
            if (
              finalActivity === undefined ||
              (requiresExpandedCoverage === true &&
                finalActivity.processWorktreeCoverage !== 'registered-worktrees') ||
              (current.kind === 'repo-build-output' &&
                finalActivity.processRepoOutputCoverage !== 'repo-build-outputs') ||
              (current.kind === 'worktree'
                ? isWorkspaceActive({ activity: finalActivity, canonicalWorktree: ownerPath })
                : repoOutputActive({
                    activity: finalActivity,
                    container: ownerPath,
                    output: current.livenessKey,
                  })) === true
            )
              return yield* fail('Candidate activity became live or unknown')
            const finalAdmission =
              current.kind === 'worktree'
                ? yield* worktreeAdmissionIdentity({
                    owner: ownerPath,
                    barePath: join(storeBasePath, current.repo, '.bare'),
                  })
                : (yield* repoAdmissionIdentity({ store: deletionRoot, container: ownerPath }))
                    .identity
            if (finalAdmission !== current.admissionIdentity)
              return yield* fail('Candidate admission changed before deletion')
            const processState = yield* readBudgetWorktreeInUse({
              worktreePath: EffectPath.unsafe.absoluteDir(`${current.livenessKey}/`),
              activity: finalActivity,
            })
            if (processState._tag !== 'free') {
              yield* recordGcDeletion({
                storeBasePath,
                path: current.path,
                phase: 'outcome',
                decision: 'skipped-in-use',
                reason: 'Candidate process liveness is live or unknown',
                vetoEvidence:
                  processState._tag === 'in-use'
                    ? [processState.holder]
                    : [{ pid: -1, path: `unknown: ${processState.reason}` }],
              })
              return yield* fail('Candidate process liveness is live or unknown')
            }
          }),
      }).pipe(Effect.result)
      if (removal._tag === 'Failure') {
        if (removal.failure instanceof PinnedDeletionError && removal.failure.partial === true) {
          // Reclamation is unknown after an interrupted in-place overlay removal; do not
          // claim deleted bytes. The next complete plan observes the remaining root afresh.
          const summary = fresh.classes[current.artifactClass]!
          return {
            ...fresh,
            results: [
              {
                ...current,
                reclaimableBytes: 0,
                outcome: 'partial' as const,
                reason: 'deletion-partial' as const,
                message: removal.failure.message,
                ...(removal.failure.recoverPath === undefined
                  ? {}
                  : { recoverPath: removal.failure.recoverPath }),
                ...(removal.failure.code === undefined ? {} : { code: removal.failure.code }),
              },
            ],
            classes: {
              ...fresh.classes,
              [current.artifactClass]: {
                ...summary,
                evictedBytes: 0,
                projectedBytes: summary.totalBytes,
                scanStatus: 'scan-incomplete' as const,
                status:
                  summary.totalBytes <= summary.budgetBytes
                    ? ('within-budget' as const)
                    : ('over-budget-no-idle-candidate' as const),
              },
            },
          }
        }
        return yield* Effect.fail(removal.failure)
      }
      const summary = fresh.classes[current.artifactClass]!
      return {
        ...fresh,
        results: [{ ...current, outcome: 'deleted' as const }],
        classes: {
          ...fresh.classes,
          [current.artifactClass]: {
            ...summary,
            evictedBytes: current.reclaimableBytes,
            projectedBytes: summary.totalBytes - current.reclaimableBytes,
            status:
              summary.totalBytes - current.reclaimableBytes <= summary.budgetBytes
                ? ('within-budget' as const)
                : ('over-budget-no-idle-candidate' as const),
          },
        },
      }
    }).pipe(withDeletionLease({ storeBasePath, ownerPath, now }))
  },
)
