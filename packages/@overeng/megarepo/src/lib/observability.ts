import { Effect, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  OtelSpan,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

const basename = (path: string): string =>
  path.split('/').findLast((part) => part.length > 0) ?? path

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

const labelOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: labelAttrs,
    label: ({ label }) => label,
  })

const labelAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
  }),
)

const repoPathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    repoPath: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.repo_path' })),
  }),
)

const worktreePathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    worktreePath: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.worktree_path' })),
  }),
)

const gitUrlAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    url: Schema.String.pipe(OtelAttr.key({ key: 'git.url' })),
    bare: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'git.bare' }))),
  }),
)

/** Per-subprocess `git-cmd` span. `output.bytes`/`output.lines` are annotated
 *  AFTER the command completes — for the streaming path they come from scalar
 *  running counters (never a buffer), so the bounded-memory invariant holds. */
export const gitCmdAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    subcommand: Schema.String.pipe(OtelAttr.key({ key: 'git.subcommand' })),
    streamed: Schema.Boolean.pipe(OtelAttr.key({ key: 'git.streamed' })),
    timeoutMs: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'git.timeout_ms' }))),
  }),
)

const gitCmdOutputAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    outputBytes: Schema.Number.pipe(OtelAttr.key({ key: 'git.output.bytes' })),
    outputLines: Schema.Number.pipe(OtelAttr.key({ key: 'git.output.lines' })),
  }),
)

const gitBranchAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    branch: Schema.String.pipe(OtelAttr.key({ key: 'git.branch' })),
  }),
)

const gitCommitAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    commit: Schema.String.pipe(OtelAttr.key({ key: 'git.commit' })),
  }),
)

const workspaceAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    workspaceRoot: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.workspace_root' })),
  }),
)

const megarepoTraversalAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    root: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.traversal.root' })),
    purpose: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'megarepo.traversal.purpose' })),
    all: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.traversal.all' })),
  }),
)

const megarepoTraversalResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    nodesVisited: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'megarepo.traversal.nodes_visited' }),
    ),
    cyclesSkipped: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'megarepo.traversal.cycles_skipped' }),
    ),
    maxDepth: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'megarepo.traversal.max_depth' })),
  }),
)

const storeLiveSetAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    hasCurrentWorkspace: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'megarepo.store.has_current_workspace' }),
    ),
    pruneStaleRegistry: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'megarepo.store.prune_stale_registry' }),
    ),
    refreshCurrentWorkspace: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'megarepo.store.refresh_current_workspace' }),
    ),
  }),
)

const nixFlakeMetadataAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    owner: Schema.String.pipe(OtelAttr.key({ key: 'nix.flake.owner' })),
    repo: Schema.String.pipe(OtelAttr.key({ key: 'nix.flake.repo' })),
    rev: Schema.String.pipe(OtelAttr.key({ key: 'nix.flake.rev' })),
  }),
)

const nixLockFileAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'nix.lock.path' })),
    type: Schema.String.pipe(OtelAttr.key({ key: 'nix.lock.type' })),
  }),
)

const nixLockPathTypeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'path' })),
    type: Schema.String.pipe(OtelAttr.key({ key: 'type' })),
  }),
)

const nixLockPathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'path' })),
  }),
)

const syncMemberCloneAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    bareExists: Schema.Boolean.pipe(OtelAttr.key({ key: 'megarepo.sync.member.bare_exists' })),
  }),
)

const syncMemberRefAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    ref: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.ref' })),
    refType: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.ref_type' })),
    ),
  }),
)

const syncMemberAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    name: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.name' })),
    source: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.source' })),
  }),
)

const syncMemberActionAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    action: Schema.Literal(
      'clone',
      'already-cloned-by-sibling',
      'skip-dry-run',
      'fetch',
      'fetch-missing-commit',
      'noop',
    ).pipe(OtelAttr.key({ key: 'megarepo.sync.member.action' })),
  }),
)

type SyncMemberAction =
  | 'clone'
  | 'already-cloned-by-sibling'
  | 'skip-dry-run'
  | 'fetch'
  | 'fetch-missing-commit'
  | 'noop'

const syncMemberResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    status: Schema.String.pipe(OtelAttr.key({ key: 'megarepo.sync.member.result_status' })),
  }),
)

/** Wrap an effect in a `<name>` span carrying only an explicit display label —
 *  the generic span helper for sites with no other structured attributes. */
export const withLabelSpan = ({ name, labelValue }: { name: string; labelValue: string }) =>
  trustedWith({ operation: labelOperation(name), attributes: { label: labelValue } })

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

