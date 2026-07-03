/**
 * Runtime observability surface for megarepo (cli sites). Every `megarepo.*` span/metric/attribute
 * is DERIVED from the registered seam contract (`../megarepo.contract.ts`, namespace `megarepo`) —
 * the single SSOT for BOTH the Weaver registry projection AND these runtime encoders (SC-R13/R14).
 * This file holds only the runtime wrappers (attribute shaping, root-span selection, the gauge
 * bridge) plus the DYNAMIC-NAME bridges (`withCommandSpan`, `withStoreWorktreeSpan`,
 * `withStoreSourceSpan`, `withStoreGcPhaseSpan`) whose span name varies at runtime and thus stay
 * legacy inline, rebuilt from the IMPORTED catalog schema objects (identical encode).
 */
import { Duration, Effect, Option, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelMetric,
  OtelOperation,
  OtelSpan,
  type OtelAttrEncodeError,
  type OtelGaugeDefinition,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'
import { OtelConfig, sampleResource } from '@overeng/utils/node/otel'

import {
  MegarepoCliAll,
  MegarepoCliCommand,
  MegarepoCliDryRun,
  MegarepoCliForce,
  MegarepoCliOutput,
  MegarepoCliPorcelain,
  MegarepoMember,
  MegarepoRepo,
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
  MegarepoStoreRef,
  MegarepoStoreRefType,
  MegarepoStoreRepo,
  MegarepoStoreSource,
  MegarepoStoreWorktreeBroken,
  MegarepoStoreWorktreePath,
  StoreGcOperation,
  StoreGcRssGauge,
  SyncOperation,
} from '../megarepo.contract.ts'

const basename = (value: string): string =>
  value.split('/').findLast((part) => part.length > 0) ?? value

const shortRef = ({ refType, ref }: { refType: string; ref: string }): string =>
  `${refType}/${ref.length > 24 ? `${ref.slice(0, 12)}...${ref.slice(-8)}` : ref}`

/** Trailing-slash-tolerant basename, used to derive compact span labels from
 *  filesystem paths (e.g. a worktree dir → its final segment). */
export const shortPath = (value: string): string => basename(value.replace(/\/+$/, ''))

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

/** Like {@link trustedWith} but forces a ROOT span (used for the top-level `megarepo/store/gc`). */
const trustedWithRoot =
  <S extends Schema.Schema.AnyNoContext>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }): (<A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    trustOtelContract<A, E, R>(operation.withRoot({ attributes, effect }))

const trustedAnnotate = <S extends Schema.Schema.AnyNoContext>({
  operation,
  attributes,
}: {
  operation: OtelOperationDefinition<S>
  attributes: Schema.Schema.Type<S>
}): Effect.Effect<void> => trustOtelContract<void, never, never>(operation.annotate(attributes))

// ---- command span/annotation (DYNAMIC name for the span, static name for the annotation) ----
// The command keys reach the catalog as `docOnlyAttributes` (the command span's name varies by
// subcommand → no stable single-signal projection). Rebuilt from the imported catalog schemas.
const commandAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    command: MegarepoCliCommand,
    output: Schema.optional(MegarepoCliOutput),
    all: Schema.optional(MegarepoCliAll),
    dryRun: Schema.optional(MegarepoCliDryRun),
    force: Schema.optional(MegarepoCliForce),
    member: Schema.optional(MegarepoMember),
    repo: Schema.optional(MegarepoRepo),
  }),
)

const commandOperation = ({ name, root }: { name: string; root: boolean }) =>
  OtelOperation.define({
    name,
    attributes: commandAttrs,
    label: ({ label }) => label,
    ...(root === true ? { root: true } : {}),
  })

const commandAnnotationOperation = OtelOperation.define({
  name: 'megarepo/cli/command',
  attributes: commandAttrs,
  label: ({ label }) => label,
})

// ---- DYNAMIC-NAME BRIDGES (megarepo.store.*): span name varies → inline, rebuilt from catalog ----
const storeWorktreeAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    repo: MegarepoStoreRepo,
    refType: MegarepoStoreRefType,
    ref: MegarepoStoreRef,
    worktreePath: Schema.optional(MegarepoStoreWorktreePath),
    bareRepoPath: Schema.optional(MegarepoStoreBareRepoPath),
    broken: Schema.optional(MegarepoStoreWorktreeBroken),
  }),
)

const storeWorktreeOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: storeWorktreeAttrs,
    label: ({ label }) => label,
  })

const storeSourceAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    source: MegarepoStoreSource,
    ref: Schema.optional(MegarepoStoreRef),
    base: Schema.optional(MegarepoStoreBaseRef),
    commit: Schema.optional(MegarepoStoreCommit),
    porcelain: Schema.optional(MegarepoCliPorcelain),
  }),
)

const storeSourceOperation = (name: string) =>
  OtelOperation.define({
    name,
    attributes: storeSourceAttrs,
    label: ({ label }) => label,
  })

