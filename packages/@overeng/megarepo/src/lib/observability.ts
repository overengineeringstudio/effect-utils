/**
 * Runtime observability surface for megarepo (lib sites). Every `megarepo.*` span/attribute is
 * DERIVED from the registered seam contract (`../megarepo.contract.ts`, namespace `megarepo`) — the
 * single SSOT for BOTH the Weaver registry projection AND these runtime encoders (SC-R13/R14).
 * This file holds only the runtime wrappers (attribute shaping, root-span selection) plus:
 *   - DYNAMIC-NAME BRIDGES (span name varies at runtime → no stable single-signal projection) that
 *     stay legacy inline, rebuilt from the IMPORTED catalog schema objects (identical encode).
 *   - ANNOTATE-ONLY bundles (annotate the current span with a disjoint result subset), likewise
 *     rebuilt from the imported catalog schemas.
 *   - FOREIGN-NAMESPACE spans (`git.*`, `nix.*`) that are OUT of the `megarepo` namespace's scope
 *     and stay legacy inline `OtelOperation.define` bridges; their attribute keys are catalogued in
 *     the `git`/`nix` namespace seams (`../git.contract.ts`, `../nix.contract.ts`) and the encoders
 *     below rebuild from those IMPORTED catalog schemas (identical encode).
 */
import { Effect, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  OtelSpan,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import {
  GitBare,
  GitBranch,
  GitCommit,
  GitOutputBytes,
  GitOutputLines,
  GitStreamed,
  GitSubcommand,
  GitTimeoutMs,
  GitUrl,
} from '../git.contract.ts'
import {
  ArchiveWorktreeOperation,
  AssessLosslessOperation,
  ColdReclaimRepoOperation,
  GitDeleteBranchOperation,
  GitDetachWorktreeHeadOperation,
  MegarepoRepoPath,
  MegarepoStoreHasCurrentWorkspace,
  MegarepoStorePruneStaleRegistry,
  MegarepoStoreRefreshCurrentWorkspace,
  MegarepoSyncMemberAction,
  MegarepoSyncMemberResultStatus,
  MegarepoTestStoreFixturePhase,
  MegarepoTestStoreFixtureRepo,
  MegarepoTraversalCyclesSkipped,
  MegarepoTraversalMaxDepth,
  MegarepoTraversalNodesVisited,
  MegarepoWorkspaceRoot,
  MegarepoWorktreePath,
  ReapArchiveOperation,
  ResolvePrStateOperation,
  ScanArchivesOperation,
  StoreFixtureCreateOperation,
  StoreFixtureRepoOperation,
  SyncMemberCloneOperation,
  SyncMemberCreateWorktreeOperation,
  SyncMemberOperation,
  SyncMemberResolveRefOperation,
  TraversalOperation,
  UnpushedCommitCountOperation,
} from '../megarepo.contract.ts'
import {
  NixFlakeOwner,
  NixFlakeRepo,
  NixFlakeRev,
  NixLockPath,
  NixLockSourcePath,
  NixLockSourceType,
  NixLockType,
} from '../nix.contract.ts'

const basename = (path: string): string =>
  path.split('/').findLast((part) => part.length > 0) ?? path

/** Shared runtime-only span-label field (`span.label`), filtered from the registry projection. */
const spanLabel = () => Schema.NonEmptyString.pipe(OtelAttr.spanLabel())

const trustOtelContract = <A, E, R>(
  effect: Effect.Effect<A, E | OtelAttrEncodeError, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(
    Effect.catchAll((error) =>
      typeof error === 'object' &&
      error !== null &&
      '_tag' in error &&
      error._tag === 'OtelAttrEncodeError'
        ? Effect.die(error)
        : Effect.fail(error as E),
    ),
  ) as Effect.Effect<A, E, R>

const trustedWith =
  <S extends Schema.Schema.AnyNoContext>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trustOtelContract<A, E, R>(operation.with({ attributes, effect }))

// ---- generic label-only span (foreign-free; a runtime helper, no catalog attrs) ----

const labelAttrs = OtelAttrs.defineSync(Schema.Struct({ label: spanLabel() }))

const labelOperation = (name: string) =>
  OtelOperation.define({ name, attributes: labelAttrs, label: ({ label }) => label })

/** Wrap an effect in a `<name>` span carrying only an explicit display label —
 *  the generic span helper for sites with no other structured attributes. */
export const withLabelSpan = ({ name, labelValue }: { name: string; labelValue: string }) =>
  trustedWith({ operation: labelOperation(name), attributes: { label: labelValue } })

// ---- DYNAMIC-NAME BRIDGES (megarepo.*): span name varies → stay inline, rebuilt from catalog ----

const repoPathAttrs = OtelAttrs.defineSync(
  Schema.Struct({ label: spanLabel(), repoPath: MegarepoRepoPath }),
)

/** Wrap an effect in a `<name>` span tagged with `megarepo.repo_path`; the label
 *  is the path's basename. */
export const withRepoPathSpan = ({ name, path }: { name: string; path: string }) =>
  trustedWith({
    operation: OtelOperation.define({
      name,
      attributes: repoPathAttrs,
      label: ({ label }) => label,
    }),
    attributes: { label: basename(path), repoPath: path },
  })

const worktreePathAttrs = OtelAttrs.defineSync(
  Schema.Struct({ label: spanLabel(), worktreePath: MegarepoWorktreePath }),
)

const worktreePathOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: worktreePathAttrs,
    label: ({ label }) => label,
  })

