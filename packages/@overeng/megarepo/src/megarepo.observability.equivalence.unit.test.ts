/**
 * Property-based encoder-equivalence proof for the `megarepo.*` telemetry migration (SC-R14).
 *
 * The migration re-points megarepo's runtime spans/metric at DERIVED encoders from the registered
 * seam contract (`./megarepo.contract.ts`). This test proves "the derivation MECHANISM is correct":
 * for every migrated operation, the RSS-gauge metric label encoder, and every catalog attribute
 * (grouped by the annotate-bundle / dynamic-bridge that carries it), the DERIVED product surface
 * (`.operation.encodeSync` / `.encoder.encodeSync` / a `OtelAttrs.defineSync` over the imported
 * catalog schemas) produces byte-identical attribute maps to an INDEPENDENT, hand-authored baseline
 * (inline `OtelAttr.*` + `OtelOperation.define` / `OtelAttrs.defineSync`).
 *
 * IMPORTANT — this is NOT "derived == old bare-key output". The migration INTENTIONALLY renames the
 * historic bare keys (`branch`, `worktreePath`, `repoRoot`, `worktreeHead`, `reason`, reap `path`,
 * `store.repo`, `store.bare_repo.path`, metric label `repo_concurrency`) to namespaced `megarepo.*`
 * keys (retention-first, decision 0004). The baselines below therefore encode the NEW namespaced
 * shape; the proof is that the DSL-derived encoder matches that intended shape.
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the contract), so the comparison is real and not vacuous. Arbitrary constraints mirror
 * notion-md's equivalence test: string attrs use `NonEmptyTrimmedString` (derived span labels must
 * not be empty/whitespace); numeric attrs use `NonNegativeInt`.
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import {
  ArchiveWorktreeOperation,
  AssessLosslessOperation,
  ColdReclaimRepoOperation,
  GitDeleteBranchOperation,
  GitDetachWorktreeHeadOperation,
  MegarepoCliAll,
  MegarepoCliCommand,
  MegarepoCliDryRun,
  MegarepoCliForce,
  MegarepoCliOutput,
  MegarepoCliPorcelain,
  MegarepoMember,
  MegarepoRepo,
  MegarepoRepoPath,
  MegarepoStoreBaseRef,
  MegarepoStoreBareRepoPath,
  MegarepoStoreCommit,
  MegarepoStoreGcCandidateCommits,
  MegarepoStoreGcCandidateNamedRefs,
  MegarepoStoreGcPhase,
  MegarepoStoreGcRepoConcurrency,
  MegarepoStoreGcRepoCount,
  MegarepoStoreGcRepoTotal,
  MegarepoStoreGcResultArchived,
  MegarepoStoreGcResultKept,
  MegarepoStoreGcResultReaped,
  MegarepoStoreGcResultRemoved,
  MegarepoStoreGcResultSkippedDirty,
  MegarepoStoreGcResultSkippedInUse,
  MegarepoStoreGcResultTotal,
  MegarepoStoreGcRootSetWorkspaceCount,
  MegarepoStoreGcWorktreeCount,
  MegarepoStoreGcWorktreeDiscovered,
  MegarepoStoreGitWorktreeListFailed,
  MegarepoStoreHasCurrentWorkspace,
  MegarepoStorePruneStaleRegistry,
  MegarepoStoreRef,
  MegarepoStoreRefreshCurrentWorkspace,
  MegarepoStoreRefType,
  MegarepoStoreRepo,
  MegarepoStoreSource,
  MegarepoStoreWorktreeBroken,
  MegarepoStoreWorktreePath,
  MegarepoSyncMemberAction,
  MegarepoSyncMemberResultStatus,
  MegarepoTestStoreFixturePhase,
  MegarepoTestStoreFixtureRepo,
  MegarepoTraversalCyclesSkipped,
  MegarepoTraversalMaxDepth,
  MegarepoTraversalNodesVisited,
  MegarepoWorkspaceRoot,
  ReapArchiveOperation,
  ResolvePrStateOperation,
  ScanArchivesOperation,
  StoreFixtureCreateOperation,
  StoreFixtureRepoOperation,
  StoreGcOperation,
  StoreGcRssGauge,
  SyncMemberCloneOperation,
  SyncMemberCreateWorktreeOperation,
  SyncMemberOperation,
  SyncMemberResolveRefOperation,
  SyncOperation,
  TraversalOperation,
  UnpushedCommitCountOperation,
} from './megarepo.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString
const Flag = Schema.Boolean
const Count = Schema.NonNegativeInt
const SyncAction = Schema.Literal(
  'clone',
  'already-cloned-by-sibling',
  'skip-dry-run',
  'fetch',
  'fetch-missing-commit',
  'noop',
)
const FixturePhase = Schema.Literal(
  'init-bare',
  'init-upstream',
  'init-source',
  'push-refs',
  'fetch-store-bare',
  'create-worktrees',
  'create-commit-worktrees',
)

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const label = () => Schema.NonEmptyString.pipe(OtelAttr.spanLabel())
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))
const b = (key: string) => Schema.Boolean.pipe(OtelAttr.key({ key }))
const n = (key: string) => Schema.Number.pipe(OtelAttr.key({ key }))
const lit = <const V extends readonly [string, ...string[]]>(key: string, ...v: V) =>
  Schema.Literal(...v).pipe(OtelAttr.key({ key }))

// ---- independent hand-authored operation baselines (intended namespaced shape) ----
const traversalBaseline = OtelOperation.define({
  name: 'megarepo/traversal',
  schema: Schema.Struct({
    label: label(),
    root: s('megarepo.traversal.root'),
    purpose: s('megarepo.traversal.purpose'),
    all: b('megarepo.traversal.all'),
  }),
  label: ({ label }) => label,
})
const syncMemberCloneBaseline = OtelOperation.define({
  name: 'megarepo/sync/member/clone-or-fetch',
  schema: Schema.Struct({
    label: label(),
    bareExists: b('megarepo.sync.member.bare_exists'),
  }),
  label: ({ label }) => label,
})
const syncMemberRefBaseline = (name: string) =>
  OtelOperation.define({
    name,
    schema: Schema.Struct({
      label: label(),
      ref: s('megarepo.sync.member.ref'),
      refType: Schema.optional(s('megarepo.sync.member.ref_type')),
    }),
    label: ({ label }) => label,
  })
const syncMemberBaseline = OtelOperation.define({
  name: 'megarepo/sync/member',
  schema: Schema.Struct({
    label: label(),
    name: s('megarepo.sync.member.name'),
    source: s('megarepo.sync.member.source'),
  }),
  label: ({ label }) => label,
})
const storeFixtureCreateBaseline = OtelOperation.define({
  name: 'megarepo/test/store-fixture/create',
  schema: Schema.Struct({
    label: label(),
    repoCount: n('megarepo.test.store_fixture.repo_count'),
  }),
  label: ({ label }) => label,
})
const storeFixtureRepoBaseline = OtelOperation.define({
  name: 'megarepo/test/store-fixture/repo',
  schema: Schema.Struct({
    label: label(),
    storeRepo: s('megarepo.test.store_fixture.repo'),
    branchCount: n('megarepo.test.store_fixture.branch_count'),
    tagCount: n('megarepo.test.store_fixture.tag_count'),
    commitCount: n('megarepo.test.store_fixture.commit_count'),
    withRemote: b('megarepo.test.store_fixture.with_remote'),
  }),
  label: ({ label }) => label,
})
const branchBaseline = (name: string) =>
  OtelOperation.define({
    name,
    schema: Schema.Struct({ label: label(), branch: s('megarepo.branch') }),
    label: ({ label }) => label,
  })
const worktreePathBaseline = (name: string) =>
  OtelOperation.define({
    name,
    schema: Schema.Struct({ label: label(), worktreePath: s('megarepo.worktree_path') }),
    label: ({ label }) => label,
  })
const archiveWorktreeBaseline = OtelOperation.define({
  name: 'megarepo/store/gc/archive-worktree',
  schema: Schema.Struct({
    label: label(),
    branch: s('megarepo.branch'),
    reason: s('megarepo.store.gc.archive_reason'),
  }),
  label: ({ label }) => label,
})
const scanArchivesBaseline = OtelOperation.define({
  name: 'megarepo/store/gc/scan-archives',
  schema: Schema.Struct({ label: label(), repoRoot: s('megarepo.repo_root') }),
  label: ({ label }) => label,
})
const reapArchiveBaseline = OtelOperation.define({
  name: 'megarepo/store/gc/reap-archive',
  schema: Schema.Struct({ label: label(), path: s('megarepo.store.gc.archive_path') }),
  label: ({ label }) => label,
})
const coldReclaimRepoBaseline = OtelOperation.define({
  name: 'megarepo/store/gc/cold-reclaim-repo',
  schema: Schema.Struct({
    label: label(),
    storeRepo: s('megarepo.store.repo'),
    bareRepoPath: s('megarepo.store.bare_repo_path'),
  }),
  label: ({ label }) => label,
})
const unpushedCommitCountBaseline = OtelOperation.define({
  name: 'megarepo/store/gc/unpushed-commit-count',
  schema: Schema.Struct({ label: label(), worktreeHead: s('megarepo.worktree_head') }),
  label: ({ label }) => label,
})
const syncBaseline = OtelOperation.define({
  name: 'megarepo/sync',
  schema: Schema.Struct({
    label: label(),
    root: s('megarepo.root'),
    mode: s('megarepo.sync.mode'),
    depth: n('megarepo.sync.depth'),
    dryRun: b('megarepo.cli.dry_run'),
    all: b('megarepo.cli.all'),
    force: b('megarepo.cli.force'),
  }),
  label: ({ label }) => label,
})
const storeGcBaseline = OtelOperation.define({
  name: 'megarepo/store/gc',
  root: true,
  schema: Schema.Struct({
    label: label(),
    policy: s('megarepo.store.gc.policy'),
    dryRun: b('megarepo.cli.dry_run'),
    force: b('megarepo.cli.force'),
    all: b('megarepo.cli.all'),
  }),
  label: ({ label }) => label,
})

// ---- per-operation cases (name / baseline / derived / input arbitrary) ----
const opCases = [
  {
    name: 'traversal',
    baseline: traversalBaseline,
    derived: TraversalOperation.operation,
    input: Schema.Struct({ label: Str, root: Str, purpose: Str, all: Flag }),
  },
  {
    name: 'sync/member/clone-or-fetch',
    baseline: syncMemberCloneBaseline,
    derived: SyncMemberCloneOperation.operation,
    input: Schema.Struct({ label: Str, bareExists: Flag }),
  },
  {
    name: 'sync/member/resolve-ref',
    baseline: syncMemberRefBaseline('megarepo/sync/member/resolve-ref'),
    derived: SyncMemberResolveRefOperation.operation,
    input: Schema.Struct({ label: Str, ref: Str, refType: Schema.optional(Str) }),
  },
  {
    name: 'sync/member/create-worktree',
    baseline: syncMemberRefBaseline('megarepo/sync/member/create-worktree'),
    derived: SyncMemberCreateWorktreeOperation.operation,
    input: Schema.Struct({ label: Str, ref: Str, refType: Schema.optional(Str) }),
  },
  {
    name: 'sync/member',
    baseline: syncMemberBaseline,
    derived: SyncMemberOperation.operation,
    input: Schema.Struct({ label: Str, name: Str, source: Str }),
  },
  {
    name: 'test/store-fixture/create',
    baseline: storeFixtureCreateBaseline,
    derived: StoreFixtureCreateOperation.operation,
    input: Schema.Struct({ label: Str, repoCount: Count }),
  },
  {
    name: 'test/store-fixture/repo',
    baseline: storeFixtureRepoBaseline,
    derived: StoreFixtureRepoOperation.operation,
    input: Schema.Struct({
      label: Str,
      storeRepo: Str,
      branchCount: Count,
      tagCount: Count,
      commitCount: Count,
      withRemote: Flag,
    }),
  },
  {
    name: 'git/delete-branch',
    baseline: branchBaseline('git/delete-branch'),
    derived: GitDeleteBranchOperation.operation,
    input: Schema.Struct({ label: Str, branch: Str }),
  },
  {
    name: 'git/detach-worktree-head',
    baseline: worktreePathBaseline('git/detach-worktree-head'),
    derived: GitDetachWorktreeHeadOperation.operation,
    input: Schema.Struct({ label: Str, worktreePath: Str }),
  },
  {
    name: 'store/gc/archive-worktree',
    baseline: archiveWorktreeBaseline,
    derived: ArchiveWorktreeOperation.operation,
    input: Schema.Struct({ label: Str, branch: Str, reason: Str }),
  },
  {
    name: 'store/gc/scan-archives',
    baseline: scanArchivesBaseline,
    derived: ScanArchivesOperation.operation,
    input: Schema.Struct({ label: Str, repoRoot: Str }),
  },
  {
    name: 'store/gc/reap-archive',
    baseline: reapArchiveBaseline,
    derived: ReapArchiveOperation.operation,
    input: Schema.Struct({ label: Str, path: Str }),
  },
  {
    name: 'store/gc/cold-reclaim-repo',
    baseline: coldReclaimRepoBaseline,
    derived: ColdReclaimRepoOperation.operation,
    input: Schema.Struct({ label: Str, storeRepo: Str, bareRepoPath: Str }),
  },
  {
    name: 'store/gc/resolve-pr-state',
    baseline: branchBaseline('megarepo/store/gc/resolve-pr-state'),
    derived: ResolvePrStateOperation.operation,
    input: Schema.Struct({ label: Str, branch: Str }),
  },
  {
    name: 'store/gc/unpushed-commit-count',
    baseline: unpushedCommitCountBaseline,
    derived: UnpushedCommitCountOperation.operation,
    input: Schema.Struct({ label: Str, worktreeHead: Str }),
  },
  {
    name: 'store/gc/assess-lossless',
    baseline: worktreePathBaseline('megarepo/store/gc/assess-lossless'),
    derived: AssessLosslessOperation.operation,
    input: Schema.Struct({ label: Str, worktreePath: Str }),
  },
  {
    name: 'sync',
    baseline: syncBaseline,
    derived: SyncOperation.operation,
    input: Schema.Struct({
      label: Str,
      root: Str,
      mode: Str,
      depth: Count,
      dryRun: Flag,
      all: Flag,
      force: Flag,
    }),
  },
  {
    name: 'store/gc',
    baseline: storeGcBaseline,
    derived: StoreGcOperation.operation,
    input: Schema.Struct({ label: Str, policy: Str, dryRun: Flag, force: Flag, all: Flag }),
  },
] as const

// ---- independent hand-authored annotate-bundle / dynamic-bridge baselines ----
const traversalResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    nodesVisited: n('megarepo.traversal.nodes_visited'),
    cyclesSkipped: n('megarepo.traversal.cycles_skipped'),
    maxDepth: n('megarepo.traversal.max_depth'),
  }),
)
const syncMemberActionBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    action: lit(
      'megarepo.sync.member.action',
      'clone',
      'already-cloned-by-sibling',
      'skip-dry-run',
      'fetch',
      'fetch-missing-commit',
      'noop',
    ),
  }),
)
const syncMemberResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({ status: s('megarepo.sync.member.result_status') }),
)
const storeGcResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    rootSetWorkspaceCount: n('megarepo.store.gc.root_set_workspace_count'),
    repoTotal: n('megarepo.store.gc.repo_total'),
    worktreeDiscovered: n('megarepo.store.gc.worktree_discovered'),
    resultTotal: n('megarepo.store.gc.result_total'),
    resultRemoved: n('megarepo.store.gc.result_removed'),
    resultSkippedInUse: n('megarepo.store.gc.result_skipped_in_use'),
    resultSkippedDirty: n('megarepo.store.gc.result_skipped_dirty'),
    resultArchived: n('megarepo.store.gc.result_archived'),
    resultReaped: n('megarepo.store.gc.result_reaped'),
    resultKept: n('megarepo.store.gc.result_kept'),
    candidateCommits: n('megarepo.store.gc.candidate_commits'),
    candidateNamedRefs: n('megarepo.store.gc.candidate_named_refs'),
    repoConcurrency: n('megarepo.store.gc.repo_concurrency'),
  }),
)
const worktreeListFailureBaseline = OtelAttrs.defineSync(
  Schema.Struct({ failed: b('megarepo.store.git_worktree_list_failed') }),
)
const commandBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    command: s('megarepo.cli.command'),
    output: Schema.optional(s('megarepo.cli.output')),
    all: Schema.optional(b('megarepo.cli.all')),
    dryRun: Schema.optional(b('megarepo.cli.dry_run')),
    force: Schema.optional(b('megarepo.cli.force')),
    member: Schema.optional(s('megarepo.member')),
    repo: Schema.optional(s('megarepo.repo')),
  }),
)
const storeWorktreeBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    repo: s('megarepo.store.repo'),
    refType: s('megarepo.store.ref_type'),
    ref: s('megarepo.store.ref'),
    worktreePath: Schema.optional(s('megarepo.store.worktree_path')),
    bareRepoPath: Schema.optional(s('megarepo.store.bare_repo_path')),
    broken: Schema.optional(b('megarepo.store.worktree_broken')),
  }),
)
const storeSourceBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    source: s('megarepo.store.source'),
    ref: Schema.optional(s('megarepo.store.ref')),
    base: Schema.optional(s('megarepo.store.base_ref')),
    commit: Schema.optional(s('megarepo.store.commit')),
    porcelain: Schema.optional(b('megarepo.cli.porcelain')),
  }),
)
const storeGcPhaseBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    phase: s('megarepo.store.gc.phase'),
    repoCount: Schema.optional(n('megarepo.store.gc.repo_count')),
    worktreeCount: Schema.optional(n('megarepo.store.gc.worktree_count')),
    repoConcurrency: Schema.optional(n('megarepo.store.gc.repo_concurrency')),
  }),
)
const storeLiveSetBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    hasCurrentWorkspace: b('megarepo.store.has_current_workspace'),
    pruneStaleRegistry: b('megarepo.store.prune_stale_registry'),
    refreshCurrentWorkspace: b('megarepo.store.refresh_current_workspace'),
  }),
)
const repoPathBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: label(), repoPath: s('megarepo.repo_path') }),
)
const workspaceBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: label(), workspaceRoot: s('megarepo.workspace_root') }),
)
const storeFixturePhaseBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    phase: lit(
      'megarepo.test.store_fixture.phase',
      'init-bare',
      'init-upstream',
      'init-source',
      'push-refs',
      'fetch-store-bare',
      'create-worktrees',
      'create-commit-worktrees',
    ),
    storeRepo: s('megarepo.test.store_fixture.repo'),
  }),
)
const rssGaugeLabelBaseline = OtelAttrs.defineSync(
  Schema.Struct({ repoConcurrency: n('megarepo.store.gc.repo_concurrency') }),
)

// The DERIVED annotate/dynamic-bridge encoders are rebuilt from the IMPORTED catalog schemas
// exactly as `observability.ts` does — this proves each catalog schema encodes to its intended key.
const bundleCases = [
  {
    name: 'traversal-result',
    baseline: traversalResultBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        nodesVisited: MegarepoTraversalNodesVisited,
        cyclesSkipped: MegarepoTraversalCyclesSkipped,
        maxDepth: MegarepoTraversalMaxDepth,
      }),
    ),
    input: Schema.Struct({ nodesVisited: Count, cyclesSkipped: Count, maxDepth: Count }),
  },
  {
    name: 'sync-member-action',
    baseline: syncMemberActionBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ action: MegarepoSyncMemberAction })),
    input: Schema.Struct({ action: SyncAction }),
  },
  {
    name: 'sync-member-result',
    baseline: syncMemberResultBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ status: MegarepoSyncMemberResultStatus })),
    input: Schema.Struct({ status: Str }),
  },
  {
    name: 'store-gc-result',
    baseline: storeGcResultBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        rootSetWorkspaceCount: MegarepoStoreGcRootSetWorkspaceCount,
        repoTotal: MegarepoStoreGcRepoTotal,
        worktreeDiscovered: MegarepoStoreGcWorktreeDiscovered,
        resultTotal: MegarepoStoreGcResultTotal,
        resultRemoved: MegarepoStoreGcResultRemoved,
        resultSkippedInUse: MegarepoStoreGcResultSkippedInUse,
        resultSkippedDirty: MegarepoStoreGcResultSkippedDirty,
        resultArchived: MegarepoStoreGcResultArchived,
        resultReaped: MegarepoStoreGcResultReaped,
        resultKept: MegarepoStoreGcResultKept,
        candidateCommits: MegarepoStoreGcCandidateCommits,
        candidateNamedRefs: MegarepoStoreGcCandidateNamedRefs,
        repoConcurrency: MegarepoStoreGcRepoConcurrency,
      }),
    ),
    input: Schema.Struct({
      rootSetWorkspaceCount: Count,
      repoTotal: Count,
      worktreeDiscovered: Count,
      resultTotal: Count,
      resultRemoved: Count,
      resultSkippedInUse: Count,
      resultSkippedDirty: Count,
      resultArchived: Count,
      resultReaped: Count,
      resultKept: Count,
      candidateCommits: Count,
      candidateNamedRefs: Count,
      repoConcurrency: Count,
    }),
  },
  {
    name: 'worktree-list-failure',
    baseline: worktreeListFailureBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ failed: MegarepoStoreGitWorktreeListFailed })),
    input: Schema.Struct({ failed: Flag }),
  },
  {
    name: 'command',
    baseline: commandBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        command: MegarepoCliCommand,
        output: Schema.optional(MegarepoCliOutput),
        all: Schema.optional(MegarepoCliAll),
        dryRun: Schema.optional(MegarepoCliDryRun),
        force: Schema.optional(MegarepoCliForce),
        member: Schema.optional(MegarepoMember),
        repo: Schema.optional(MegarepoRepo),
      }),
    ),
    input: Schema.Struct({
      label: Str,
      command: Str,
      output: Schema.optional(Str),
      all: Schema.optional(Flag),
      dryRun: Schema.optional(Flag),
      force: Schema.optional(Flag),
      member: Schema.optional(Str),
      repo: Schema.optional(Str),
    }),
  },
  {
    name: 'store-worktree',
    baseline: storeWorktreeBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        repo: MegarepoStoreRepo,
        refType: MegarepoStoreRefType,
        ref: MegarepoStoreRef,
        worktreePath: Schema.optional(MegarepoStoreWorktreePath),
        bareRepoPath: Schema.optional(MegarepoStoreBareRepoPath),
        broken: Schema.optional(MegarepoStoreWorktreeBroken),
      }),
    ),
    input: Schema.Struct({
      label: Str,
      repo: Str,
      refType: Str,
      ref: Str,
      worktreePath: Schema.optional(Str),
      bareRepoPath: Schema.optional(Str),
      broken: Schema.optional(Flag),
    }),
  },
  {
    name: 'store-source',
    baseline: storeSourceBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        source: MegarepoStoreSource,
        ref: Schema.optional(MegarepoStoreRef),
        base: Schema.optional(MegarepoStoreBaseRef),
        commit: Schema.optional(MegarepoStoreCommit),
        porcelain: Schema.optional(MegarepoCliPorcelain),
      }),
    ),
    input: Schema.Struct({
      label: Str,
      source: Str,
      ref: Schema.optional(Str),
      base: Schema.optional(Str),
      commit: Schema.optional(Str),
      porcelain: Schema.optional(Flag),
    }),
  },
  {
    name: 'store-gc-phase',
    baseline: storeGcPhaseBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        phase: MegarepoStoreGcPhase,
        repoCount: Schema.optional(MegarepoStoreGcRepoCount),
        worktreeCount: Schema.optional(MegarepoStoreGcWorktreeCount),
        repoConcurrency: Schema.optional(MegarepoStoreGcRepoConcurrency),
      }),
    ),
    input: Schema.Struct({
      label: Str,
      phase: Str,
      repoCount: Schema.optional(Count),
      worktreeCount: Schema.optional(Count),
      repoConcurrency: Schema.optional(Count),
    }),
  },
  {
    name: 'store-live-set',
    baseline: storeLiveSetBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        hasCurrentWorkspace: MegarepoStoreHasCurrentWorkspace,
        pruneStaleRegistry: MegarepoStorePruneStaleRegistry,
        refreshCurrentWorkspace: MegarepoStoreRefreshCurrentWorkspace,
      }),
    ),
    input: Schema.Struct({
      label: Str,
      hasCurrentWorkspace: Flag,
      pruneStaleRegistry: Flag,
      refreshCurrentWorkspace: Flag,
    }),
  },
  {
    name: 'repo-path',
    baseline: repoPathBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ label: label(), repoPath: MegarepoRepoPath })),
    input: Schema.Struct({ label: Str, repoPath: Str }),
  },
  {
    name: 'workspace',
    baseline: workspaceBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({ label: label(), workspaceRoot: MegarepoWorkspaceRoot }),
    ),
    input: Schema.Struct({ label: Str, workspaceRoot: Str }),
  },
  {
    name: 'store-fixture-phase',
    baseline: storeFixturePhaseBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        phase: MegarepoTestStoreFixturePhase,
        storeRepo: MegarepoTestStoreFixtureRepo,
      }),
    ),
    input: Schema.Struct({ label: Str, phase: FixturePhase, storeRepo: Str }),
  },
  {
    name: 'rss-gauge-label',
    baseline: rssGaugeLabelBaseline,
    derived: StoreGcRssGauge.encoder,
    input: Schema.Struct({ repoConcurrency: Count }),
  },
] as const

describe('megarepo.* derived operation encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of opCases) {
    it.prop(
      `${c.name}: derived .operation.encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = (c.baseline as OtelOperationDefinition<never>).encodeSync(value as never)
        const derived = (c.derived as OtelOperationDefinition<never>).encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
        expect(typeof derived['span.label']).toBe('string')
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on span name + attribute keys`, () => {
      expect(c.derived.metadata.name).toBe(c.baseline.metadata.name)
      expect([...c.derived.metadata.attributeKeys].toSorted()).toStrictEqual(
        [...c.baseline.metadata.attributeKeys].toSorted(),
      )
    })
  }
})

describe('megarepo.* derived annotate/metric-label encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of bundleCases) {
    it.prop(
      `${c.name}: derived .encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = c.baseline.encodeSync(value as never)
        const derived = c.derived.encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on attribute keys`, () => {
      expect([...c.derived.keys].toSorted()).toStrictEqual([...c.baseline.keys].toSorted())
    })
  }
})