// ---- DERIVED static-name operations + annotate bundles ----
const syncSpan = SyncOperation.operation
const storeGcOperation = StoreGcOperation.operation

// ANNOTATE-ONLY: gc-result tallies (rebuilt from the imported catalog schemas).
const storeGcResultAttrs = OtelAttrs.defineSync(
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
)

const storeGitWorktreeListFailureAttrs = OtelAttrs.defineSync(
  Schema.Struct({ failed: MegarepoStoreGitWorktreeListFailed }),
)

/** Wrap a CLI command effect in its top-level `megarepo/cli/<command>` span.
 *  `root` makes it a trace root (for standalone subcommands); `label` defaults
 *  to the command name. */
export const withCommandSpan = ({
  name,
  command,
  label = command,
  output,
  all,
  dryRun,
  force,
  member,
  repo,
  root = false,
}: {
  name: string
  command: string
  label?: string
  output?: string
  all?: boolean
  dryRun?: boolean
  force?: boolean
  member?: string
  repo?: string
  root?: boolean
}) =>
  trustedWith({
    operation: commandOperation({ name, root }),
    attributes: {
      label,
      command,
      ...(output === undefined ? {} : { output }),
      ...(all === undefined ? {} : { all }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(force === undefined ? {} : { force }),
      ...(member === undefined ? {} : { member }),
      ...(repo === undefined ? {} : { repo }),
    },
  })

/** Wrap a sync run in a `megarepo/sync` span labelled by the megarepo root's
 *  basename, carrying the resolution mode/depth and the dry-run/all/force flags. */
export const withSyncSpan = ({
  megarepoRoot,
  mode,
  depth,
  dryRun,
  all,
  force,
}: {
  megarepoRoot: string
  mode: string
  depth: number
  dryRun: boolean
  all: boolean
  force: boolean
}) =>
  trustedWith({
    operation: syncSpan,
    attributes: {
      label: shortPath(megarepoRoot),
      root: megarepoRoot,
      mode,
      depth,
      dryRun,
      all,
      force,
    },
  })

/** Annotate the enclosing span with command attributes after the fact — used
 *  when the `command`/`output` are only known mid-effect rather than at span open. */
export const annotateCommand = ({
  label,
  command,
  output,
  all,
  dryRun,
  force,
  member,
  repo,
}: {
  label: string
  command: string
  output?: string
  all?: boolean
  dryRun?: boolean
  force?: boolean
  member?: string
  repo?: string
}) =>
  trustedAnnotate({
    operation: commandAnnotationOperation,
    attributes: {
      label,
      command,
      ...(output === undefined ? {} : { output }),
      ...(all === undefined ? {} : { all }),
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(force === undefined ? {} : { force }),
      ...(member === undefined ? {} : { member }),
      ...(repo === undefined ? {} : { repo }),
    },
  })

/** Annotate the enclosing `megarepo/store/gc` span with the run's tallies
 *  (totals, removed/skipped counts) once the sweep has completed. */
export const annotateStoreGcResult = (
  value: Schema.Schema.Type<typeof storeGcResultAttrs.schema>,
) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({ attributes: storeGcResultAttrs, value }),
  )

/** Mark the enclosing span when `git worktree list` failed, so gc runs that fell
 *  back to a degraded worktree view are queryable in the trace. */
export const annotateStoreGitWorktreeListFailure = (failed: boolean) =>
  trustOtelContract<void, never, never>(
    OtelSpan.annotate({
      attributes: storeGitWorktreeListFailureAttrs,
      value: { failed },
    }),
  )

/** Wrap a store-worktree operation in a `<name>` span; the label combines the
 *  repo basename with the short ref (`repo abbrev-ref`). */
export const withStoreWorktreeSpan = ({
  name,
  repo,
  refType,
  ref,
  worktreePath,
  bareRepoPath,
  broken,
}: {
  name: string
  repo: string
  refType: string
  ref: string
  worktreePath?: string
  bareRepoPath?: string
  broken?: boolean
}) =>
  trustedWith({
    operation: storeWorktreeOperation(name),
    attributes: {
      label: `${shortPath(repo)} ${shortRef({ refType, ref })}`,
      repo,
      refType,
      ref,
      ...(worktreePath === undefined ? {} : { worktreePath }),
      ...(bareRepoPath === undefined ? {} : { bareRepoPath }),
      ...(broken === undefined ? {} : { broken }),
    },
  })

/** Wrap an entire `mr store gc` invocation in its root `megarepo/store/gc` span,
 *  recording the retention policy and the dry-run/force/all flags. */
export const withStoreGcSpan = ({
  policy,
  dryRun,
  force,
  all,
}: {
  policy: string
  dryRun: boolean
  force: boolean
  all: boolean
}) =>
  trustedWithRoot({
    operation: storeGcOperation,
    attributes: {
      label: 'gc',
      policy,
      dryRun,
      force,
      all,
    },
  })

/** Wrap a store-source operation in a `<name>` span labelled by the source's
 *  basename, carrying the optional resolved ref/base/commit. */