/** Wrap an effect in a `<name>` span tagged with `megarepo.worktree_path`; the
 *  label defaults to the worktree path's basename. */
export const withWorktreePathSpan = ({
  name,
  worktreePath,
  label = basename(worktreePath),
}: {
  readonly name: string
  readonly worktreePath: string
  readonly label?: string
}) => trustedWith({ operation: worktreePathOperation(name), attributes: { label, worktreePath } })

const workspaceAttrs = OtelAttrs.defineSync(
  Schema.Struct({ label: spanLabel(), workspaceRoot: MegarepoWorkspaceRoot }),
)

const workspaceOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: workspaceAttrs,
    label: ({ label }) => label,
  })

/** Wrap an effect in a `<name>` span tagged with `megarepo.workspace_root`; the
 *  label defaults to the workspace root's basename. */
export const withWorkspaceSpan = ({
  name,
  workspaceRoot,
  label = basename(workspaceRoot),
}: {
  readonly name: string
  readonly workspaceRoot: string
  readonly label?: string
}) => trustedWith({ operation: workspaceOperation(name), attributes: { label, workspaceRoot } })

const storeLiveSetAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    hasCurrentWorkspace: MegarepoStoreHasCurrentWorkspace,
    pruneStaleRegistry: MegarepoStorePruneStaleRegistry,
    refreshCurrentWorkspace: MegarepoStoreRefreshCurrentWorkspace,
  }),
)

const storeLiveSetOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: storeLiveSetAttrs,
    label: ({ label }) => label,
  })

/** Wrap the store live-set computation in a `<name>` span recording which
 *  liveness inputs (current workspace, stale-registry prune, refresh) were active. */
export const withStoreLiveSetSpan = ({
  name,
  hasCurrentWorkspace,
  pruneStaleRegistry,
  refreshCurrentWorkspace,
}: {
  readonly name: string
  readonly hasCurrentWorkspace: boolean
  readonly pruneStaleRegistry: boolean
  readonly refreshCurrentWorkspace: boolean
}) =>
  trustedWith({
    operation: storeLiveSetOperation(name),
    attributes: {
      label: 'store',
      hasCurrentWorkspace,
      pruneStaleRegistry,
      refreshCurrentWorkspace,
    },
  })

// ---- DERIVED static-name operations (re-pointed at the seam contract's `.operation` products) ----

const megarepoTraversalOperation = TraversalOperation.operation

/** Wrap a nested megarepo traversal in a span keyed by its root and purpose.
 *  Result counters are annotated after traversal completes. */
export const withMegarepoTraversalSpan = ({
  root,
  purpose,
  all,
  label = basename(root),
}: {
  readonly root: string
  readonly purpose: string
  readonly all: boolean
  readonly label?: string
}) =>
  trustedWith({
    operation: megarepoTraversalOperation,
    attributes: { label, root, purpose, all },
  })

// ANNOTATE-ONLY: traversal result counters (rebuilt from the imported catalog schemas).
const megarepoTraversalResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    nodesVisited: MegarepoTraversalNodesVisited,
    cyclesSkipped: MegarepoTraversalCyclesSkipped,
    maxDepth: MegarepoTraversalMaxDepth,
  }),
)

/** Annotate the enclosing traversal span with bounded scalar counters. */
export const annotateMegarepoTraversalResult = (
  value: Schema.Schema.Type<typeof megarepoTraversalResultAttrs.schema>,
) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({ attributes: megarepoTraversalResultAttrs, value }),
  )

