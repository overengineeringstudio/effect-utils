/**
 * SEAM member contract for the `megarepo.*` telemetry namespace (decision 0005) — megarepo's OWN
 * observability, authored via the Layer-2 `@overeng/otel-contract/registry` surface. This is the
 * single home for megarepo's telemetry catalog + signals: the Weaver registry projection AND the
 * runtime encoders (`src/lib/observability.ts`, `src/cli/observability.ts`) both derive from it
 * (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint
 * and MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam
 * test asserts this).
 *
 * Placement: `src/` (megarepo has no dependency-free zone; both `observability.ts` files already
 * import `@overeng/otel-contract` at runtime, so this file's `./registry` import is runtime-safe).
 *
 * SCOPE — `megarepo` namespace only. Two other namespaces appear in megarepo's runtime telemetry
 * and are OUT of scope here (they are catalogued in the sibling `git.contract.ts` / `nix.contract.ts`
 * attrs-only seams, mirroring genie's `cli.contract.ts`): `git.*` (`git/cmd`, `withGitUrlSpan`,
 * `withGitBranchSpan`, `withGitCommitSpan`) and `nix.*` (`fetchNixFlakeMetadata`,
 * `megarepo/nix-lock/file`). Those spans/annotate-bundles stay LEGACY inline `OtelOperation.define`
 * in `observability.ts` (rebuilt from the imported git/nix catalog schemas) — the derive-strict
 * namespace guard would reject a `git.*`/`nix.*` own-key here anyway.
 *
 * BARE-KEY RENAMES (BREAKING wire renames; retention-first, decision 0004). Several gc lib-site
 * spans historically carried UNPREFIXED attribute keys (`branch`, `worktreePath`, `repoRoot`,
 * `worktreeHead`, `reason`, reap `path`, `store.repo`, `store.bare_repo.path`) plus the RSS gauge's
 * bare `repo_concurrency` metric label. Those keys CANNOT live in a `megarepo` namespace as-is, so
 * this migration renames each to a namespaced `megarepo.*` key (emit-new; the old bare key simply
 * stops being emitted). See the migration report / observability.ts for the full rename table.
 *
 * DYNAMIC-NAME BRIDGES (SC-DQ5): spans whose NAME varies at runtime (`withRepoPathSpan`,
 * `withWorktreePathSpan`, `withWorkspaceSpan`, `withStoreLiveSetSpan`, `withStoreWorktreeSpan`,
 * `withStoreSourceSpan`, `withStoreGcPhaseSpan`, `storeFixturePhase`, `withCommandSpan`) have no
 * stable single-signal projection and stay legacy inline in `observability.ts`. Their `megarepo.*`
 * keys reach the catalog via `docOnlyAttributes` (SC-R13 completeness). Annotate-only result
 * bundles do the same.
 */
import { Schema } from 'effect'

import { OtelAttr } from '@overeng/otel-contract'
import {
  attr,
  defineOtelContract,
  metric,
  operation,
  recommended,
  required,
} from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the megarepo.* catalog SSOT)
// ---------------------------------------------------------------------------

// -- cli / command --
/** megarepo CLI command name. */
export const MegarepoCliCommand = attr.string({
  key: 'megarepo.cli.command',
  cardinality: 'low',
  brief: 'megarepo CLI command name.',
  stability: 'development',
  examples: ['sync', 'store gc'],
})

/** Requested CLI output format. */
export const MegarepoCliOutput = attr.string({
  key: 'megarepo.cli.output',
  cardinality: 'bounded',
  brief: 'Requested CLI output format.',
  stability: 'development',
  examples: ['json', 'text'],
})

/** Whether the command operates over all members/repos. */
export const MegarepoCliAll = attr.boolean({
  key: 'megarepo.cli.all',
  brief: 'Whether the command operates over all members/repos.',
  stability: 'development',
})

/** Whether the run is a dry run (planned actions logged, not applied). */
export const MegarepoCliDryRun = attr.boolean({
  key: 'megarepo.cli.dry_run',
  brief: 'Whether the run is a dry run (planned actions are logged, not applied).',
  stability: 'development',
})

/** Whether a destructive action was force-requested. */
export const MegarepoCliForce = attr.boolean({
  key: 'megarepo.cli.force',
  brief: 'Whether a destructive action was force-requested.',
  stability: 'development',
})

/** Whether porcelain (machine-readable) output was requested. */
export const MegarepoCliPorcelain = attr.boolean({
  key: 'megarepo.cli.porcelain',
  brief: 'Whether porcelain (machine-readable) output was requested.',
  stability: 'development',
})