export const withStoreSourceSpan = ({
  name,
  source,
  ref,
  base,
  commit,
  porcelain,
}: {
  name: string
  source: string
  ref?: string
  base?: string
  commit?: string
  porcelain?: boolean
}) =>
  trustedWith({
    operation: storeSourceOperation(name),
    attributes: {
      label: shortPath(source),
      source,
      ...(ref === undefined ? {} : { ref }),
      ...(base === undefined ? {} : { base }),
      ...(commit === undefined ? {} : { commit }),
      ...(porcelain === undefined ? {} : { porcelain }),
    },
  })

// =============================================================================
// Store GC phase spans + RSS gauge (decision 0007: bounded memory + throughput)
// =============================================================================

/** One of the gc/status pipeline phases, used as the `megarepo/store/gc/<phase>`
 *  span name suffix. */
export type StoreGcPhase =
  | 'collect-liveness'
  | 'list-repos'
  | 'collect-worktrees'
  | 'resolve-pr'
  | 'cold-reclaim'
  | 'legacy-sweep'

// DYNAMIC-NAME BRIDGE: span name is `megarepo/store/gc/<phase>` → inline, rebuilt from catalog.
const storeGcPhaseAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: spanLabel(),
    phase: MegarepoStoreGcPhase,
    repoCount: Schema.optional(MegarepoStoreGcRepoCount),
    worktreeCount: Schema.optional(MegarepoStoreGcWorktreeCount),
    repoConcurrency: Schema.optional(MegarepoStoreGcRepoConcurrency),
  }),
)

/** Wrap a gc phase in a `megarepo/store/gc/<phase>` span with bounded counts. */
export const withStoreGcPhaseSpan = ({
  phase,
  repoCount,
  worktreeCount,
  repoConcurrency,
}: {
  phase: StoreGcPhase
  repoCount?: number
  worktreeCount?: number
  repoConcurrency?: number
}) =>
  trustedWith({
    operation: OtelOperation.define({
      name: `megarepo/store/gc/${phase}`,
      attributes: storeGcPhaseAttrs,
      label: ({ label }) => label,
    }),
    attributes: {
      label: phase,
      phase,
      ...(repoCount === undefined ? {} : { repoCount }),
      ...(worktreeCount === undefined ? {} : { worktreeCount }),
      ...(repoConcurrency === undefined ? {} : { repoConcurrency }),
    },
  })

/**
 * Resident-set gauge sampled periodically across a gc run
 * (`megarepo_store_gc_rss_bytes`). A gauge (not a counter): RSS goes up and down.
 * `megarepo.store.gc.repo_concurrency` is a label so a parameter sweep produces one comparable
 * series per operating point (decision 0007 — the sweep plots RSS-vs-concurrency).
 *
 * DERIVED from the seam contract's `StoreGcRssGauge.metric` (`OtelMetric.gauge` — the sanctioned
 * path that brands the name + enforces the label cardinality policy) and bridged to a typed Effect
 * `Metric` via `OtelMetric.effect.gauge`. `trustedSet` encodes the label through the schema (no raw
 * `MetricLabel`). The bare `repo_concurrency` label was renamed to the namespaced catalog key
 * (retention-first, decisions 0003/0004).
 */
// The registry `metric()` DSL types `.metric` as the general `OtelMetricDefinition` (it does not
// narrow by instrument); this contract authors it as a gauge, so narrow it for the effect bridge.
const storeGcRssGaugeBridge = OtelMetric.effect.gauge(
  StoreGcRssGauge.metric as OtelGaugeDefinition<Schema.Schema.AnyNoContext>,
)

/**
 * Fork a fiber that samples `process.memoryUsage().rss` into the RSS gauge every `interval` for the
 * lifetime of the enclosing scope, tagged with `megarepo.store.gc.repo_concurrency` so sweep runs
 * are comparable.
 *
 * The clock/gate/fork mechanics are owned by the foundation `sampleResource` primitive: it ticks on
 * a real wall clock and no-ops when telemetry is off. The `Effect.serviceOption(OtelConfig)` read
 * here only DISCHARGES the primitive's `OtelConfig` requirement (defaulting to a telemetry-off
 * config when absent) so the gc command stays runnable without the layer.
 */
export const sampleStoreGcRss = ({
  repoConcurrency,
  interval = Duration.millis(250),
}: {
  repoConcurrency: number
  interval?: Duration.Duration
}) =>
  Effect.serviceOption(OtelConfig).pipe(
    Effect.flatMap((config) =>
      sampleResource({
        sample: Effect.sync(() => process.memoryUsage().rss).pipe(
          Effect.flatMap((rss) =>
            storeGcRssGaugeBridge.trustedSet({ labels: { repoConcurrency }, value: rss }),
          ),
        ),
        interval,
      }).pipe(
        Effect.provideService(
          OtelConfig,
          Option.getOrElse(config, () => ({ endpoint: Option.none<string>() })),
        ),
      ),
    ),
  )