const syncMemberCloneOperation = SyncMemberCloneOperation.operation

/** Wrap a member clone-or-fetch in a `megarepo/sync/member/clone-or-fetch` span;
 *  `bareExists` distinguishes the fetch path from the initial clone. */
export const withSyncMemberCloneSpan = ({
  name,
  bareExists,
}: {
  readonly name: string
  readonly bareExists: boolean
}) => trustedWith({ operation: syncMemberCloneOperation, attributes: { label: name, bareExists } })

const syncMemberResolveRefOperation = SyncMemberResolveRefOperation.operation

/** Wrap ref resolution for a member in a `megarepo/sync/member/resolve-ref` span. */
export const withSyncMemberResolveRefSpan = (ref: string) =>
  trustedWith({ operation: syncMemberResolveRefOperation, attributes: { label: ref, ref } })

const syncMemberCreateWorktreeOperation = SyncMemberCreateWorktreeOperation.operation

/** Wrap worktree creation for a member in a `megarepo/sync/member/create-worktree`
 *  span carrying the target `ref` and its `refType`. */
export const withSyncMemberCreateWorktreeSpan = ({
  ref,
  refType,
}: {
  readonly ref: string
  readonly refType: string
}) =>
  trustedWith({
    operation: syncMemberCreateWorktreeOperation,
    attributes: { label: ref, ref, refType },
  })

const syncMemberOperation = SyncMemberOperation.operation

/** Wrap the whole per-member sync in a `megarepo/sync/member` span; the enclosing
 *  span for the clone/resolve/create-worktree child spans. */
export const withSyncMemberSpan = ({
  name,
  source,
}: {
  readonly name: string
  readonly source: string
}) => trustedWith({ operation: syncMemberOperation, attributes: { label: name, name, source } })

type SyncMemberAction =
  | 'clone'
  | 'already-cloned-by-sibling'
  | 'skip-dry-run'
  | 'fetch'
  | 'fetch-missing-commit'
  | 'noop'

// ANNOTATE-ONLY: member action + result status (rebuilt from the imported catalog schemas).
const syncMemberActionAttrs = OtelAttrs.defineSync(
  Schema.Struct({ action: MegarepoSyncMemberAction }),
)

const syncMemberResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({ status: MegarepoSyncMemberResultStatus }),
)

/** Annotate the enclosing member span with the action actually taken
 *  (clone / fetch / noop / …), so the chosen path is queryable per member. */
export const annotateSyncMemberAction = (action: SyncMemberAction) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({ attributes: syncMemberActionAttrs, value: { action } }),
  )

/** Annotate the enclosing member span with the final result status string. */
export const annotateSyncMemberResult = (status: string) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({ attributes: syncMemberResultAttrs, value: { status } }),
  )

// =============================================================================
// Foreign-namespace spans (`git.*`, `nix.*`) — OUT of the `megarepo` namespace's
// scope; kept as LEGACY inline `OtelOperation.define` bridges (their names are static
// or runtime-dynamic, so no single-signal projection). Their attribute keys are now
// catalogued in the `git`/`nix` namespace seams (`../git.contract.ts`, `../nix.contract.ts`);
// the encoders below rebuild from those IMPORTED catalog schemas (identical encode — proven
// by the colocated equivalence tests) so each `git.*`/`nix.*` catalog is the single SSOT.
// =============================================================================

const gitUrlAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    url: GitUrl,
    bare: Schema.optional(GitBare),
  }),
)

/** Per-subprocess `git-cmd` span. `output.bytes`/`output.lines` are annotated
 *  AFTER the command completes — for the streaming path they come from scalar
 *  running counters (never a buffer), so the bounded-memory invariant holds. */
export const gitCmdAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    subcommand: GitSubcommand,
    streamed: GitStreamed,
    timeoutMs: Schema.optional(GitTimeoutMs),
  }),
)

const gitCmdOutputAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    outputBytes: GitOutputBytes,
    outputLines: GitOutputLines,
  }),
)

const gitBranchAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    branch: GitBranch,
  }),
)

const gitCommitAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    commit: GitCommit,
  }),
)

const gitCmdOperation = OtelOperation.define({
  name: 'git/cmd',
  attributes: gitCmdAttrs,
  label: ({ label }) => label,
})

/** Wrap a git subprocess effect in a `git/cmd` span. `args` is the raw arg list;
 *  the span label + `git.subcommand` are the first arg (e.g. `status`). */