/** megarepo member name a command targets. */
export const MegarepoMember = attr.string({
  key: 'megarepo.member',
  cardinality: 'high',
  brief: 'megarepo member name a command targets.',
  stability: 'development',
  examples: ['effect-utils', 'notion-md'],
})

/** Repository a command targets. */
export const MegarepoRepo = attr.string({
  key: 'megarepo.repo',
  cardinality: 'high',
  brief: 'Repository a command targets.',
  stability: 'development',
  examples: ['github.com/overengineeringstudio/effect-utils'],
})

// -- roots / paths (some from bare-key renames) --
/** Absolute megarepo workspace/root path a run operates on. */
export const MegarepoRoot = attr.string({
  key: 'megarepo.root',
  cardinality: 'high',
  brief: 'Absolute megarepo root path a run operates on.',
  stability: 'development',
  examples: ['/home/user/megarepo'],
})

/** Absolute path of a composed repo. */
export const MegarepoRepoPath = attr.string({
  key: 'megarepo.repo_path',
  cardinality: 'high',
  brief: 'Absolute path of a composed repo.',
  stability: 'development',
  examples: ['/home/user/megarepo/repos/effect-utils'],
})

/** Absolute worktree path a span operates on. */
export const MegarepoWorktreePath = attr.string({
  key: 'megarepo.worktree_path',
  cardinality: 'high',
  brief: 'Absolute worktree path a span operates on.',
  stability: 'development',
  examples: ['/home/user/.megarepo/store/github.com/org/repo/worktrees/main'],
})

/** Resolved commit sha of a worktree HEAD (bare-key rename of `worktreeHead`). */
export const MegarepoWorktreeHead = attr.string({
  key: 'megarepo.worktree_head',
  cardinality: 'high',
  brief: 'Resolved commit sha of a worktree HEAD.',
  stability: 'development',
  examples: ['a3c1b6323f0e'],
})

/** Absolute repo root scanned during gc (bare-key rename of `repoRoot`). */
export const MegarepoRepoRoot = attr.string({
  key: 'megarepo.repo_root',
  cardinality: 'high',
  brief: 'Absolute repo root scanned during gc.',
  stability: 'development',
  examples: ['/home/user/.megarepo/store/github.com/org/repo'],
})

/** Absolute megarepo workspace root. */
export const MegarepoWorkspaceRoot = attr.string({
  key: 'megarepo.workspace_root',
  cardinality: 'high',
  brief: 'Absolute megarepo workspace root.',
  stability: 'development',
  examples: ['/home/user/megarepo'],
})

/** Git branch name a megarepo operation acts on (bare-key rename of `branch`). */
export const MegarepoBranch = attr.string({
  key: 'megarepo.branch',
  cardinality: 'high',
  brief: 'Git branch name a megarepo operation acts on.',
  stability: 'development',
  examples: ['main', 'schickling/feature'],
})

// -- sync --
/** Ref-resolution mode for a sync run. */
export const MegarepoSyncMode = attr.string({
  key: 'megarepo.sync.mode',
  cardinality: 'bounded',
  brief: 'Ref-resolution mode for a sync run.',
  stability: 'development',
  examples: ['locked', 'latest'],
})

/** Configured recursion depth for a sync run. */
export const MegarepoSyncDepth = attr.number({
  key: 'megarepo.sync.depth',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Configured recursion depth for a sync run.',
  stability: 'development',
  examples: [1, 5],
})

/** Member name being synced. */
export const MegarepoSyncMemberName = attr.string({
  key: 'megarepo.sync.member.name',
  cardinality: 'high',
  brief: 'Member name being synced.',
  stability: 'development',
  examples: ['effect-utils'],
})

/** Source of the member being synced. */
export const MegarepoSyncMemberSource = attr.string({
  key: 'megarepo.sync.member.source',
  cardinality: 'high',
  brief: 'Source of the member being synced.',
  stability: 'development',
  examples: ['github.com/org/repo'],
})

/** Target ref for a member sync. */
export const MegarepoSyncMemberRef = attr.string({
  key: 'megarepo.sync.member.ref',
  cardinality: 'high',
  brief: 'Target ref for a member sync.',
  stability: 'development',
  examples: ['main', 'v1.2.3'],
})

/** Kind of the target ref for a member sync. */
export const MegarepoSyncMemberRefType = attr.string({
  key: 'megarepo.sync.member.ref_type',
  cardinality: 'bounded',
  brief: 'Kind of the target ref for a member sync.',
  stability: 'development',
  examples: ['branch', 'tag', 'commit'],
})