const megarepoTraversalOperation = OtelOperation.define({
  name: 'megarepo/traversal',
  attributes: megarepoTraversalAttrs,
  label: ({ label }) => label,
})

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

/** Annotate the enclosing traversal span with bounded scalar counters. */
export const annotateMegarepoTraversalResult = (
  value: Schema.Schema.Type<typeof megarepoTraversalResultAttrs.schema>,
) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({ attributes: megarepoTraversalResultAttrs, value }),
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

/** Wrap an effect in a `<name>` span carrying a lock entry's `path`/`type`
 *  (intentionally unprefixed attribute keys). */
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

/** Wrap an effect in a `<name>` span carrying a single lock `path` (unprefixed key). */
export const withNixLockPathSpan = ({
  name,
  path,
}: {
  readonly name: string
  readonly path: string
}) => trustedWith({ operation: nixLockPathOperation(name), attributes: { label: path, path } })

const syncMemberCloneOperation = OtelOperation.define({
  name: 'megarepo/sync/member/clone-or-fetch',
  attributes: syncMemberCloneAttrs,
  label: ({ label }) => label,
})

/** Wrap a member clone-or-fetch in a `megarepo/sync/member/clone-or-fetch` span;
 *  `bareExists` distinguishes the fetch path from the initial clone. */
export const withSyncMemberCloneSpan = ({
  name,
  bareExists,
}: {
  readonly name: string
  readonly bareExists: boolean
}) => trustedWith({ operation: syncMemberCloneOperation, attributes: { label: name, bareExists } })

const syncMemberResolveRefOperation = OtelOperation.define({
  name: 'megarepo/sync/member/resolve-ref',
  attributes: syncMemberRefAttrs,
  label: ({ label }) => label,
})

/** Wrap ref resolution for a member in a `megarepo/sync/member/resolve-ref` span. */
export const withSyncMemberResolveRefSpan = (ref: string) =>
  trustedWith({ operation: syncMemberResolveRefOperation, attributes: { label: ref, ref } })

const syncMemberCreateWorktreeOperation = OtelOperation.define({
  name: 'megarepo/sync/member/create-worktree',
  attributes: syncMemberRefAttrs,
  label: ({ label }) => label,
})

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

const syncMemberOperation = OtelOperation.define({
  name: 'megarepo/sync/member',
  attributes: syncMemberAttrs,
  label: ({ label }) => label,
})

/** Wrap the whole per-member sync in a `megarepo/sync/member` span; the enclosing
 *  span for the clone/resolve/create-worktree child spans. */
export const withSyncMemberSpan = ({
  name,
  source,
}: {
  readonly name: string
  readonly source: string
}) => trustedWith({ operation: syncMemberOperation, attributes: { label: name, name, source } })

/** Annotate the enclosing member span with the action actually taken
 *  (clone / fetch / noop / …), so the chosen path is queryable per member. */
export const annotateSyncMemberAction = (action: SyncMemberAction) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({
      attributes: syncMemberActionAttrs,
      value: { action },
    }),
  )

/** Annotate the enclosing member span with the final result status string. */
export const annotateSyncMemberResult = (status: string) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({
      attributes: syncMemberResultAttrs,
      value: { status },
    }),
  )

// =============================================================================
// Store GC lib-site span contracts
//
// These mirror the inline `Effect.withSpan` sites previously embedded in the gc
// lib/git modules. Span names, `span.label` expressions, and attribute keys are
// reproduced EXACTLY — including the intentionally unprefixed keys (`branch`,
// `worktreePath`, `path`, `repoRoot`, `worktreeHead`, `store.repo`,
// `store.bare_repo.path`) — so the otel instrumentation contract stays
// byte-identical after routing through the schema-first DSL.
// =============================================================================

const gitDeleteBranchAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    branch: Schema.String.pipe(OtelAttr.key({ key: 'branch' })),
  }),
)

const gitDeleteBranchOperation = OtelOperation.define({
  name: 'git/delete-branch',
  attributes: gitDeleteBranchAttrs,
  label: ({ label }) => label,
})

/** Wrap a `git branch -D/-d` effect in a `git/delete-branch` span. */
export const withGitDeleteBranchSpan = (branch: string) =>
  trustedWith({ operation: gitDeleteBranchOperation, attributes: { label: branch, branch } })

const gitDetachWorktreeHeadAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    worktreePath: Schema.String.pipe(OtelAttr.key({ key: 'worktreePath' })),
  }),
)