export const withGitCmdSpan = ({
  args,
  streamed,
  timeoutMs,
}: {
  readonly args: ReadonlyArray<string>
  readonly streamed: boolean
  readonly timeoutMs?: number
}) => {
  const subcommand = args[0] ?? 'git'
  return trustedWith({
    operation: gitCmdOperation,
    attributes: {
      label: subcommand,
      subcommand,
      streamed,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  })
}

/** Annotate the enclosing `git/cmd` span with the (scalar) output size. */
export const annotateGitCmdOutput = ({
  outputBytes,
  outputLines,
}: {
  readonly outputBytes: number
  readonly outputLines: number
}) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({ attributes: gitCmdOutputAttrs, value: { outputBytes, outputLines } }),
  )

const gitUrlOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: gitUrlAttrs,
    label: ({ label }) => label,
  })

/** Wrap a git operation in a `<name>` span carrying the remote `git.url` and
 *  optional `git.bare` flag. */
export const withGitUrlSpan = ({
  name,
  label,
  url,
  bare,
}: {
  readonly name: string
  readonly label: string
  readonly url: string
  readonly bare?: boolean
}) =>
  trustedWith({
    operation: gitUrlOperation(name),
    attributes: {
      label,
      url,
      ...(bare === undefined ? {} : { bare }),
    },
  })

const gitBranchOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: gitBranchAttrs,
    label: ({ label }) => label,
  })

/** Wrap a git operation in a `<name>` span tagged + labelled with `git.branch`. */
export const withGitBranchSpan = ({
  name,
  branch,
}: {
  readonly name: string
  readonly branch: string
}) => trustedWith({ operation: gitBranchOperation(name), attributes: { label: branch, branch } })

const gitCommitOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: gitCommitAttrs,
    label: ({ label }) => label,
  })

/** Wrap a git operation in a `<name>` span carrying the resolved `git.commit`. */
export const withGitCommitSpan = ({
  name,
  label,
  commit,
}: {
  readonly name: string
  readonly label: string
  readonly commit: string
}) => trustedWith({ operation: gitCommitOperation(name), attributes: { label, commit } })

const nixFlakeMetadataAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    owner: NixFlakeOwner,
    repo: NixFlakeRepo,
    rev: NixFlakeRev,
  }),
)

const nixLockFileAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    path: NixLockPath,
    type: NixLockType,
  }),
)

// nix-lock SYNC over a source file (flake.nix / devenv.yaml). Distinct concept from the lock
// file's own `nix.lock.path`/`nix.lock.type`, so distinct `nix.lock.source_*` keys (bare `path`/
// `type` were renamed to the foreign `nix.lock.*` namespace — decision 0003 same-concept-same-key).
const nixLockPathTypeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    path: NixLockSourcePath,
    type: NixLockSourceType,
  }),
)

// nix-lock path over a (nested) lock file — the SAME concept as `nix.lock.path` (catalogued once in
// the `nix` namespace seam and referenced from both this and `nixLockFileAttrs`).
const nixLockPathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    path: NixLockPath,
  }),
)

const nixFlakeMetadataOperation = OtelOperation.define({
  name: 'fetchNixFlakeMetadata',
  attributes: nixFlakeMetadataAttrs,
  label: ({ label }) => label,
})

/** Wrap a `nix flake metadata` fetch in its span; the label is `owner/repo@rev`
 *  with the rev abbreviated to 8 chars. */
export const withNixFlakeMetadataSpan = ({
  owner,
  repo,
  rev,
}: {
  readonly owner: string
  readonly repo: string
  readonly rev: string
}) =>
  trustedWith({
    operation: nixFlakeMetadataOperation,
    attributes: {
      label: `${owner}/${repo}@${rev.slice(0, 8)}`,
      owner,
      repo,
      rev,
    },
  })

const nixLockFileOperation = OtelOperation.define({
  name: 'megarepo/nix-lock/file',
  attributes: nixLockFileAttrs,
  label: ({ label }) => label,
})

/** Wrap processing of one nix lock file in a `megarepo/nix-lock/file` span,
 *  tagged with its `nix.lock.path` and `nix.lock.type`. */
export const withNixLockFileSpan = ({
  lockPath,
  lockType,
}: {
  readonly lockPath: string
  readonly lockType: string
}) =>
  trustedWith({
    operation: nixLockFileOperation,
    attributes: {
      label: basename(lockPath),
      path: lockPath,
      type: lockType,
    },
  })

const nixLockPathTypeOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: nixLockPathTypeAttrs,
    label: ({ label }) => label,
  })