/** Whether the member's bare repository already exists (fetch vs initial clone). */
export const MegarepoSyncMemberBareExists = attr.boolean({
  key: 'megarepo.sync.member.bare_exists',
  brief: "Whether the member's bare repository already exists (fetch vs initial clone).",
  stability: 'development',
})

/** The action actually taken for a member sync. */
export const MegarepoSyncMemberAction = attr.enum({
  key: 'megarepo.sync.member.action',
  values: [
    'clone',
    'already-cloned-by-sibling',
    'skip-dry-run',
    'fetch',
    'fetch-missing-commit',
    'fetch-pull-request-heads',
    'noop',
  ],
  briefs: {
    clone: 'Initial clone of the member.',
    'already-cloned-by-sibling': 'A sibling already cloned this member.',
    'skip-dry-run': 'Skipped because the run is a dry run.',
    fetch: 'Fetched into an existing bare repository.',
    'fetch-missing-commit': 'Fetched a specific missing commit.',
    'fetch-pull-request-heads':
      'Fetched pull-request head refs to recover a commit outside refs/heads/*.',
    noop: 'No action required.',
  },
  brief: 'The action actually taken for a member sync.',
  stability: 'development',
})

/** Final result status of a member sync. */
export const MegarepoSyncMemberResultStatus = attr.string({
  key: 'megarepo.sync.member.result_status',
  cardinality: 'bounded',
  brief: 'Final result status of a member sync.',
  stability: 'development',
  examples: ['cloned', 'fetched', 'noop'],
})

// -- traversal --
/** Root of a nested-megarepo traversal. */
export const MegarepoTraversalRoot = attr.string({
  key: 'megarepo.traversal.root',
  cardinality: 'high',
  brief: 'Root of a nested-megarepo traversal.',
  stability: 'development',
  examples: ['/home/user/megarepo'],
})

/** Purpose of a nested-megarepo traversal. */
export const MegarepoTraversalPurpose = attr.string({
  key: 'megarepo.traversal.purpose',
  cardinality: 'bounded',
  brief: 'Purpose of a nested-megarepo traversal.',
  stability: 'development',
  examples: ['sync', 'gc'],
})

/** Whether the traversal visits all members. */
export const MegarepoTraversalAll = attr.boolean({
  key: 'megarepo.traversal.all',
  brief: 'Whether the traversal visits all members.',
  stability: 'development',
})

/** Number of nodes visited during a traversal. */
export const MegarepoTraversalNodesVisited = attr.number({
  key: 'megarepo.traversal.nodes_visited',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of nodes visited during a traversal.',
  stability: 'development',
  examples: [3, 12],
})

/** Number of cycles skipped during a traversal. */
export const MegarepoTraversalCyclesSkipped = attr.number({
  key: 'megarepo.traversal.cycles_skipped',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of cycles skipped during a traversal.',
  stability: 'development',
  examples: [0, 1],
})

/** Maximum depth reached during a traversal. */
export const MegarepoTraversalMaxDepth = attr.number({
  key: 'megarepo.traversal.max_depth',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Maximum depth reached during a traversal.',
  stability: 'development',
  examples: [1, 3],
})

// -- store --
/** Store repository (relative path) a span operates on (also merges bare `store.repo`). */
export const MegarepoStoreRepo = attr.string({
  key: 'megarepo.store.repo',
  cardinality: 'high',
  brief: 'Store repository (relative path) a span operates on.',
  stability: 'development',
  examples: ['github.com/org/repo'],
})

/** Kind of the store ref. */
export const MegarepoStoreRefType = attr.string({
  key: 'megarepo.store.ref_type',
  cardinality: 'bounded',
  brief: 'Kind of the store ref.',
  stability: 'development',
  examples: ['branch', 'tag', 'commit'],
})

/** Store ref a span operates on. */
export const MegarepoStoreRef = attr.string({
  key: 'megarepo.store.ref',
  cardinality: 'high',
  brief: 'Store ref a span operates on.',
  stability: 'development',
  examples: ['main', 'v1.2.3'],
})

/** Store worktree path a span operates on. */
export const MegarepoStoreWorktreePath = attr.string({
  key: 'megarepo.store.worktree_path',
  cardinality: 'high',
  brief: 'Store worktree path a span operates on.',
  stability: 'development',
  examples: ['/home/user/.megarepo/store/github.com/org/repo/worktrees/main'],
})

