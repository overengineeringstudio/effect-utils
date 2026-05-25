import { GuardName, type GuardName as GuardNameType } from '../guards.ts'

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

export const scenario = <TScenario extends ScenarioMetadata>(metadata: TScenario): TScenario =>
  metadata

export const e2eHarnessScenarios = [
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
    requirementIds: ['R21', 'R24', 'R30'],
    guards: ['StaleSurfaceBase'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
  }),
  scenario({
    scenarioId: 'NDS-L2-disjoint-property-merge',
    title: 'disjoint property edit remains enqueueable',
    requirementIds: ['R21', 'R24', 'R30'],
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
    scenarioId: 'NDS-L2-body-adapter-surface-leak',
    title: 'body adapter non-body mutation is blocked',
    requirementIds: ['R23', 'R29', 'R67'],
    guards: ['BodyAdapterNonBodyMutation'],
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
    file: 'src/e2e/fake-service.e2e.test.ts',
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
    requirementIds: ['R67', 'R68', 'R69', 'R70'],
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
  CapabilityPreflightFailed: 'NDS-LIVE-skeleton-gated-cleanup-ledger',
  UnsupportedRemoteShape: 'NDS-GUARD-unsupported-remote-shape',
  ComputedPropertyWrite: 'NDS-GUARD-computed-property-write',
  PropertyValueIncomplete: 'NDS-GUARD-property-value-incomplete',
  RelatedDataSourceUnshared: 'NDS-GUARD-related-data-source-unshared',
  StaleSurfaceBase: 'NDS-L2-same-property-conflict',
  CurrentSurfaceMissing: 'NDS-GUARD-current-surface-missing',
  PageTimestampWakeupOnly: 'NDS-GUARD-page-timestamp-wakeup-only',
  SchemaDriftAffectsIntent: 'NDS-L2-local-property-edit-enqueue',
  DestructiveSchemaMigrationRequired: 'NDS-GUARD-destructive-schema-migration-required',
  OptionDeletionLosesValues: 'NDS-GUARD-option-deletion-loses-values',
  BodyLossyRemote: 'NDS-GUARD-body-lossy-remote',
  MarkdownUnknownBlocksAmbiguous: 'NDS-GUARD-markdown-unknown-blocks-ambiguous',
  MarkdownSelectionAmbiguous: 'NDS-GUARD-markdown-selection-ambiguous',
  MarkdownWouldDeleteChildren: 'NDS-GUARD-markdown-would-delete-children',
  MarkdownSyncedPageUnsupported: 'NDS-GUARD-markdown-synced-page-unsupported',
  BodyAdapterConflict: 'NDS-GUARD-body-adapter-conflict',
  PathClaimCollision: 'NDS-GUARD-path-claim-collision',
  QueryAbsenceUnclassified: 'NDS-GUARD-query-absence-unclassified',
  PaginationIncomplete: 'NDS-GUARD-pagination-incomplete',
  QueryContractChanged: 'NDS-GUARD-query-contract-changed',
  QueryResultCapExceeded: 'NDS-L2-query-cap-blocks-absence',
  FilteredAbsenceNotProof: 'NDS-L2-filtered-absence-not-proof',
  LinkedDataSourceUnsupported: 'NDS-GUARD-linked-data-source-unsupported',
  PermissionAmbiguous: 'NDS-GUARD-permission-ambiguous',
  DeleteVsEdit: 'NDS-GUARD-delete-vs-edit',
  MoveOutNotDelete: 'NDS-GUARD-move-out-not-delete',
  UnavailableRelationTarget: 'NDS-GUARD-unavailable-relation-target',
  ExpiringFileUrl: 'NDS-GUARD-expiring-file-url',
  ReadAfterWriteMismatch: 'NDS-L3-outbox-invalid-settlement-rejected',
  AmbiguousCommandOutcome: 'NDS-L3-outbox-invalid-settlement-rejected',
  PendingIntentShadowViolation: 'NDS-GUARD-pending-intent-shadow-violation',
  BodyAdapterNonBodyMutation: 'NDS-L2-body-adapter-surface-leak',
  FilesystemDeleteAutoTrashBlocked: 'NDS-L2-local-delete-candidate-only',
  CursorSameBucketIncomplete: 'NDS-GUARD-cursor-same-bucket-incomplete',
  OwnMaterializationWriteSuppressed: 'NDS-GUARD-own-materialization-write-suppressed',
  CompactionUnsafe: 'NDS-GUARD-compaction-unsafe',
  PathEscapesRoot: 'NDS-GUARD-path-escapes-root',
  LeaseFenceMismatch: 'NDS-L3-outbox-legacy-running-lease-fence',
  OutboxFirstSettlementWins: 'NDS-L3-outbox-invalid-settlement-rejected',
  CheckpointDigestMismatch: 'NDS-GUARD-checkpoint-digest-mismatch',
  StoreMigrationBlocked: 'NDS-GUARD-store-migration-blocked',
  QueueBackpressureExceeded: 'NDS-GUARD-queue-backpressure-exceeded',
  RawPayloadRetentionUnsafe: 'NDS-LIVE-skeleton-gated-cleanup-ledger',
} as const satisfies Record<GuardNameType, ScenarioId>

const defaultGuardRequirementIds: ReadonlyArray<RequirementId> = ['R21', 'R67']

export const coreGuardScenarioEntries = (Object.keys(guardScenarioIds) as GuardNameType[]).map(
  (guard): GuardScenarioEntry => ({
    guard,
    scenarioId: guardScenarioIds[guard],
    requirementIds: defaultGuardRequirementIds,
    lowestPlannerLevel: 'L1',
    highestIntegrationLevel: 'L2',
  }),
)

export type ScenarioCoverageGap =
  | { readonly _tag: 'missing-guard-scenario'; readonly guard: GuardNameType }
  | { readonly _tag: 'unknown-guard-scenario'; readonly guard: string }
  | {
      readonly _tag: 'missing-declared-guard-scenario-reference'
      readonly guard: GuardNameType
      readonly scenarioId: ScenarioId
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
): ReadonlyArray<ScenarioCoverageGap> => {
  const scenarioIds = new Set(scenarios.map((entry) => entry.scenarioId))

  return entries
    .filter((entry) => entry.scenarioId.startsWith('NDS-GUARD-') === false)
    .filter((entry) => scenarioIds.has(entry.scenarioId) === false)
    .map((entry) => ({
      _tag: 'missing-declared-guard-scenario-reference',
      guard: entry.guard,
      scenarioId: entry.scenarioId,
    }))
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

export const allScenarioTraceabilityGaps = (input: {
  readonly file: string
  readonly implementedScenarioIds: ReadonlySet<ScenarioId>
}): ReadonlyArray<ScenarioCoverageGap> => [
  ...guardScenarioCoverageGaps(),
  ...concreteScenarioReferenceGaps(),
  ...invalidScenarioRequirementIdGaps(),
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
    ...invalidScenarioRequirementIdGaps(),
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
          case 'missing-declared-guard-scenario-reference':
            return `${gap._tag}:${gap.guard}:${gap.scenarioId}`
          case 'missing-scenario-implementation':
            return `${gap._tag}:${gap.scenarioId}:${gap.file}`
          case 'invalid-scenario-requirement-id':
            return `${gap._tag}:${gap.scenarioId}:${gap.requirementId}`
        }
      })
      .join(', ')
    throw new Error(`Scenario traceability is incomplete: ${summary}`)
  }
}