const gitDetachWorktreeHeadOperation = OtelOperation.define({
  name: 'git/detach-worktree-head',
  attributes: gitDetachWorktreeHeadAttrs,
  label: ({ label }) => label,
})

/** Wrap a `git checkout --detach` effect in a `git/detach-worktree-head` span. */
export const withGitDetachWorktreeHeadSpan = (worktreePath: string) =>
  trustedWith({
    operation: gitDetachWorktreeHeadOperation,
    attributes: { label: worktreePath, worktreePath },
  })

const archiveWorktreeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    branch: Schema.String.pipe(OtelAttr.key({ key: 'branch' })),
    reason: Schema.String.pipe(OtelAttr.key({ key: 'reason' })),
  }),
)

const archiveWorktreeOperation = OtelOperation.define({
  name: 'megarepo/store/gc/archive-worktree',
  attributes: archiveWorktreeAttrs,
  label: ({ label }) => label,
})

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

const scanArchivesAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    repoRoot: Schema.String.pipe(OtelAttr.key({ key: 'repoRoot' })),
  }),
)

const scanArchivesOperation = OtelOperation.define({
  name: 'megarepo/store/gc/scan-archives',
  attributes: scanArchivesAttrs,
  label: ({ label }) => label,
})

/** Wrap archive enumeration in a `megarepo/store/gc/scan-archives` span. */
export const withScanArchivesSpan = (repoRoot: string) =>
  trustedWith({
    operation: scanArchivesOperation,
    attributes: { label: 'scan-archives', repoRoot },
  })

const reapArchiveAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    path: Schema.String.pipe(OtelAttr.key({ key: 'path' })),
  }),
)

const reapArchiveOperation = OtelOperation.define({
  name: 'megarepo/store/gc/reap-archive',
  attributes: reapArchiveAttrs,
  label: ({ label }) => label,
})

/** Wrap an archive hard-delete in a `megarepo/store/gc/reap-archive` span. */
export const withReapArchiveSpan = (path: string) =>
  trustedWith({ operation: reapArchiveOperation, attributes: { label: 'reap-archive', path } })

const coldReclaimRepoAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    storeRepo: Schema.String.pipe(OtelAttr.key({ key: 'store.repo' })),
    bareRepoPath: Schema.String.pipe(OtelAttr.key({ key: 'store.bare_repo.path' })),
  }),
)

const coldReclaimRepoOperation = OtelOperation.define({
  name: 'megarepo/store/gc/cold-reclaim-repo',
  attributes: coldReclaimRepoAttrs,
  label: ({ label }) => label,
})

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

const resolvePrStateAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    branch: Schema.String.pipe(OtelAttr.key({ key: 'branch' })),
  }),
)

const resolvePrStateOperation = OtelOperation.define({
  name: 'megarepo/store/gc/resolve-pr-state',
  attributes: resolvePrStateAttrs,
  label: ({ label }) => label,
})

/** Wrap a per-branch PR-state lookup in a `megarepo/store/gc/resolve-pr-state` span. */
export const withResolvePrStateSpan = (branch: string) =>
  trustedWith({ operation: resolvePrStateOperation, attributes: { label: 'pr-state', branch } })

const unpushedCommitCountAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    worktreeHead: Schema.String.pipe(OtelAttr.key({ key: 'worktreeHead' })),
  }),
)

const unpushedCommitCountOperation = OtelOperation.define({
  name: 'megarepo/store/gc/unpushed-commit-count',
  attributes: unpushedCommitCountAttrs,
  label: ({ label }) => label,
})

/** Wrap the unpushed-commit count in a `megarepo/store/gc/unpushed-commit-count` span. */
export const withUnpushedCommitCountSpan = (worktreeHead: string) =>
  trustedWith({
    operation: unpushedCommitCountOperation,
    attributes: {
      label: worktreeHead.slice(0, 8),
      worktreeHead,
    },
  })

const assessLosslessAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    worktreePath: Schema.String.pipe(OtelAttr.key({ key: 'worktreePath' })),
  }),
)

const assessLosslessOperation = OtelOperation.define({
  name: 'megarepo/store/gc/assess-lossless',
  attributes: assessLosslessAttrs,
  label: ({ label }) => label,
})

/** Wrap the lossless-floor assessment in a `megarepo/store/gc/assess-lossless` span. */
export const withAssessLosslessSpan = (worktreePath: string) =>
  trustedWith({
    operation: assessLosslessOperation,
    attributes: { label: 'lossless', worktreePath },
  })