/** Store bare-repository path (also merges bare `store.bare_repo.path`). */
export const MegarepoStoreBareRepoPath = attr.string({
  key: 'megarepo.store.bare_repo_path',
  cardinality: 'high',
  brief: 'Store bare-repository path.',
  stability: 'development',
  examples: ['/home/user/.megarepo/store/github.com/org/repo/repo.git'],
})

/** Whether the store worktree is broken. */
export const MegarepoStoreWorktreeBroken = attr.boolean({
  key: 'megarepo.store.worktree_broken',
  brief: 'Whether the store worktree is broken.',
  stability: 'development',
})

/** Source of a store operation. */
export const MegarepoStoreSource = attr.string({
  key: 'megarepo.store.source',
  cardinality: 'high',
  brief: 'Source of a store operation.',
  stability: 'development',
  examples: ['github.com/org/repo'],
})

/** Base ref for a store operation. */
export const MegarepoStoreBaseRef = attr.string({
  key: 'megarepo.store.base_ref',
  cardinality: 'high',
  brief: 'Base ref for a store operation.',
  stability: 'development',
  examples: ['main'],
})

/** Resolved commit for a store operation. */
export const MegarepoStoreCommit = attr.string({
  key: 'megarepo.store.commit',
  cardinality: 'high',
  brief: 'Resolved commit for a store operation.',
  stability: 'development',
  examples: ['a3c1b6323f0e'],
})

/** Whether the live-set computation had a current workspace. */
export const MegarepoStoreHasCurrentWorkspace = attr.boolean({
  key: 'megarepo.store.has_current_workspace',
  brief: 'Whether the live-set computation had a current workspace.',
  stability: 'development',
})

/** Whether the live-set computation pruned the stale registry. */
export const MegarepoStorePruneStaleRegistry = attr.boolean({
  key: 'megarepo.store.prune_stale_registry',
  brief: 'Whether the live-set computation pruned the stale registry.',
  stability: 'development',
})

/** Whether the live-set computation refreshed the current workspace. */
export const MegarepoStoreRefreshCurrentWorkspace = attr.boolean({
  key: 'megarepo.store.refresh_current_workspace',
  brief: 'Whether the live-set computation refreshed the current workspace.',
  stability: 'development',
})

/** Whether `git worktree list` failed (gc fell back to a degraded worktree view). */
export const MegarepoStoreGitWorktreeListFailed = attr.boolean({
  key: 'megarepo.store.git_worktree_list_failed',
  brief: 'Whether `git worktree list` failed (gc fell back to a degraded worktree view).',
  stability: 'development',
})

// -- store gc --
/** Retention policy for a gc run. */
export const MegarepoStoreGcPolicy = attr.string({
  key: 'megarepo.store.gc.policy',
  cardinality: 'bounded',
  brief: 'Retention policy for a gc run.',
  stability: 'development',
  examples: ['conservative', 'aggressive'],
})

/** gc/status pipeline phase. */
export const MegarepoStoreGcPhase = attr.string({
  key: 'megarepo.store.gc.phase',
  cardinality: 'bounded',
  brief: 'gc/status pipeline phase.',
  stability: 'development',
  examples: ['collect-liveness', 'cold-reclaim'],
})

/** Number of repos considered in a gc phase. */
export const MegarepoStoreGcRepoCount = attr.number({
  key: 'megarepo.store.gc.repo_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of repos considered in a gc phase.',
  stability: 'development',
  examples: [1, 20],
})

/** Number of worktrees considered in a gc phase. */
export const MegarepoStoreGcWorktreeCount = attr.number({
  key: 'megarepo.store.gc.worktree_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of worktrees considered in a gc phase.',
  stability: 'development',
  examples: [3, 40],
})

/** Per-repo gc concurrency (span attr + RSS-gauge label; bare-key rename of `repo_concurrency`). */
export const MegarepoStoreGcRepoConcurrency = attr.number({
  key: 'megarepo.store.gc.repo_concurrency',
  weaverType: 'int',
  cardinality: 'bounded',
  brief: 'Per-repo gc concurrency (parameter-sweep operating point).',
  stability: 'development',
  examples: [1, 4],
})

/** Reason a cold worktree was archived (bare-key rename of `reason`). */
export const MegarepoStoreGcArchiveReason = attr.string({
  key: 'megarepo.store.gc.archive_reason',
  cardinality: 'bounded',
  brief: 'Reason a cold worktree was archived.',
  stability: 'development',
  examples: ['cold', 'lossless'],
})