/** Wrap an effect in a `<name>` span carrying a synced source file's
 *  `nix.lock.source_path`/`nix.lock.source_type` (foreign nix namespace, inline). */
export const withNixLockPathTypeSpan = ({
  name,
  path,
  type,
}: {
  readonly name: string
  readonly path: string
  readonly type: string
}) =>
  trustedWith({
    operation: nixLockPathTypeOperation(name),
    attributes: { label: path, path, type },
  })

const nixLockPathOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: nixLockPathAttrs,
    label: ({ label }) => label,
  })

/** Wrap an effect in a `<name>` span carrying a single lock file `nix.lock.path`. */
export const withNixLockPathSpan = ({
  name,
  path,
}: {
  readonly name: string
  readonly path: string
}) => trustedWith({ operation: nixLockPathOperation(name), attributes: { label: path, path } })

// =============================================================================
// Store fixture span contracts (megarepo.*, DERIVED)
// =============================================================================

const storeFixtureCreateOperation = StoreFixtureCreateOperation.operation

/** Wrap creation of a hermetic store fixture. */
export const withStoreFixtureCreateSpan = ({ repoCount }: { readonly repoCount: number }) =>
  trustedWith({
    operation: storeFixtureCreateOperation,
    attributes: { label: 'store-fixture', repoCount },
  })

const storeFixtureRepoOperation = StoreFixtureRepoOperation.operation

/** Wrap one repository's setup inside a store fixture. */
export const withStoreFixtureRepoSpan = ({
  repo,
  branchCount,
  tagCount,
  commitCount,
  withRemote,
}: {
  readonly repo: string
  readonly branchCount: number
  readonly tagCount: number
  readonly commitCount: number
  readonly withRemote: boolean
}) =>
  trustedWith({
    operation: storeFixtureRepoOperation,
    attributes: {
      label: basename(repo),
      storeRepo: repo,
      branchCount,
      tagCount,
      commitCount,
      withRemote,
    },
  })

/** Low-cardinality setup phases for store fixture trace diagnostics. */
export type StoreFixturePhase =
  | 'init-bare'
  | 'init-upstream'
  | 'init-source'
  | 'push-refs'
  | 'fetch-store-bare'
  | 'create-worktrees'
  | 'create-commit-worktrees'

// DYNAMIC-NAME BRIDGE: span name is `megarepo/test/store-fixture/<phase>` → stays inline,
// rebuilt from the imported catalog schemas.
const storeFixturePhaseAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    phase: MegarepoTestStoreFixturePhase,
    storeRepo: MegarepoTestStoreFixtureRepo,
  }),
)

const storeFixturePhaseOperation = (phase: StoreFixturePhase) =>
  OtelOperation.define({
    name: `megarepo/test/store-fixture/${phase}`,
    attributes: storeFixturePhaseAttrs,
    label: ({ label }) => label,
  })

/** Wrap a bounded phase of one store-fixture repository setup. */
export const withStoreFixturePhaseSpan = ({
  phase,
  repo,
}: {
  readonly phase: StoreFixturePhase
  readonly repo: string
}) =>
  trustedWith({
    operation: storeFixturePhaseOperation(phase),
    attributes: { label: phase, phase, storeRepo: repo },
  })

// =============================================================================
// Store GC lib-site span contracts (megarepo.*, DERIVED)
//
// These mirror the inline `Effect.withSpan` sites previously embedded in the gc
// lib/git modules. Historically several carried UNPREFIXED attribute keys
// (`branch`, `worktreePath`, `path`, `repoRoot`, `worktreeHead`, `store.repo`,
// `store.bare_repo.path`, `reason`). Those bare keys are BREAKING-renamed to the
// namespaced `megarepo.*` catalog keys (retention-first, decision 0004); the old
// bare keys simply stop being emitted. Span NAMES are unchanged.
// =============================================================================

const gitDeleteBranchOperation = GitDeleteBranchOperation.operation

/** Wrap a `git branch -D/-d` effect in a `git/delete-branch` span. */
export const withGitDeleteBranchSpan = (branch: string) =>
  trustedWith({ operation: gitDeleteBranchOperation, attributes: { label: branch, branch } })

const gitDetachWorktreeHeadOperation = GitDetachWorktreeHeadOperation.operation

/** Wrap a `git checkout --detach` effect in a `git/detach-worktree-head` span. */
export const withGitDetachWorktreeHeadSpan = (worktreePath: string) =>
  trustedWith({
    operation: gitDetachWorktreeHeadOperation,
    attributes: { label: worktreePath, worktreePath },
  })

