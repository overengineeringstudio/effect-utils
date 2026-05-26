import { GuardName, type GuardName as GuardNameType } from '../core/guards.ts'

export type RequirementId = `R${number}`

export type VerificationLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7'

export type ScenarioId = `NDS-L${number}-${string}` | `NDS-GUARD-${string}` | `NDS-LIVE-${string}`

export type ScenarioMetadata = {
  readonly scenarioId: ScenarioId
  readonly title: string
  readonly requirementIds: ReadonlyArray<RequirementId>
  readonly guards: ReadonlyArray<GuardNameType>
  readonly lowestPlannerLevel: VerificationLevel
  readonly highestIntegrationLevel: VerificationLevel
  readonly file: string
}

export type GuardScenarioEntry = {
  readonly guard: GuardNameType
  readonly scenarioId: ScenarioId
  readonly requirementIds: ReadonlyArray<RequirementId>
  readonly lowestPlannerLevel: VerificationLevel
  readonly highestIntegrationLevel: VerificationLevel
}

export type TraceabilityResidual =
  | {
      readonly _tag: 'placeholder-guard-scenario'
      readonly guard: GuardNameType
      readonly scenarioId: ScenarioId
      readonly requirementIds: ReadonlyArray<RequirementId>
      readonly reason: string
    }
  | {
      readonly _tag: 'unmapped-requirement'
      readonly requirementId: RequirementId
      readonly reason: string
    }

export const scenario = <TScenario extends ScenarioMetadata>(metadata: TScenario): TScenario =>
  metadata