/** Absolute path of an archive hard-deleted during gc (bare-key rename of reap `path`). */
export const MegarepoStoreGcArchivePath = attr.string({
  key: 'megarepo.store.gc.archive_path',
  cardinality: 'high',
  brief: 'Absolute path of an archive hard-deleted during gc.',
  stability: 'development',
  examples: ['/home/user/.megarepo/store/.../archives/2026-07-01'],
})

/** Number of root-set workspaces feeding gc liveness. */
export const MegarepoStoreGcRootSetWorkspaceCount = attr.number({
  key: 'megarepo.store.gc.root_set_workspace_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of root-set workspaces feeding gc liveness.',
  stability: 'development',
  examples: [1, 5],
})

/** Total repos considered by a gc run. */
export const MegarepoStoreGcRepoTotal = attr.number({
  key: 'megarepo.store.gc.repo_total',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Total repos considered by a gc run.',
  stability: 'development',
  examples: [1, 20],
})

/** Worktrees discovered by a gc run. */
export const MegarepoStoreGcWorktreeDiscovered = attr.number({
  key: 'megarepo.store.gc.worktree_discovered',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Worktrees discovered by a gc run.',
  stability: 'development',
  examples: [3, 40],
})

/** Total gc-result entries. */
export const MegarepoStoreGcResultTotal = attr.number({
  key: 'megarepo.store.gc.result_total',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Total gc-result entries.',
  stability: 'development',
  examples: [3, 40],
})

/** gc-result entries removed. */
export const MegarepoStoreGcResultRemoved = attr.number({
  key: 'megarepo.store.gc.result_removed',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'gc-result entries removed.',
  stability: 'development',
  examples: [0, 5],
})

/** gc-result entries skipped because in use. */
export const MegarepoStoreGcResultSkippedInUse = attr.number({
  key: 'megarepo.store.gc.result_skipped_in_use',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'gc-result entries skipped because in use.',
  stability: 'development',
  examples: [0, 2],
})

/** gc-result entries skipped because dirty. */
export const MegarepoStoreGcResultSkippedDirty = attr.number({
  key: 'megarepo.store.gc.result_skipped_dirty',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'gc-result entries skipped because dirty.',
  stability: 'development',
  examples: [0, 2],
})

/** gc-result entries archived. */
export const MegarepoStoreGcResultArchived = attr.number({
  key: 'megarepo.store.gc.result_archived',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'gc-result entries archived.',
  stability: 'development',
  examples: [0, 3],
})

/** gc-result entries reaped. */
export const MegarepoStoreGcResultReaped = attr.number({
  key: 'megarepo.store.gc.result_reaped',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'gc-result entries reaped.',
  stability: 'development',
  examples: [0, 3],
})

/** gc-result entries kept. */
export const MegarepoStoreGcResultKept = attr.number({
  key: 'megarepo.store.gc.result_kept',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'gc-result entries kept.',
  stability: 'development',
  examples: [1, 30],
})

/** Candidate commits considered by a gc run. */
export const MegarepoStoreGcCandidateCommits = attr.number({
  key: 'megarepo.store.gc.candidate_commits',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Candidate commits considered by a gc run.',
  stability: 'development',
  examples: [0, 12],
})

/** Candidate named refs considered by a gc run. */
export const MegarepoStoreGcCandidateNamedRefs = attr.number({
  key: 'megarepo.store.gc.candidate_named_refs',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Candidate named refs considered by a gc run.',
  stability: 'development',
  examples: [0, 8],
})

// -- test store fixture --
/** Number of repositories in a hermetic store fixture. */
export const MegarepoTestStoreFixtureRepoCount = attr.number({
  key: 'megarepo.test.store_fixture.repo_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of repositories in a hermetic store fixture.',
  stability: 'development',
  examples: [1, 3],
})

/** Repository being set up inside a store fixture. */
export const MegarepoTestStoreFixtureRepo = attr.string({
  key: 'megarepo.test.store_fixture.repo',
  cardinality: 'high',
  brief: 'Repository being set up inside a store fixture.',
  stability: 'development',
  examples: ['origin', 'upstream'],
})

/** Number of branches in a store-fixture repository. */
export const MegarepoTestStoreFixtureBranchCount = attr.number({
  key: 'megarepo.test.store_fixture.branch_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of branches in a store-fixture repository.',
  stability: 'development',
  examples: [1, 4],
})

/** Number of tags in a store-fixture repository. */
export const MegarepoTestStoreFixtureTagCount = attr.number({
  key: 'megarepo.test.store_fixture.tag_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of tags in a store-fixture repository.',
  stability: 'development',
  examples: [0, 2],
})