const archiveWorktreeOperation = ArchiveWorktreeOperation.operation

/** Wrap a cold-worktree archive move in a `megarepo/store/gc/archive-worktree` span. */
export const withArchiveWorktreeSpan = ({
  branch,
  reason,
}: {
  readonly branch: string
  readonly reason: string
}) =>
  trustedWith({
    operation: archiveWorktreeOperation,
    attributes: { label: branch, branch, reason },
  })

const scanArchivesOperation = ScanArchivesOperation.operation

/** Wrap archive enumeration in a `megarepo/store/gc/scan-archives` span. */
export const withScanArchivesSpan = (repoRoot: string) =>
  trustedWith({
    operation: scanArchivesOperation,
    attributes: { label: 'scan-archives', repoRoot },
  })

const reapArchiveOperation = ReapArchiveOperation.operation

/** Wrap an archive hard-delete in a `megarepo/store/gc/reap-archive` span. */
export const withReapArchiveSpan = (path: string) =>
  trustedWith({ operation: reapArchiveOperation, attributes: { label: 'reap-archive', path } })

const coldReclaimRepoOperation = ColdReclaimRepoOperation.operation

/** Wrap one repo's cold-reclaim pass in a `megarepo/store/gc/cold-reclaim-repo` span. */
export const withColdReclaimRepoSpan = ({
  repoRelativePath,
  bareRepoPath,
}: {
  readonly repoRelativePath: string
  readonly bareRepoPath: string
}) =>
  trustedWith({
    operation: coldReclaimRepoOperation,
    attributes: {
      label: repoRelativePath,
      storeRepo: repoRelativePath,
      bareRepoPath,
    },
  })

const resolvePrStateOperation = ResolvePrStateOperation.operation

/** Wrap a per-branch PR-state lookup in a `megarepo/store/gc/resolve-pr-state` span. */
export const withResolvePrStateSpan = (branch: string) =>
  trustedWith({ operation: resolvePrStateOperation, attributes: { label: 'pr-state', branch } })

const unpushedCommitCountOperation = UnpushedCommitCountOperation.operation

/** Wrap the unpushed-commit count in a `megarepo/store/gc/unpushed-commit-count` span. */
export const withUnpushedCommitCountSpan = (worktreeHead: string) =>
  trustedWith({
    operation: unpushedCommitCountOperation,
    attributes: {
      label: worktreeHead.slice(0, 8),
      worktreeHead,
    },
  })

const assessLosslessOperation = AssessLosslessOperation.operation

/** Wrap the lossless-floor assessment in a `megarepo/store/gc/assess-lossless` span. */
export const withAssessLosslessSpan = (worktreePath: string) =>
  trustedWith({
    operation: assessLosslessOperation,
    attributes: { label: 'lossless', worktreePath },
  })

const inUseProbeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    worktreePath: Schema.String.pipe(OtelAttr.key({ key: 'worktreePath' })),
  }),
)

const inUseProbeOperation = OtelOperation.define({
  name: 'megarepo/store/gc/inuse-probe',
  attributes: inUseProbeAttrs,
  label: ({ label }) => label,
})

/** Wrap the live-process in-use probe (`/proc` scan) in a `megarepo/store/gc/inuse-probe` span. */
export const withInUseProbeSpan = (worktreePath: string) =>
  trustedWith({
    operation: inUseProbeOperation,
    attributes: { label: 'inuse-probe', worktreePath },
  })

const inUseVetoAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    worktreePath: Schema.String.pipe(OtelAttr.key({ key: 'worktreePath' })),
    holderPid: Schema.Number.pipe(OtelAttr.key({ key: 'megarepo.store.inuse.holder_pid' })),
    holderPath: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.store.inuse.holder_path' })),
  }),
)

const inUseVetoOperation = OtelOperation.define({
  name: 'megarepo/store/gc/inuse-veto',
  attributes: inUseVetoAttrs,
  label: ({ label }) => label,
})

/**
 * Wrap the in-use VETO of a destructive archive/reap in a
 * `megarepo/store/gc/inuse-veto` span, carrying the holding `pid` and `path` so
 * the attribution the RCA needed is queryable.
 */
export const withInUseVetoSpan = ({
  worktreePath,
  holderPid,
  holderPath,
}: {
  readonly worktreePath: string
  readonly holderPid: number
  readonly holderPath: string
}) =>
  trustedWith({
    operation: inUseVetoOperation,
    attributes: { label: 'inuse-veto', worktreePath, holderPid, holderPath },
  })