export const e2eHarnessScenarios = [
  scenario({
    scenarioId: 'NDS-L3-one-shot-sync-orchestration',
    title: 'one-shot init pull push sync composes observation planning execution and status',
    requirementIds: ['R06', 'R09', 'R21', 'R67', 'R71'],
    guards: ['QueryResultCapExceeded', 'BodyAdapterNonBodyMutation'],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/one-shot-sync.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-cli-command-surface',
    title: 'CLI commands return stable JSON envelopes over one-shot and user-command APIs',
    requirementIds: ['R28', 'R39', 'R40', 'R48', 'R50'],
    guards: ['CurrentSurfaceMissing'],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/cli.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L5-watch-daemon-local-cycle',
    title: 'local watch daemon preserves pending work across restart and cancellation',
    requirementIds: ['R42', 'R45', 'R46', 'R47', 'R64'],
    guards: ['LeaseFenceMismatch', 'OwnMaterializationWriteSuppressed'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L5',
    file: 'src/e2e/daemon.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-doctor-guard-state',
    title: 'doctor reports clean fake daemon state and blocked guard state',
    requirementIds: ['R45', 'R48', 'R50', 'R66'],
    guards: ['CurrentSurfaceMissing'],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/daemon.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L4-realistic-initial-materialization',
    title: 'realistic initial pull materializes schema, row, property, and body state idempotently',
    requirementIds: ['R05', 'R06', 'R08', 'R14', 'R15', 'R16', 'R17', 'R21', 'R61', 'R62', 'R63'],
    guards: [],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L4',
    file: 'src/e2e/realistic-workflows.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-realistic-remote-drift-local-write',
    title: 'remote disjoint drift updates local projections before a guarded local property write',
    requirementIds: ['R09', 'R10', 'R11', 'R21', 'R23', 'R24', 'R26', 'R61', 'R62'],
    guards: [],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/realistic-workflows.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-realistic-local-remote-conflict',
    title:
      'pending local property intent survives remote same-property drift as a durable conflict',
    requirementIds: ['R09', 'R21', 'R24', 'R25', 'R27', 'R61', 'R62'],
    guards: ['StaleSurfaceBase', 'PendingIntentShadowViolation'],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/realistic-workflows.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-realistic-schema-capability-failure',
    title: 'capability and schema drift failures block before remote mutation',
    requirementIds: ['R23', 'R24', 'R29', 'R30', 'R41', 'R61', 'R66', 'R69', 'R71'],
    guards: ['CapabilityPreflightFailed', 'SchemaDriftAffectsIntent'],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/realistic-workflows.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L4-realistic-filesystem-delete-repair',
    title: 'local delete remains candidate-only while filesystem damage and repair stay local',
    requirementIds: ['R27', 'R38', 'R39', 'R40', 'R47', 'R61', 'R62', 'R63'],
    guards: ['FilesystemDeleteAutoTrashBlocked', 'PathClaimCollision', 'PathEscapesRoot'],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L4',
    file: 'src/e2e/realistic-workflows.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L5-realistic-daemon-restart-cancellation',
    title: 'daemon restart and cancellation preserve durable work and fence unsafe settlement',
    requirementIds: ['R42', 'R45', 'R46', 'R47', 'R64'],
    guards: ['AmbiguousCommandOutcome', 'LeaseFenceMismatch', 'OwnMaterializationWriteSuppressed'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L5',
    file: 'src/e2e/daemon.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-clean-pull-status',
    title: 'fake gateway/body/workspace produce a clean pull status shape',
    requirementIds: ['R02', 'R06', 'R21', 'R67'],
    guards: [],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-local-property-edit-enqueue',
    title: 'local property edit plans one guarded outbox command',
    requirementIds: ['R09', 'R21', 'R24'],
    guards: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'SchemaDriftAffectsIntent'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-same-property-conflict',
    title: 'same-property local and remote edits open a conflict',
    requirementIds: ['R21', 'R24'],
    guards: ['StaleSurfaceBase'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-disjoint-property-merge',
    title: 'disjoint property edit remains enqueueable',
    requirementIds: ['R21', 'R24'],
    guards: [],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-query-cap-blocks-absence',
    title: 'query result cap blocks absence classification',
    requirementIds: ['R71'],
    guards: ['QueryResultCapExceeded'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-filtered-absence-not-proof',
    title: 'filtered absence is not tombstone proof',
    requirementIds: ['R73'],
    guards: ['FilteredAbsenceNotProof'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-incomplete-scan-not-proof',
    title: 'incomplete query scans cannot classify tombstones',
    requirementIds: ['R36', 'R71'],
    guards: ['PaginationIncomplete'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-permission-ambiguity-fail-closed',
    title: 'permission ambiguous query and direct retrieval fail closed',
    requirementIds: ['R37', 'R41', 'R69'],
    guards: ['PermissionAmbiguous'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-direct-tombstone-classification',
    title: 'direct lifecycle classification records remote trash tombstones',
    requirementIds: ['R37', 'R40'],
    guards: [],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-membership-lost-restored',
    title: 'moved-out and restored membership are not local delete proof',
    requirementIds: ['R37', 'R40', 'R73'],
    guards: ['MoveOutNotDelete'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-body-adapter-surface-leak',
    title: 'body adapter non-body mutation is blocked',
    requirementIds: ['R23', 'R29', 'R67'],
    guards: ['BodyAdapterNonBodyMutation'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-body-adapter-fail-closed-boundary',
    title: 'body adapter extraction and rendering fail closed when safety is unproven',
    requirementIds: ['R02', 'R23', 'R29', 'R66'],
    guards: [
      'BodyLossyRemote',
      'MarkdownUnknownBlocksAmbiguous',
      'MarkdownSelectionAmbiguous',
      'MarkdownWouldDeleteChildren',
      'MarkdownSyncedPageUnsupported',
      'BodyAdapterConflict',
    ],
    lowestPlannerLevel: 'L2',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/body-adapter.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-local-delete-candidate-only',
    title: 'local delete candidate does not enqueue remote trash by default',
    requirementIds: ['R36', 'R37', 'R71'],
    guards: ['FilesystemDeleteAutoTrashBlocked'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L4',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-schema-destructive-fail-closed',
    title: 'destructive schema migration requests fail closed before remote schema writes',
    requirementIds: ['R33', 'R35'],
    guards: ['DestructiveSchemaMigrationRequired', 'OptionDeletionLosesValues'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-page-property-pagination-fail-closed',
    title: 'incomplete page-property pagination blocks local property writes',
    requirementIds: ['R71'],
    guards: ['PropertyValueIncomplete'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-outbox-trash-restore-settles',
    title: 'trusted trash and restore commands settle after lifecycle verification',
    requirementIds: ['R11', 'R24', 'R40'],
    guards: ['OutboxFirstSettlementWins'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-outbox-invalid-settlement-rejected',
    title: 'invalid outbox settlement evidence is ignored',
    requirementIds: ['R09', 'R10', 'R62'],
    guards: ['ReadAfterWriteMismatch', 'AmbiguousCommandOutcome', 'OutboxFirstSettlementWins'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-outbox-property-patch-settles',
    title: 'outbox executor verifies and settles a property patch',
    requirementIds: ['R09', 'R10', 'R11', 'R21', 'R24'],
    guards: ['OutboxFirstSettlementWins'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-outbox-stale-base-blocks',
    title: 'outbox executor blocks stale-base writes before mutation',
    requirementIds: ['R10', 'R21', 'R24'],
    guards: ['StaleSurfaceBase'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-outbox-read-after-write-mismatch',
    title: 'outbox executor keeps read-after-write mismatches unsettled',
    requirementIds: ['R10', 'R11', 'R21'],
    guards: ['ReadAfterWriteMismatch'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-outbox-crash-after-attempt-recovery',
    title: 'outbox executor recovers a crash after remote attempt without duplicate writes',
    requirementIds: ['R10', 'R11', 'R21'],
    guards: ['AmbiguousCommandOutcome', 'OutboxFirstSettlementWins'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L3-outbox-legacy-running-lease-fence',
    title: 'outbox executor fences legacy running events that lack lease tokens',
    requirementIds: ['R10', 'R11', 'R21'],
    guards: ['LeaseFenceMismatch'],
    lowestPlannerLevel: 'L3',
    highestIntegrationLevel: 'L3',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-LIVE-skeleton-gated-cleanup-ledger',
    title: 'live Notion skeleton is secret gated and records sanitized cleanup ledger shape',
    requirementIds: ['R52', 'R65', 'R67', 'R68', 'R69', 'R70'],
    guards: ['CapabilityPreflightFailed', 'RawPayloadRetentionUnsafe'],
    lowestPlannerLevel: 'L6',
    highestIntegrationLevel: 'L6',
    file: 'src/e2e/live-notion.e2e.test.ts',
  }),
] as const satisfies ReadonlyArray<ScenarioMetadata>

const guardScenarioIds = {
  ApiVersionUnsupported: 'NDS-GUARD-api-version-unsupported',
  ApiVersionUnverified: 'NDS-GUARD-api-version-unverified',
  ApiVersionCompatibilityMissing: 'NDS-GUARD-api-compatibility-missing',
  DecodeDriftUnsupported: 'NDS-GUARD-decode-drift-unsupported',
  CapabilityPreflightFailed: 'NDS-L3-realistic-schema-capability-failure',
  UnsupportedRemoteShape: 'NDS-GUARD-unsupported-remote-shape',
  ComputedPropertyWrite: 'NDS-GUARD-computed-property-write',
  PropertyValueIncomplete: 'NDS-L2-page-property-pagination-fail-closed',
  RelatedDataSourceUnshared: 'NDS-GUARD-related-data-source-unshared',
  StaleSurfaceBase: 'NDS-L3-realistic-local-remote-conflict',
  CurrentSurfaceMissing: 'NDS-L3-doctor-guard-state',
  PageTimestampWakeupOnly: 'NDS-GUARD-page-timestamp-wakeup-only',
  SchemaDriftAffectsIntent: 'NDS-L3-realistic-schema-capability-failure',
  DestructiveSchemaMigrationRequired: 'NDS-L2-schema-destructive-fail-closed',
  OptionDeletionLosesValues: 'NDS-L2-schema-destructive-fail-closed',
  BodyLossyRemote: 'NDS-L2-body-adapter-fail-closed-boundary',
  MarkdownUnknownBlocksAmbiguous: 'NDS-L2-body-adapter-fail-closed-boundary',
  MarkdownSelectionAmbiguous: 'NDS-L2-body-adapter-fail-closed-boundary',
  MarkdownWouldDeleteChildren: 'NDS-L2-body-adapter-fail-closed-boundary',
  MarkdownSyncedPageUnsupported: 'NDS-L2-body-adapter-fail-closed-boundary',
  BodyAdapterConflict: 'NDS-L2-body-adapter-fail-closed-boundary',
  PathClaimCollision: 'NDS-L4-realistic-filesystem-delete-repair',
  QueryAbsenceUnclassified: 'NDS-GUARD-query-absence-unclassified',
  PaginationIncomplete: 'NDS-L2-incomplete-scan-not-proof',
  QueryContractChanged: 'NDS-GUARD-query-contract-changed',
  QueryResultCapExceeded: 'NDS-L2-query-cap-blocks-absence',
  FilteredAbsenceNotProof: 'NDS-L2-filtered-absence-not-proof',
  LinkedDataSourceUnsupported: 'NDS-GUARD-linked-data-source-unsupported',
  PermissionAmbiguous: 'NDS-L2-permission-ambiguity-fail-closed',
  DeleteVsEdit: 'NDS-GUARD-delete-vs-edit',
  MoveOutNotDelete: 'NDS-L2-membership-lost-restored',
  UnavailableRelationTarget: 'NDS-GUARD-unavailable-relation-target',
  ExpiringFileUrl: 'NDS-GUARD-expiring-file-url',
  ReadAfterWriteMismatch: 'NDS-L3-outbox-invalid-settlement-rejected',
  AmbiguousCommandOutcome: 'NDS-L3-outbox-invalid-settlement-rejected',
  PendingIntentShadowViolation: 'NDS-L3-realistic-local-remote-conflict',
  BodyAdapterNonBodyMutation: 'NDS-L2-body-adapter-surface-leak',
  FilesystemDeleteAutoTrashBlocked: 'NDS-L4-realistic-filesystem-delete-repair',
  CursorSameBucketIncomplete: 'NDS-GUARD-cursor-same-bucket-incomplete',
  OwnMaterializationWriteSuppressed: 'NDS-L5-realistic-daemon-restart-cancellation',
  CompactionUnsafe: 'NDS-GUARD-compaction-unsafe',
  PathEscapesRoot: 'NDS-L4-realistic-filesystem-delete-repair',
  LeaseFenceMismatch: 'NDS-L3-outbox-legacy-running-lease-fence',
  OutboxFirstSettlementWins: 'NDS-L3-outbox-invalid-settlement-rejected',
  CheckpointDigestMismatch: 'NDS-GUARD-checkpoint-digest-mismatch',
  StoreMigrationBlocked: 'NDS-GUARD-store-migration-blocked',
  QueueBackpressureExceeded: 'NDS-GUARD-queue-backpressure-exceeded',
  RawPayloadRetentionUnsafe: 'NDS-LIVE-skeleton-gated-cleanup-ledger',
} as const satisfies Record<GuardNameType, ScenarioId>

const vrsRequirementId = (index: number): RequirementId =>
  `R${index.toString().padStart(2, '0')}` as RequirementId

export const vrsRequirementIds = Array.from({ length: 73 }, (_, index) =>
  vrsRequirementId(index + 1),
)

export const traceabilityResiduals = [
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'ApiVersionUnsupported',
    scenarioId: 'NDS-GUARD-api-version-unsupported',
    requirementIds: ['R67', 'R70'],
    reason:
      'API-version drift is covered by unit and adapter tests; fake E2E promotion is pending.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'ApiVersionUnverified',
    scenarioId: 'NDS-GUARD-api-version-unverified',
    requirementIds: ['R67', 'R70'],
    reason: 'Future API-version proof is currently unit-level and needs live smoke promotion.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'ApiVersionCompatibilityMissing',
    scenarioId: 'NDS-GUARD-api-compatibility-missing',
    requirementIds: ['R67', 'R70'],
    reason: 'Compatibility proof absence is represented as a guard but not yet an E2E scenario.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'DecodeDriftUnsupported',
    scenarioId: 'NDS-GUARD-decode-drift-unsupported',
    requirementIds: ['R68', 'R70'],
    reason: 'Decode drift needs generated malformed payload fixtures before E2E promotion.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'UnsupportedRemoteShape',
    scenarioId: 'NDS-GUARD-unsupported-remote-shape',
    requirementIds: ['R29', 'R68'],
    reason:
      'Unsupported remote shapes remain adapter/unit coverage until representative fixtures land.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'ComputedPropertyWrite',
    scenarioId: 'NDS-GUARD-computed-property-write',
    requirementIds: ['R18', 'R29'],
    reason: 'Computed property writes are unit-covered and need fake row-property fixtures.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'RelatedDataSourceUnshared',
    scenarioId: 'NDS-GUARD-related-data-source-unshared',
    requirementIds: ['R19', 'R41'],
    reason: 'Relation target sharing is not yet represented by fake-service relation fixtures.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'PageTimestampWakeupOnly',
    scenarioId: 'NDS-GUARD-page-timestamp-wakeup-only',
    requirementIds: ['R22', 'R43'],
    reason: 'Timestamp wake-up semantics are daemon-scope and await watch scenario ownership.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'QueryAbsenceUnclassified',
    scenarioId: 'NDS-GUARD-query-absence-unclassified',
    requirementIds: ['R36', 'R37'],
    reason: 'Unclassified absence remains a planner guard until pull classification wiring lands.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'QueryContractChanged',
    scenarioId: 'NDS-GUARD-query-contract-changed',
    requirementIds: ['R72', 'R73'],
    reason: 'Query contract drift needs multi-scan checkpoint fixtures.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'LinkedDataSourceUnsupported',
    scenarioId: 'NDS-GUARD-linked-data-source-unsupported',
    requirementIds: ['R05', 'R29'],
    reason: 'Linked data-source behavior needs a representative Notion shape fixture.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'DeleteVsEdit',
    scenarioId: 'NDS-GUARD-delete-vs-edit',
    requirementIds: ['R25', 'R27', 'R37'],
    reason: 'Delete-vs-edit conflict coverage is currently planner/unit scoped.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'UnavailableRelationTarget',
    scenarioId: 'NDS-GUARD-unavailable-relation-target',
    requirementIds: ['R19', 'R27'],
    reason: 'Unavailable relation target coverage needs relation pagination fixtures.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'ExpiringFileUrl',
    scenarioId: 'NDS-GUARD-expiring-file-url',
    requirementIds: ['R20', 'R52', 'R59'],
    reason: 'Expiring file URLs are not yet represented in fake property fixtures.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'CursorSameBucketIncomplete',
    scenarioId: 'NDS-GUARD-cursor-same-bucket-incomplete',
    requirementIds: ['R43', 'R71'],
    reason: 'Cursor bucket overlap is daemon/checkpoint scope.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'CompactionUnsafe',
    scenarioId: 'NDS-GUARD-compaction-unsafe',
    requirementIds: ['R08', 'R12', 'R62'],
    reason: 'Compaction safety is store/migration scope and not fake-service E2E yet.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'CheckpointDigestMismatch',
    scenarioId: 'NDS-GUARD-checkpoint-digest-mismatch',
    requirementIds: ['R08', 'R47'],
    reason: 'Checkpoint digest mismatch coverage requires repair-scan fixtures.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'StoreMigrationBlocked',
    scenarioId: 'NDS-GUARD-store-migration-blocked',
    requirementIds: ['R12', 'R62'],
    reason: 'Store migration blocking is covered by store tests and awaits E2E promotion.',
  },
  {
    _tag: 'placeholder-guard-scenario',
    guard: 'QueueBackpressureExceeded',
    scenarioId: 'NDS-GUARD-queue-backpressure-exceeded',
    requirementIds: ['R45', 'R64'],
    reason: 'Queue backpressure is daemon-scope and owned by daemon E2E hardening.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R01',
    reason: 'Package boundary is validated by package/export checks rather than fake-service E2E.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R03',
    reason: 'Client boundary is adapter architecture scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R04',
    reason: 'Domain boundary is covered by contract/unit tests.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R07',
    reason:
      'Append-only event schema is covered by store/contract tests rather than fake-service E2E.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R12',
    reason: 'Migration behavior is store/integration scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R13',
    reason: 'Raw retention is telemetry/config scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R18',
    reason:
      'Read-only/computed property write blocking remains unit-level until fake row-property fixtures land.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R19',
    reason: 'Relation availability awaits relation fixtures.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R20',
    reason: 'File-reference semantics await file property fixtures.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R22',
    reason: 'Timestamp wake-up behavior is daemon-scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R31',
    reason: 'Additive schema writes are not in current product scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R32',
    reason: 'Rename semantics need schema fixture coverage.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R34',
    reason: 'Conversion reporting needs schema migration command UX.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R43',
    reason: 'Poll overlap is daemon-scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R44',
    reason: 'Known-page scans are daemon/repair scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R72',
    reason: 'Query contract identity needs multi-scan checkpoint E2E coverage.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R49',
    reason: 'Dry-run plans are CLI/user-command scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R51',
    reason: 'Human diagnostics are CLI scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R53',
    reason: 'Shared schema reuse is package architecture scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R54',
    reason: 'Gateway port architecture is covered by contract tests.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R55',
    reason: 'Adapter independence is architecture scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R56',
    reason: 'Worker optionality is future integration scope.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R57',
    reason: 'Span coverage requires telemetry-specific checks.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R58',
    reason: 'Trace attributes require telemetry-specific checks.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R59',
    reason: 'Safe telemetry requires telemetry-specific checks.',
  },
  {
    _tag: 'unmapped-requirement',
    requirementId: 'R60',
    reason: 'Unit coverage is tracked outside the fake-service E2E matrix.',
  },
] as const satisfies ReadonlyArray<TraceabilityResidual>

const concreteScenarioById: ReadonlyMap<ScenarioId, ScenarioMetadata> = new Map(
  e2eHarnessScenarios.map((entry) => [entry.scenarioId, entry]),
)

const placeholderResidualByGuard: ReadonlyMap<
  GuardNameType,
  Extract<TraceabilityResidual, { readonly _tag: 'placeholder-guard-scenario' }>
> = new Map(
  traceabilityResiduals
    .filter((residual) => residual._tag === 'placeholder-guard-scenario')
    .map((residual) => [residual.guard, residual]),
)

const scenarioRequirementIds = (
  guard: GuardNameType,
  scenarioId: ScenarioId,
): ReadonlyArray<RequirementId> => {
  const scenarioEntry = concreteScenarioById.get(scenarioId)
  if (scenarioEntry !== undefined) {
    return scenarioEntry.requirementIds
  }

  return placeholderResidualByGuard.get(guard)?.requirementIds ?? []
}

export const coreGuardScenarioEntries = (Object.keys(guardScenarioIds) as GuardNameType[]).map(
  (guard): GuardScenarioEntry => ({
    guard,
    scenarioId: guardScenarioIds[guard],
    requirementIds: scenarioRequirementIds(guard, guardScenarioIds[guard]),
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
  }),
)

export type ScenarioCoverageGap =
  | { readonly _tag: 'missing-guard-scenario'; readonly guard: GuardNameType }
  | { readonly _tag: 'unknown-guard-scenario'; readonly guard: string }
  | {
      readonly _tag: 'placeholder-guard-scenario-reference'
      readonly guard: GuardNameType
      readonly scenarioId: ScenarioId
    }
  | {
      readonly _tag: 'missing-declared-guard-scenario-reference'
      readonly guard: GuardNameType
      readonly scenarioId: ScenarioId
    }
  | {
      readonly _tag: 'unmapped-concrete-guard'
      readonly guard: GuardNameType
      readonly scenarioId: ScenarioId
    }
  | {
      readonly _tag: 'unmapped-concrete-requirement'
      readonly guard: GuardNameType
      readonly scenarioId: ScenarioId
      readonly requirementId: RequirementId
    }
  | {
      readonly _tag: 'missing-scenario-implementation'
      readonly scenarioId: ScenarioId
      readonly file: string
    }
  | {
      readonly _tag: 'invalid-scenario-requirement-id'
      readonly scenarioId: ScenarioId
      readonly requirementId: string
    }
  | {
      readonly _tag: 'unmapped-requirement'
      readonly requirementId: RequirementId
    }
  | {
      readonly _tag: 'stale-requirement-residual'
      readonly requirementId: RequirementId
    }

export const guardScenarioCoverageGaps = (
  entries: ReadonlyArray<GuardScenarioEntry> = coreGuardScenarioEntries,
): ReadonlyArray<ScenarioCoverageGap> => {
  const knownGuards = new Set(GuardName.literals as ReadonlyArray<string>)
  const entryGuards = new Set(entries.map((entry) => entry.guard))
  const missing = (GuardName.literals as ReadonlyArray<GuardNameType>)
    .filter((guard) => entryGuards.has(guard) === false)
    .map((guard): ScenarioCoverageGap => ({ _tag: 'missing-guard-scenario', guard }))
  const unknown = entries
    .filter((entry) => knownGuards.has(entry.guard) === false)
    .map((entry): ScenarioCoverageGap => ({ _tag: 'unknown-guard-scenario', guard: entry.guard }))

  return [...missing, ...unknown]
}

export const concreteScenarioReferenceGaps = (
  entries: ReadonlyArray<GuardScenarioEntry> = coreGuardScenarioEntries,
  scenarios: ReadonlyArray<ScenarioMetadata> = e2eHarnessScenarios,
  residuals: ReadonlyArray<TraceabilityResidual> = traceabilityResiduals,
): ReadonlyArray<ScenarioCoverageGap> => {
  const scenarioIds = new Set(scenarios.map((entry) => entry.scenarioId))
  const residualScenarioIds = new Set(
    residuals
      .filter((residual) => residual._tag === 'placeholder-guard-scenario')
      .map((residual) => `${residual.guard}:${residual.scenarioId}`),
  )

  return entries
    .filter(
      (entry) =>
        scenarioIds.has(entry.scenarioId) === false &&
        residualScenarioIds.has(`${entry.guard}:${entry.scenarioId}`) === false,
    )
    .map((entry) => ({
      _tag: 'missing-declared-guard-scenario-reference',
      guard: entry.guard,
      scenarioId: entry.scenarioId,
    }))
}

export const placeholderGuardScenarioReferenceGaps = (
  entries: ReadonlyArray<GuardScenarioEntry> = coreGuardScenarioEntries,
  residuals: ReadonlyArray<TraceabilityResidual> = traceabilityResiduals,
): ReadonlyArray<ScenarioCoverageGap> => {
  const residualScenarioIds = new Set(
    residuals
      .filter((residual) => residual._tag === 'placeholder-guard-scenario')
      .map((residual) => `${residual.guard}:${residual.scenarioId}`),
  )

  return entries
    .filter((entry) => entry.scenarioId.startsWith('NDS-GUARD-'))
    .filter((entry) => residualScenarioIds.has(`${entry.guard}:${entry.scenarioId}`) === false)
    .map((entry) => ({
      _tag: 'placeholder-guard-scenario-reference',
      guard: entry.guard,
      scenarioId: entry.scenarioId,
    }))
}

export const concreteScenarioMatrixGaps = (
  entries: ReadonlyArray<GuardScenarioEntry> = coreGuardScenarioEntries,
  scenarios: ReadonlyArray<ScenarioMetadata> = e2eHarnessScenarios,
): ReadonlyArray<ScenarioCoverageGap> => {
  const scenarioEntries = new Map(scenarios.map((entry) => [entry.scenarioId, entry] as const))

  return entries.flatMap((entry) => {
    if (entry.scenarioId.startsWith('NDS-GUARD-') === true) {
      return []
    }

    const scenarioEntry = scenarioEntries.get(entry.scenarioId)
    if (scenarioEntry === undefined) {
      return []
    }

    const guardGaps = scenarioEntry.guards.includes(entry.guard) === true
      ? []
      : [
          {
            _tag: 'unmapped-concrete-guard' as const,
            guard: entry.guard,
            scenarioId: entry.scenarioId,
          },
        ]
    const requirementGaps = entry.requirementIds
      .filter((requirementId) => scenarioEntry.requirementIds.includes(requirementId) === false)
      .map((requirementId) => ({
        _tag: 'unmapped-concrete-requirement' as const,
        guard: entry.guard,
        scenarioId: entry.scenarioId,
        requirementId,
      }))

    return [...guardGaps, ...requirementGaps]
  })
}

export const scenarioImplementationGaps = ({
  file,
  implementedScenarioIds,
  scenarios = e2eHarnessScenarios,
}: {
  readonly file: string
  readonly implementedScenarioIds: ReadonlySet<ScenarioId>
  readonly scenarios?: ReadonlyArray<ScenarioMetadata>
}): ReadonlyArray<ScenarioCoverageGap> =>
  scenarios
    .filter((entry) => entry.file === file)
    .filter((entry) => implementedScenarioIds.has(entry.scenarioId) === false)
    .map((entry) => ({
      _tag: 'missing-scenario-implementation',
      scenarioId: entry.scenarioId,
      file: entry.file,
    }))

export const invalidScenarioRequirementIdGaps = (
  scenarios: ReadonlyArray<ScenarioMetadata> = e2eHarnessScenarios,
): ReadonlyArray<ScenarioCoverageGap> =>
  scenarios.flatMap((entry) =>
    entry.requirementIds
      .filter((requirementId) => {
        const match = /^R([0-9]{2})$/.exec(requirementId)
        if (match?.[1] === undefined) return true

        const requirementNumber = Number.parseInt(match[1], 10)
        return requirementNumber < 1 || requirementNumber > 73
      })
      .map((requirementId) => ({
        _tag: 'invalid-scenario-requirement-id',
        scenarioId: entry.scenarioId,
        requirementId,
      })),
  )

export const requirementTraceabilityGaps = (
  scenarios: ReadonlyArray<ScenarioMetadata> = e2eHarnessScenarios,
  residuals: ReadonlyArray<TraceabilityResidual> = traceabilityResiduals,
): ReadonlyArray<ScenarioCoverageGap> => {
  const mappedRequirementIds = new Set(scenarios.flatMap((entry) => entry.requirementIds))
  const residualRequirementIds = new Set(
    residuals
      .filter((residual) => residual._tag === 'unmapped-requirement')
      .map((residual) => residual.requirementId),
  )
  const missing = vrsRequirementIds
    .filter((requirementId) => mappedRequirementIds.has(requirementId) === false)
    .filter((requirementId) => residualRequirementIds.has(requirementId) === false)
    .map((requirementId) => ({
      _tag: 'unmapped-requirement' as const,
      requirementId,
    }))
  const stale = [...residualRequirementIds]
    .filter((requirementId) => mappedRequirementIds.has(requirementId))
    .map((requirementId) => ({
      _tag: 'stale-requirement-residual' as const,
      requirementId,
    }))

  return [...missing, ...stale]
}

export const allScenarioTraceabilityGaps = (input: {
  readonly file: string
  readonly implementedScenarioIds: ReadonlySet<ScenarioId>
}): ReadonlyArray<ScenarioCoverageGap> => [
  ...guardScenarioCoverageGaps(),
  ...concreteScenarioReferenceGaps(),
  ...placeholderGuardScenarioReferenceGaps(),
  ...concreteScenarioMatrixGaps(),
  ...invalidScenarioRequirementIdGaps(),
  ...requirementTraceabilityGaps(),
  ...scenarioImplementationGaps(input),
]

export const assertAllCoreGuardsHaveScenarioEntries = (input?: {
  readonly file?: string
  readonly implementedScenarioIds?: ReadonlySet<ScenarioId>
  readonly entries?: ReadonlyArray<GuardScenarioEntry>
}): void => {
  const guardEntries = input?.entries ?? coreGuardScenarioEntries
  const gaps = [
    ...guardScenarioCoverageGaps(guardEntries),
    ...concreteScenarioReferenceGaps(guardEntries),
    ...placeholderGuardScenarioReferenceGaps(guardEntries),
    ...concreteScenarioMatrixGaps(guardEntries),
    ...invalidScenarioRequirementIdGaps(),
    ...requirementTraceabilityGaps(),
    ...(input?.file === undefined || input.implementedScenarioIds === undefined
      ? []
      : scenarioImplementationGaps({
          file: input.file,
          implementedScenarioIds: input.implementedScenarioIds,
        })),
  ]
  if (gaps.length > 0) {
    const summary = gaps
      .map((gap) => {
        switch (gap._tag) {
          case 'missing-guard-scenario':
          case 'unknown-guard-scenario':
            return `${gap._tag}:${gap.guard}`
          case 'placeholder-guard-scenario-reference':
          case 'missing-declared-guard-scenario-reference':
            return `${gap._tag}:${gap.guard}:${gap.scenarioId}`
          case 'unmapped-concrete-guard':
            return `${gap._tag}:${gap.guard}:${gap.scenarioId}`
          case 'unmapped-concrete-requirement':
            return `${gap._tag}:${gap.guard}:${gap.scenarioId}:${gap.requirementId}`
          case 'missing-scenario-implementation':
            return `${gap._tag}:${gap.scenarioId}:${gap.file}`
          case 'invalid-scenario-requirement-id':
            return `${gap._tag}:${gap.scenarioId}:${gap.requirementId}`
          case 'unmapped-requirement':
          case 'stale-requirement-residual':
            return `${gap._tag}:${gap.requirementId}`
        }
      })
      .join(', ')
    throw new Error(`Scenario traceability is incomplete: ${summary}`)
  }
}