/** Number of commits in a store-fixture repository. */
export const MegarepoTestStoreFixtureCommitCount = attr.number({
  key: 'megarepo.test.store_fixture.commit_count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of commits in a store-fixture repository.',
  stability: 'development',
  examples: [1, 10],
})

/** Whether a store-fixture repository has a remote. */
export const MegarepoTestStoreFixtureWithRemote = attr.boolean({
  key: 'megarepo.test.store_fixture.with_remote',
  brief: 'Whether a store-fixture repository has a remote.',
  stability: 'development',
})

/** Setup phase of a store-fixture repository. */
export const MegarepoTestStoreFixturePhase = attr.enum({
  key: 'megarepo.test.store_fixture.phase',
  values: [
    'init-bare',
    'init-upstream',
    'init-source',
    'push-refs',
    'fetch-store-bare',
    'create-worktrees',
    'create-commit-worktrees',
  ],
  briefs: {
    'init-bare': 'Initialize the bare repository.',
    'init-upstream': 'Initialize the upstream remote.',
    'init-source': 'Initialize the source repository.',
    'push-refs': 'Push refs into the store bare.',
    'fetch-store-bare': 'Fetch into the store bare.',
    'create-worktrees': 'Create worktrees.',
    'create-commit-worktrees': 'Create commit worktrees.',
  },
  brief: 'Setup phase of a store-fixture repository.',
  stability: 'development',
})

// ---------------------------------------------------------------------------
// signals (operations: static-name spans; label derived from a runtime-only field)
// ---------------------------------------------------------------------------

/** The runtime-only span-label source field shared by every megarepo operation. */
const labelField = { label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()) } as const
const labelOf = (v: { label: string }): string => v.label

