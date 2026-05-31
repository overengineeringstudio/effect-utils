import { e2eHarnessScenarios, type ScenarioId } from './scenarios.ts'

/** Execution surface used to prove a bidirectional sync safety scenario. */
export type BidiSafetyTier = 'fake' | 'replica' | 'daemon' | 'live'

/** Failure mode that a bidirectional sync scenario is intended to cover. */
export type BidiSafetyRisk =
  | 'false-conflict'
  | 'lost-update'
  | 'silent-delete'
  | 'local-overwrite'
  | 'user-data-loss'
  | 'missed-inbound'
  | 'duplicate-remote-write'
  | 'global-wedge'
  | 'stale-projection'

/** Canonical scenario row for the bidirectional sync safety matrix. */
export type BidiSafetyScenario = {
  readonly scenarioId: ScenarioId
  readonly tier: BidiSafetyTier
  readonly risk: BidiSafetyRisk
  readonly initialState: string
  readonly localAction: string
  readonly remoteAction: string
  readonly requiredAssertions: ReadonlyArray<string>
}

const bidiScenario = <TScenario extends BidiSafetyScenario>(scenario: TScenario): TScenario =>
  scenario

/** Canonical bidirectional safety matrix. Each row names a data-loss or liveness risk that must stay covered by at least one registered E2E scenario. */
export const bidiSafetyScenarios = [
  bidiScenario({
    scenarioId: 'NDS-L4-bidi-clean-outbound-after-remote-observation',
    tier: 'replica',
    risk: 'false-conflict',
    initialState: 'remote-only property observation has advanced the materialized value',
    localAction: 'edit the same property through the public SQLite rows surface',
    remoteAction: 'none',
    requiredAssertions: [
      'the local intent captures the observed value as its base hash',
      'the remote receives exactly one guarded patch',
      'no same-property conflict opens',
      'the public change settles only after read-after-write verification',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L4-bidi-same-property-race-conflict',
    tier: 'replica',
    risk: 'lost-update',
    initialState: 'SQLite and Notion agree on one property base hash',
    localAction: 'edit the property through the public SQLite rows surface',
    remoteAction: 'edit the same Notion property before the local patch executes',
    requiredAssertions: [
      'the executor re-reads the remote surface before mutation',
      'no remote patch is attempted after the base mismatch',
      'the local change becomes a durable open conflict',
      'both local desired and remote observed values remain inspectable',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L4-bidi-disjoint-property-merge',
    tier: 'replica',
    risk: 'lost-update',
    initialState: 'SQLite and Notion agree on two independent property surfaces',
    localAction: 'edit property A through SQLite',
    remoteAction: 'edit property B through Notion before the next cycle',
    requiredAssertions: [
      'property A patches remotely after preflight',
      'property B observes locally without rollback',
      'no conflict opens because surfaces are disjoint',
      'projection rebuild preserves both values',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L4-bidi-archive-edit-race',
    tier: 'replica',
    risk: 'silent-delete',
    initialState: 'a row is live and locally materialized',
    localAction: 'archive or restore the row through SQLite lifecycle CDC',
    remoteAction: 'edit, archive, or restore the same page concurrently',
    requiredAssertions: [
      'delete-vs-edit opens a conflict or guard before destructive mutation',
      'restore clears tombstones only after observation',
      'a remote edit is not discarded by lifecycle settlement',
      'Notion trash state changes only through explicit lifecycle commands',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L6-bidi-body-local-capture-first',
    tier: 'live',
    risk: 'local-overwrite',
    initialState:
      'an established workspace has a materialized .nmd body and remote body observation',
    localAction: 'edit the .nmd body before established sync observes remote state',
    remoteAction: 'remote body or property state changes before the next sync cycle',
    requiredAssertions: [
      'sync captures the local .nmd content before body materialization',
      'the local body edit becomes pending body intent or recoverable conflict material',
      'remote body materialization does not overwrite the edited .nmd',
      'the mutation ledger contains no non-allowlisted Notion writes',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L5-bidi-watermark-boundary-overlap',
    tier: 'daemon',
    risk: 'missed-inbound',
    initialState: 'a complete checkpoint exists at a timestamp shared by multiple rows',
    localAction: 'none',
    remoteAction: 'edit multiple rows in the same last_edited_time bucket',
    requiredAssertions: [
      'incremental polling uses an inclusive boundary',
      'the whole boundary bucket is drained before checkpoint advance',
      'dedupe prevents duplicate materialized events',
      'no row in the shared bucket is skipped',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L5-bidi-incremental-absence-not-tombstone',
    tier: 'daemon',
    risk: 'silent-delete',
    initialState: 'a full-membership checkpoint and existing row projection exist',
    localAction: 'none',
    remoteAction: 'no changed row appears in an incremental high-watermark poll',
    requiredAssertions: [
      'incremental omission records no query absence',
      'no tombstone candidate is emitted',
      'classified tombstones are never downgraded by incremental scans',
      'a scheduled full reconcile remains the only query-absence source',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L5-bidi-relation-pagination-scoped-block',
    tier: 'daemon',
    risk: 'global-wedge',
    initialState: 'one relation-style property has incomplete page-property pagination',
    localAction: 'edit an unrelated property through SQLite',
    remoteAction: 'page-property pagination fails or returns no resumable cursor',
    requiredAssertions: [
      'the root watch state does not become globally blocked solely by that diagnostic',
      'writes to the incomplete property remain guarded',
      'writes to unrelated complete properties remain eligible',
      'the diagnostic carries enough property identity to repair or retry explicitly',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L3-bidi-ambiguous-write-idempotency',
    tier: 'fake',
    risk: 'duplicate-remote-write',
    initialState: 'an outbox command is claimed and the process crashes after remote success',
    localAction: 'retry the same local create, update, or lifecycle command',
    remoteAction: 'remote state already reflects the desired command',
    requiredAssertions: [
      'retry performs read-before-write reconciliation',
      'verified no-op settlement does not issue a duplicate remote mutation',
      'ambiguous evidence never marks an unverified write as applied',
      'first valid settlement wins',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L4-bidi-conflict-resolution-lifecycle',
    tier: 'replica',
    risk: 'stale-projection',
    initialState: 'a same-surface conflict is open and visible in the replica',
    localAction: 'insert a supported conflict resolution row',
    remoteAction: 'none',
    requiredAssertions: [
      'resolution appends an event instead of mutating conflict state in place',
      'the originating public local change leaves active pending status',
      'unsupported choose-local/manual choices fail closed until post-write verification exists',
      'resolved conflicts remain auditable without keeping the watch state conflicted',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L4-bidi-rebuild-replay-safety',
    tier: 'replica',
    risk: 'stale-projection',
    initialState: 'event log contains observations, tombstones, conflicts, and terminal changes',
    localAction: 'rebuild all public and private projections from the event log',
    remoteAction: 'none',
    requiredAssertions: [
      'classified tombstones remain classified',
      'property base hashes reflect clean observations unless pinned by unresolved local intents',
      'open conflicts and resolved conflicts keep their expected public visibility',
      'terminal local changes do not re-enter pending sync',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L5-bidi-local-first-slow-pull',
    tier: 'daemon',
    risk: 'stale-projection',
    initialState: 'public SQLite CDC is pending while remote full pull is slow',
    localAction: 'edit, create, or archive a row through SQLite',
    remoteAction: 'remote query latency exceeds the interactive target',
    requiredAssertions: [
      'watch mode drains eligible local work before waiting for full pull completion',
      'remote preflight still happens before mutation',
      'the public change settles within the local-first latency budget',
      'remote pull eventually reconciles the same state without duplicate writes',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L5-bidi-inline-hydration-correctness',
    tier: 'daemon',
    risk: 'missed-inbound',
    initialState: 'query rows include full property values for changed and unchanged rows',
    localAction: 'none',
    remoteAction: 'return query payloads with inline values and selective incomplete properties',
    requiredAssertions: [
      'complete inline values avoid unnecessary per-row retrieve calls',
      'incomplete or unsupported values trigger scoped hydration or guards',
      'unchanged rows still count as observed for checkpoint completeness',
      'rate-limit or retry responses do not become data facts',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L6-tasks-tracker-read-only-downsync',
    tier: 'live',
    risk: 'user-data-loss',
    initialState: 'an existing Tasks Tracker database contains non-scratch rows',
    localAction: 'run read-only/downsync verification against the existing database',
    remoteAction: 'none',
    requiredAssertions: [
      'the remote mutation ledger is empty',
      'sampled non-scratch page ids keep last_edited_time and in_trash state',
      'selected stable properties are unchanged by direct Notion reads',
      'no body materialization or cleanup targets non-scratch rows',
    ],
  }),
  bidiScenario({
    scenarioId: 'NDS-L6-tasks-tracker-scratch-row-bidi',
    tier: 'live',
    risk: 'user-data-loss',
    initialState: 'one Tasks Tracker scratch row is identified by a unique run marker and page id',
    localAction: 'edit only the scratch row through SQLite rows and .nmd body content',
    remoteAction: 'verify or mutate only the allowlisted scratch row for the scenario',
    requiredAssertions: [
      'every SQL write is scoped by the scratch row page id',
      'the Notion mutation ledger targets only the scratch row page id',
      'sampled non-scratch rows are unchanged before and after the run',
      'cleanup archives or restores only the scratch row and remains auditable',
    ],
  }),
] as const satisfies ReadonlyArray<BidiSafetyScenario>

/** Returns matrix scenarios that do not yet have a registered E2E harness entry. */
export const bidiSafetyScenarioCoverageGaps = ({
  scenarios = bidiSafetyScenarios,
  registeredScenarioIds = new Set(e2eHarnessScenarios.map((entry) => entry.scenarioId)),
}: {
  readonly scenarios?: ReadonlyArray<BidiSafetyScenario>
  readonly registeredScenarioIds?: ReadonlySet<ScenarioId>
} = {}): ReadonlyArray<BidiSafetyScenario> =>
  scenarios.filter((scenario) => registeredScenarioIds.has(scenario.scenarioId) === false)