/** `megarepo/traversal` — a nested-megarepo traversal. */
export const TraversalOperation = operation({
  id: 'span.megarepo.traversal',
  name: 'megarepo/traversal',
  brief: 'A nested-megarepo traversal.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    root: required(MegarepoTraversalRoot),
    purpose: required(MegarepoTraversalPurpose),
    all: required(MegarepoTraversalAll),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/sync/member/clone-or-fetch` — member clone-or-fetch. */
export const SyncMemberCloneOperation = operation({
  id: 'span.megarepo.sync_member_clone',
  name: 'megarepo/sync/member/clone-or-fetch',
  brief: 'Member clone-or-fetch (bare_exists distinguishes fetch from initial clone).',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    bareExists: required(MegarepoSyncMemberBareExists),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/sync/member/resolve-ref` — member ref resolution. */
export const SyncMemberResolveRefOperation = operation({
  id: 'span.megarepo.sync_member_resolve_ref',
  name: 'megarepo/sync/member/resolve-ref',
  brief: 'Member ref resolution.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    ref: required(MegarepoSyncMemberRef),
    refType: recommended(MegarepoSyncMemberRefType),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/sync/member/create-worktree` — member worktree creation. */
export const SyncMemberCreateWorktreeOperation = operation({
  id: 'span.megarepo.sync_member_create_worktree',
  name: 'megarepo/sync/member/create-worktree',
  brief: 'Member worktree creation.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    ref: required(MegarepoSyncMemberRef),
    refType: recommended(MegarepoSyncMemberRefType),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/sync/member` — the whole per-member sync. */
export const SyncMemberOperation = operation({
  id: 'span.megarepo.sync_member',
  name: 'megarepo/sync/member',
  brief: 'The whole per-member sync (enclosing clone/resolve/create-worktree).',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    name: required(MegarepoSyncMemberName),
    source: required(MegarepoSyncMemberSource),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/test/store-fixture/create` — hermetic store-fixture creation. */
export const StoreFixtureCreateOperation = operation({
  id: 'span.megarepo.test_store_fixture_create',
  name: 'megarepo/test/store-fixture/create',
  brief: 'Creation of a hermetic store fixture.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    repoCount: required(MegarepoTestStoreFixtureRepoCount),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/test/store-fixture/repo` — one repository's setup in a store fixture. */
export const StoreFixtureRepoOperation = operation({
  id: 'span.megarepo.test_store_fixture_repo',
  name: 'megarepo/test/store-fixture/repo',
  brief: "One repository's setup inside a store fixture.",
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    storeRepo: required(MegarepoTestStoreFixtureRepo),
    branchCount: required(MegarepoTestStoreFixtureBranchCount),
    tagCount: required(MegarepoTestStoreFixtureTagCount),
    commitCount: required(MegarepoTestStoreFixtureCommitCount),
    withRemote: required(MegarepoTestStoreFixtureWithRemote),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `git/delete-branch` — a `git branch -D/-d` (megarepo-domain instrumentation). */
export const GitDeleteBranchOperation = operation({
  id: 'span.megarepo.git_delete_branch',
  name: 'git/delete-branch',
  brief: 'A `git branch -D/-d` performed by megarepo.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    branch: required(MegarepoBranch),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `git/detach-worktree-head` — a `git checkout --detach` (megarepo-domain instrumentation). */
export const GitDetachWorktreeHeadOperation = operation({
  id: 'span.megarepo.git_detach_worktree_head',
  name: 'git/detach-worktree-head',
  brief: 'A `git checkout --detach` performed by megarepo.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    worktreePath: required(MegarepoWorktreePath),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/store/gc/archive-worktree` — a cold-worktree archive move. */
export const ArchiveWorktreeOperation = operation({
  id: 'span.megarepo.store_gc_archive_worktree',
  name: 'megarepo/store/gc/archive-worktree',
  brief: 'A cold-worktree archive move.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    branch: required(MegarepoBranch),
    reason: required(MegarepoStoreGcArchiveReason),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/store/gc/scan-archives` — archive enumeration. */
export const ScanArchivesOperation = operation({
  id: 'span.megarepo.store_gc_scan_archives',
  name: 'megarepo/store/gc/scan-archives',
  brief: 'Archive enumeration.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    repoRoot: required(MegarepoRepoRoot),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/store/gc/reap-archive` — an archive hard-delete. */
export const ReapArchiveOperation = operation({
  id: 'span.megarepo.store_gc_reap_archive',
  name: 'megarepo/store/gc/reap-archive',
  brief: 'An archive hard-delete.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    path: required(MegarepoStoreGcArchivePath),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/store/gc/cold-reclaim-repo` — one repo's cold-reclaim pass. */
export const ColdReclaimRepoOperation = operation({
  id: 'span.megarepo.store_gc_cold_reclaim_repo',
  name: 'megarepo/store/gc/cold-reclaim-repo',
  brief: "One repo's cold-reclaim pass.",
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    storeRepo: required(MegarepoStoreRepo),
    bareRepoPath: required(MegarepoStoreBareRepoPath),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/store/gc/resolve-pr-state` — a per-branch PR-state lookup. */
export const ResolvePrStateOperation = operation({
  id: 'span.megarepo.store_gc_resolve_pr_state',
  name: 'megarepo/store/gc/resolve-pr-state',
  brief: 'A per-branch PR-state lookup.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    branch: required(MegarepoBranch),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/store/gc/unpushed-commit-count` — the unpushed-commit count. */
export const UnpushedCommitCountOperation = operation({
  id: 'span.megarepo.store_gc_unpushed_commit_count',
  name: 'megarepo/store/gc/unpushed-commit-count',
  brief: 'The unpushed-commit count for a worktree HEAD.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    worktreeHead: required(MegarepoWorktreeHead),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/store/gc/assess-lossless` — the lossless-floor assessment. */
export const AssessLosslessOperation = operation({
  id: 'span.megarepo.store_gc_assess_lossless',
  name: 'megarepo/store/gc/assess-lossless',
  brief: 'The lossless-floor assessment for a worktree.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    worktreePath: required(MegarepoWorktreePath),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/sync` — a whole sync run. */
export const SyncOperation = operation({
  id: 'span.megarepo.sync',
  name: 'megarepo/sync',
  brief: 'A whole sync run.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    root: required(MegarepoRoot),
    mode: required(MegarepoSyncMode),
    depth: required(MegarepoSyncDepth),
    dryRun: required(MegarepoCliDryRun),
    all: required(MegarepoCliAll),
    force: required(MegarepoCliForce),
  },
  labelFields: labelField,
  label: labelOf,
})

/** `megarepo/store/gc` — a whole `mr store gc` invocation (applied as a ROOT span at runtime). */
export const StoreGcOperation = operation({
  id: 'span.megarepo.store_gc',
  name: 'megarepo/store/gc',
  brief: 'A whole `mr store gc` invocation.',
  stability: 'development',
  span_kind: 'internal',
  attributes: {
    policy: required(MegarepoStoreGcPolicy),
    dryRun: required(MegarepoCliDryRun),
    force: required(MegarepoCliForce),
    all: required(MegarepoCliAll),
  },
  labelFields: labelField,
  label: labelOf,
})

// ---------------------------------------------------------------------------
// metric (labels reference the SAME catalog attributes as spans; decision 0003)
// ---------------------------------------------------------------------------

/**
 * `megarepo_store_gc_rss_bytes` — resident-set gauge sampled across a gc run. `repo_concurrency`
 * is a bounded label so a parameter sweep produces one comparable series per operating point
 * (decision 0007). The bare metric label `repo_concurrency` is renamed to the namespaced catalog
 * key `megarepo.store.gc.repo_concurrency` (retention-first, decisions 0003/0004).
 */
export const StoreGcRssGauge = metric({
  id: 'metric.megarepo.store_gc_rss',
  name: 'megarepo_store_gc_rss_bytes',
  instrument: 'gauge',
  unit: 'By',
  brief: 'Resident set size (bytes) sampled during mr store gc/status.',
  stability: 'development',
  labels: {
    repoConcurrency: required(MegarepoStoreGcRepoConcurrency),
  },
})

// ---------------------------------------------------------------------------
// contract seam (namespace `megarepo`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/megarepo',
  displayName: 'Megarepo Attributes',
  signals: [
    TraversalOperation,
    SyncMemberCloneOperation,
    SyncMemberResolveRefOperation,
    SyncMemberCreateWorktreeOperation,
    SyncMemberOperation,
    StoreFixtureCreateOperation,
    StoreFixtureRepoOperation,
    GitDeleteBranchOperation,
    GitDetachWorktreeHeadOperation,
    ArchiveWorktreeOperation,
    ScanArchivesOperation,
    ReapArchiveOperation,
    ColdReclaimRepoOperation,
    ResolvePrStateOperation,
    UnpushedCommitCountOperation,
    AssessLosslessOperation,
    SyncOperation,
    StoreGcOperation,
    StoreGcRssGauge,
  ],
  // Keys reaching the catalog ONLY via a DYNAMIC-NAME bridge span or an annotate-only bundle
  // (no static single-signal open-ref carries them). Catalog completeness (SC-R13).
  docOnlyAttributes: [
    // withCommandSpan / annotateCommand (dynamic name) + withStoreSourceSpan (porcelain)
    MegarepoCliCommand,
    MegarepoCliOutput,
    MegarepoCliPorcelain,
    MegarepoMember,
    MegarepoRepo,
    // withRepoPathSpan / withWorkspaceSpan (dynamic name)
    MegarepoRepoPath,
    MegarepoWorkspaceRoot,
    // annotate-only: megarepoTraversalResultAttrs
    MegarepoTraversalNodesVisited,
    MegarepoTraversalCyclesSkipped,
    MegarepoTraversalMaxDepth,
    // annotate-only: syncMemberActionAttrs / syncMemberResultAttrs
    MegarepoSyncMemberAction,
    MegarepoSyncMemberResultStatus,
    // withStoreWorktreeSpan / withStoreSourceSpan (dynamic name)
    MegarepoStoreRefType,
    MegarepoStoreRef,
    MegarepoStoreWorktreePath,
    MegarepoStoreWorktreeBroken,
    MegarepoStoreSource,
    MegarepoStoreBaseRef,
    MegarepoStoreCommit,
    // withStoreLiveSetSpan (dynamic name)
    MegarepoStoreHasCurrentWorkspace,
    MegarepoStorePruneStaleRegistry,
    MegarepoStoreRefreshCurrentWorkspace,
    // annotate-only: storeGitWorktreeListFailureAttrs
    MegarepoStoreGitWorktreeListFailed,
    // withStoreGcPhaseSpan (dynamic name)
    MegarepoStoreGcPhase,
    MegarepoStoreGcRepoCount,
    MegarepoStoreGcWorktreeCount,
    // annotate-only: storeGcResultAttrs
    MegarepoStoreGcRootSetWorkspaceCount,
    MegarepoStoreGcRepoTotal,
    MegarepoStoreGcWorktreeDiscovered,
    MegarepoStoreGcResultTotal,
    MegarepoStoreGcResultRemoved,
    MegarepoStoreGcResultSkippedInUse,
    MegarepoStoreGcResultSkippedDirty,
    MegarepoStoreGcResultArchived,
    MegarepoStoreGcResultReaped,
    MegarepoStoreGcResultKept,
    MegarepoStoreGcCandidateCommits,
    MegarepoStoreGcCandidateNamedRefs,
    // storeFixturePhase (dynamic name)
    MegarepoTestStoreFixturePhase,
  ],
})
