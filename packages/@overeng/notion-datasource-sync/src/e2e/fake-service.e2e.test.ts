import { Cause, Chunk, Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { pageSurfaceKey, propertySurfaceKey, schemaSurfaceKey } from '../core/canonical.ts'
import { PatchDataSourceSchemaCommand, RestorePageCommand } from '../core/commands.ts'
import { AbsolutePath, PropertyName } from '../core/domain.ts'
import { SyncEvent } from '../core/events.ts'
import {
  LocalWorkspacePort,
  NotionDataSourceGateway,
  PageBodySyncPort,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import {
  planIntent,
  type OutboxCommandEnvelope,
  type PlannerProjectionSnapshot,
  type SchemaMigrationIntent,
} from '../planner/planner.ts'
import { hashStoreBytes, pageLifecycleHash } from '../store/projections.ts'
import { executeOutboxOnce } from '../sync/executor.ts'
import { observeRemoteDataSource } from '../sync/observation.ts'
import {
  bodyAdapterResultIntent,
  bodyLocalChangeInput,
  bodySafety,
  buildPlannerSnapshot,
  defaultQueryContract,
  hash,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  propertyEditIntent,
  queryAbsenceIntent,
  querySurface,
  remoteWriteAttemptedEvent,
  remoteWriteSettledEvent,
  testIds,
  appendPlannedCommand,
  bodyPointer,
  decode,
  localDeleteIntent,
} from '../testing/harness.ts'
import {
  assertAllCoreGuardsHaveScenarioEntries,
  concreteScenarioMatrixGaps,
  concreteScenarioReferenceGaps,
  e2eHarnessScenarios,
  guardScenarioCoverageGaps,
  invalidScenarioRequirementIdGaps,
  placeholderGuardScenarioReferenceGaps,
  requirementTraceabilityGaps,
  scenarioImplementationGaps,
  traceabilityResiduals,
  type GuardScenarioEntry,
  type ScenarioId,
  type ScenarioMetadata,
} from '../testing/scenarios.ts'

const collectStream = <TValue, TError>(
  stream: Stream.Stream<TValue, TError>,
): Promise<ReadonlyArray<TValue>> =>
  Effect.runPromise(stream.pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray)))

const expectGatewayFailure = (
  result: Awaited<ReturnType<typeof Effect.runPromiseExit>>,
  expected: {
    readonly operation?: string
    readonly guard?: string
  },
) => {
  expect(result._tag).toBe('Failure')
  if (result._tag === 'Failure') {
    expect(Chunk.toReadonlyArray(Cause.failures(result.cause)).at(0)).toMatchObject({
      _tag: 'NotionGatewayError',
      ...expected,
    })
  }
}

const implementedFakeScenarioIds = new Set<ScenarioId>([
  'NDS-L2-clean-pull-status',
  'NDS-L2-local-property-edit-enqueue',
  'NDS-L2-same-property-conflict',
  'NDS-L2-disjoint-property-merge',
  'NDS-L2-query-cap-blocks-absence',
  'NDS-L2-filtered-absence-not-proof',
  'NDS-L2-incomplete-scan-not-proof',
  'NDS-L2-permission-ambiguity-fail-closed',
  'NDS-L2-direct-tombstone-classification',
  'NDS-L2-membership-lost-restored',
  'NDS-L2-body-adapter-surface-leak',
  'NDS-L2-local-delete-candidate-only',
  'NDS-L2-schema-destructive-fail-closed',
  'NDS-L2-page-property-pagination-fail-closed',
  'NDS-L3-outbox-trash-restore-settles',
  'NDS-L3-outbox-invalid-settlement-rejected',
  'NDS-L3-outbox-property-patch-settles',
  'NDS-L3-outbox-stale-base-blocks',
  'NDS-L3-outbox-read-after-write-mismatch',
  'NDS-L3-outbox-crash-after-attempt-recovery',
  'NDS-L3-outbox-legacy-running-lease-fence',
])

const expectedPatchHash = () =>
  hashStoreBytes(`page-properties\t${testIds.pageId}\t${testIds.commandId}\t${testIds.propertyA}`)

const plannedPropertyCommand = () => {
  const decision = planIntent({ snapshot: buildPlannerSnapshot(), intent: propertyEditIntent({ desiredHash: expectedPatchHash() }), })
  expect(decision._tag).toBe('EnqueueCommands')
  if (decision._tag !== 'EnqueueCommands') return undefined

  return decision.commands[0]!
}

const plannedRestoreCommand = (): OutboxCommandEnvelope => {
  const command = decode({ schema: RestorePageCommand, value: {
    _tag: 'RestorePageCommand',
    commandId: testIds.commandId,
    pageId: testIds.pageId,
    basePropertiesHash: hash('properties-a'),
  } })

  return {
    commandId: testIds.commandId,
    commandKey: testIds.commandKey,
    rootId: testIds.rootId,
    intentEventId: testIds.intentEventId,
    surface: pageSurfaceKey(testIds.pageId),
    command,
    baseHash: hash('properties-a'),
    desiredHash: pageLifecycleHash({ pageId: testIds.pageId, inTrash: false }),
    preflight: ['CapabilityPreflightFailed', 'StaleSurfaceBase', 'DeleteVsEdit'],
  }
}

const schemaMigrationIntent = (
  overrides: Partial<SchemaMigrationIntent> = {},
): SchemaMigrationIntent => {
  const command = decode({ schema: PatchDataSourceSchemaCommand, value: {
    _tag: 'PatchDataSourceSchemaCommand',
    commandId: testIds.commandId,
    dataSourceId: testIds.dataSourceId,
    baseSchemaHash: hash('schema'),
    schemaPatch: {
      [testIds.propertyA]: {
        _tag: 'CanonicalDataSourceProperty',
        propertyId: testIds.propertyA,
        name: decode({ schema: PropertyName, value: 'Name' }),
        type: 'title',
        configHash: hash('config-a-next'),
      },
    },
  } })

  return {
    _tag: 'schema-migration',
    intentEventId: testIds.intentEventId,
    commandKey: testIds.commandKey,
    surface: schemaSurfaceKey({ dataSourceId: testIds.dataSourceId, propertyId: testIds.propertyA }),
    dataSourceId: testIds.dataSourceId,
    affectedPropertyIds: [testIds.propertyA],
    command,
    baseHash: hash('schema'),
    desiredHash: hash('schema-next'),
    safety: {
      affectsLocalIntent: false,
      destructiveMigrationRequired: false,
      optionDeletionLosesValues: false,
    },
    ...overrides,
  }
}

const observeFakeRemote = async ({
  inTrash = false,
  materializeBodies = true,
  configHash = hash('config-a'),
}: {
  readonly inTrash?: boolean
  readonly materializeBodies?: boolean
  readonly configHash?: ReturnType<typeof hash>
} = {}) => {
  const gatewayHarness = makeFakeGatewayHarness({
    pages: [pageSnapshot({ inTrash })],
  })
  const ports = makeHarnessPorts()

  return await Effect.runPromise(
    observeRemoteDataSource({
      rootId: testIds.rootId,
      dataSourceId: testIds.dataSourceId,
      workspaceRoot: decode({ schema: AbsolutePath, value: '/workspace' }),
      queryContract: defaultQueryContract(),
      schemaProperties: [
        {
          propertyId: testIds.propertyA,
          configHash,
          writeClass: 'writable',
        },
      ],
      materializeBodies,
      now: () => new Date('2026-05-25T00:00:00.000Z'),
    }).pipe(
      Effect.provideService(NotionDataSourceGateway, gatewayHarness.gateway),
      Effect.provideService(PageBodySyncPort, ports.body),
      Effect.provideService(LocalWorkspacePort, ports.workspace),
    ),
  )
}

const legacyRunningAttemptedEvent = () =>
  decode({ schema: SyncEvent, value: {
    _tag: 'RemoteWriteAttempted',
    eventId: 'event-legacy-running-without-lease',
    rootId: testIds.rootId,
    sequence: '0',
    codecVersion: 'v1',
    family: 'CommandAttempted',
    eventType: 'RemoteWriteAttempted',
    idempotencyKey: 'attempt:cmd-1:1:legacy-running',
    surface: pageSurfaceKey(testIds.pageId),
    causedByEventIds: [],
    payloadHash: hash('legacy-running'),
    payload: {
      _tag: 'VersionedJson',
      codecVersion: 'v1',
      canonicalJson: '{"attempt":"event-legacy-running-without-lease"}',
    },
    observedAt: '2026-05-25T00:00:00.000Z',
    commandId: testIds.commandId,
    attempt: 1,
    attemptState: 'running',
  } })

const runExecutor = ({
  gateway,
  body,
  store,
  leaseToken = 'lease-1',
  leaseDurationMs = 60_000,
}: {
  readonly gateway: NotionDataSourceGatewayShape
  readonly body: PageBodySyncPortShape
  readonly store: ReturnType<typeof makeStoreFixture>['store']
  readonly leaseToken?: string
  readonly leaseDurationMs?: number
}) =>
  Effect.runPromise(
    executeOutboxOnce({
      store,
      rootId: testIds.rootId,
      leaseToken,
      leaseDurationMs,
    }).pipe(
      Effect.provideService(NotionDataSourceGateway, gateway),
      Effect.provideService(PageBodySyncPort, body),
    ),
  )

describe('notion datasource sync fake-service E2E harness', () => {
  it('keeps typed scenario metadata in lockstep with guard and requirement coverage', () => {
    assertAllCoreGuardsHaveScenarioEntries({
      file: 'src/e2e/fake-service.e2e.test.ts',
      implementedScenarioIds: implementedFakeScenarioIds,
    })

    expect(guardScenarioCoverageGaps()).toEqual([])
    expect(concreteScenarioReferenceGaps()).toEqual([])
    expect(placeholderGuardScenarioReferenceGaps()).toEqual([])
    expect(concreteScenarioMatrixGaps()).toEqual([])
    expect(invalidScenarioRequirementIdGaps()).toEqual([])
    expect(requirementTraceabilityGaps()).toEqual([])
    expect(
      scenarioImplementationGaps({
        file: 'src/e2e/fake-service.e2e.test.ts',
        implementedScenarioIds: implementedFakeScenarioIds,
      }),
    ).toEqual([])
    expect(e2eHarnessScenarios.map((entry) => entry.scenarioId)).toContain(
      'NDS-L2-local-property-edit-enqueue',
    )
    expect(
      e2eHarnessScenarios.find((entry) => entry.scenarioId === 'NDS-L2-query-cap-blocks-absence')
        ?.requirementIds,
    ).toEqual(['R71'])
    expect(
      e2eHarnessScenarios.find((entry) => entry.scenarioId === 'NDS-L2-filtered-absence-not-proof')
        ?.requirementIds,
    ).toEqual(['R73'])
    expect(
      traceabilityResiduals.filter((entry) => entry._tag === 'unmapped-requirement').length,
    ).toBeGreaterThan(0)
  })

  it('fails traceability when placeholders, concrete mappings, or requirement IDs are invalid', () => {
    expect(
      concreteScenarioReferenceGaps({
        entries: [
          {
            guard: 'StaleSurfaceBase',
            scenarioId: 'NDS-L2-missing-scenario',
            requirementIds: ['R21'],
            lowestPlannerLevel: 'L1',
            highestIntegrationLevel: 'L2',
          },
        ] satisfies ReadonlyArray<GuardScenarioEntry>,
      }),
    ).toEqual([
      {
        _tag: 'missing-declared-guard-scenario-reference',
        guard: 'StaleSurfaceBase',
        scenarioId: 'NDS-L2-missing-scenario',
      },
    ])
    expect(
      placeholderGuardScenarioReferenceGaps({
        entries: [
          {
            guard: 'PermissionAmbiguous',
            scenarioId: 'NDS-GUARD-permission-ambiguous',
            requirementIds: ['R41'],
            lowestPlannerLevel: 'L1',
            highestIntegrationLevel: 'L2',
          },
        ],
        residuals: [],
      }),
    ).toEqual([
      {
        _tag: 'placeholder-guard-scenario-reference',
        guard: 'PermissionAmbiguous',
        scenarioId: 'NDS-GUARD-permission-ambiguous',
      },
    ])
    expect(
      concreteScenarioMatrixGaps({
        entries: [
          {
            guard: 'StaleSurfaceBase',
            scenarioId: 'NDS-L2-clean-pull-status',
            requirementIds: ['R24'],
            lowestPlannerLevel: 'L1',
            highestIntegrationLevel: 'L2',
          },
        ],
        scenarios: e2eHarnessScenarios,
      }),
    ).toEqual([
      {
        _tag: 'unmapped-concrete-guard',
        guard: 'StaleSurfaceBase',
        scenarioId: 'NDS-L2-clean-pull-status',
      },
      {
        _tag: 'unmapped-concrete-requirement',
        guard: 'StaleSurfaceBase',
        scenarioId: 'NDS-L2-clean-pull-status',
        requirementId: 'R24',
      },
    ])
    expect(
      invalidScenarioRequirementIdGaps([
        {
          scenarioId: 'NDS-L2-clean-pull-status',
          title: 'bad requirement fixture',
          requirementIds: ['R74'],
          guards: [],
          lowestPlannerLevel: 'L2',
          highestIntegrationLevel: 'L3',
          file: 'src/e2e/fake-service.e2e.test.ts',
        },
      ] as ReadonlyArray<ScenarioMetadata>),
    ).toEqual([
      {
        _tag: 'invalid-scenario-requirement-id',
        scenarioId: 'NDS-L2-clean-pull-status',
        requirementId: 'R74',
      },
    ])
    expect(requirementTraceabilityGaps({ scenarios: [], residuals: [] })).toContainEqual({
      _tag: 'unmapped-requirement',
      requirementId: 'R01',
    })
  })

  it('composes fake gateway, body adapter, workspace, clock, and SQLite store for clean status', async () => {
    const gatewayHarness = makeFakeGatewayHarness()
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      const dataSource = await Effect.runPromise(
        gatewayHarness.gateway.retrieveDataSource(testIds.dataSourceId),
      )
      const queryPages = await collectStream(
        gatewayHarness.gateway.queryRows({
          _tag: 'QueryRowsInput',
          dataSourceId: testIds.dataSourceId,
          queryContract: defaultQueryContract(),
          startCursor: null,
        }),
      )
      const body = await Effect.runPromise(
        ports.body.observe({ _tag: 'ObserveBodyInput', pageId: testIds.pageId }),
      )
      const localObservations = await collectStream(
        ports.workspace.scan(decode({ schema: AbsolutePath, value: '/tmp/notion-ds-sync-fixture' })),
      )

      expect({
        dataSourceId: dataSource.dataSourceId,
        rowCount: queryPages.flatMap((page) => page.rows).length,
        terminal: queryPages.at(-1)?.hasMore === false,
        bodyHash: body.bodyHash,
        localObservationCount: localObservations.length,
        outbox: storeFixture.store.readOutbox(testIds.rootId),
      }).toMatchObject({
        dataSourceId: testIds.dataSourceId,
        rowCount: 1,
        terminal: true,
        bodyHash: hash('body-a'),
        localObservationCount: 0,
        outbox: [],
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keys remote observations by projection-affecting schema, lifecycle, and sidecar state', async () => {
    const base = await observeFakeRemote({ materializeBodies: false })
    const materialized = await observeFakeRemote({ materializeBodies: true })
    const trashed = await observeFakeRemote({ inTrash: true, materializeBodies: true })
    const reconfigured = await observeFakeRemote({
      materializeBodies: true,
      configHash: hash('config-b'),
    })

    const dataSourceKey = (result: Awaited<ReturnType<typeof observeFakeRemote>>) =>
      result.events.find((event) => event._tag === 'DataSourceObserved')?.idempotencyKey
    const metadataKey = (result: Awaited<ReturnType<typeof observeFakeRemote>>) =>
      result.events.find((event) => event._tag === 'DataSourceMetadataObserved')?.idempotencyKey
    const rowKey = (result: Awaited<ReturnType<typeof observeFakeRemote>>) =>
      result.events.find((event) => event._tag === 'RowObserved')?.idempotencyKey

    expect(dataSourceKey(base)).not.toBe(dataSourceKey(reconfigured))
    expect(metadataKey(base)).toBe(metadataKey(reconfigured))
    expect(rowKey(base)).not.toBe(rowKey(materialized))
    expect(rowKey(materialized)).not.toBe(rowKey(trashed))
  })

  it('plans and persists a local property edit as one guarded outbox command', () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot(), intent: propertyEditIntent() })
    expect(decision._tag).toBe('EnqueueCommands')
    if (decision._tag !== 'EnqueueCommands') return

    const storeFixture = makeStoreFixture({ mode: 'memory' })
    try {
      appendPlannedCommand({ store: storeFixture.store, command: decision.commands[0]! })

      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          state: 'queued',
          commandTag: 'PatchPageProperties',
          baseHash: hash('property-a-base'),
          desiredHash: hash('property-a-next'),
          settlementEventId: undefined,
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('opens a same-property conflict instead of enqueueing a stale write', () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot({
        properties: [
          {
            pageId: testIds.pageId,
            propertyId: testIds.propertyA,
            baseHash: hash('property-a-base'),
            remoteHash: hash('property-a-remote'),
            availability: 'complete',
            pendingLocal: undefined,
          },
        ],
      }), intent: propertyEditIntent(), })

    expect(decision).toMatchObject({
      _tag: 'OpenConflict',
      conflict: { kind: 'same-property' },
    })
  })

  it('keeps disjoint property remote changes mergeable and enqueues the local write', () => {
    const snapshot = buildPlannerSnapshot({
      remoteChanges: [
        {
          _tag: 'property',
          pageId: testIds.pageId,
          propertyId: testIds.propertyB,
          baseHash: hash('property-b-base'),
          nextHash: hash('property-b-remote'),
          surface: propertySurfaceKey({ pageId: testIds.pageId, propertyId: testIds.propertyB }),
        },
      ],
    } satisfies Partial<PlannerProjectionSnapshot>)

    expect(planIntent({ snapshot: snapshot, intent: propertyEditIntent() })).toMatchObject({
      _tag: 'EnqueueCommands',
      commands: [{ commandId: testIds.commandId }],
    })
  })

  it('blocks absence classification when the query cap is reached', () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot({
        queries: [
          querySurface({
            completeness: { terminal: false, cappedAtLimit: true, contractChanged: false },
            absence: {
              classified: false,
              membershipScope: 'all-data-source-rows',
              filtered: false,
              directRetrieve: 'not-run',
            },
          }),
        ],
      }), intent: queryAbsenceIntent(), })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'QueryResultCapExceeded',
    })
  })

  it('keeps filtered absence from becoming tombstone proof', () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot({
        queries: [
          querySurface({
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              membershipScope: 'all-data-source-rows',
              filtered: true,
              directRetrieve: 'accessible',
            },
          }),
        ],
      }), intent: queryAbsenceIntent(), })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'FilteredAbsenceNotProof',
    })
  })

  it('allows explicit-filter absence to stay scoped without tombstoning accessible pages', () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot({
        queries: [
          querySurface({
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              membershipScope: 'explicit-filter',
              filtered: true,
              directRetrieve: 'accessible',
            },
          }),
        ],
      }), intent: queryAbsenceIntent(), })

    expect(decision).toEqual({ _tag: 'AppendEvents', events: [] })
  })

  it('keeps incomplete query scans from producing tombstones', () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot({
        queries: [
          querySurface({
            completeness: { terminal: false, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              membershipScope: 'all-data-source-rows',
              filtered: false,
              directRetrieve: 'in-trash',
            },
          }),
        ],
      }), intent: queryAbsenceIntent(), })

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'PaginationIncomplete',
    })
  })

  it('fails closed on permission ambiguous query and direct page retrieval', async () => {
    const gatewayHarness = makeFakeGatewayHarness({
      permissionAmbiguousDataSourceIds: [testIds.dataSourceId],
      permissionAmbiguousPageIds: [testIds.pageId],
    })
    const queryResult = await Effect.runPromiseExit(
      gatewayHarness.gateway
        .queryRows({
          _tag: 'QueryRowsInput',
          dataSourceId: testIds.dataSourceId,
          queryContract: defaultQueryContract(),
          startCursor: null,
        })
        .pipe(Stream.runCollect),
    )
    const directResult = await Effect.runPromiseExit(
      gatewayHarness.gateway.retrievePage(testIds.pageId),
    )
    const decision = planIntent({ snapshot: buildPlannerSnapshot({
        queries: [
          querySurface({
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              membershipScope: 'all-data-source-rows',
              filtered: false,
              directRetrieve: 'permission-ambiguous',
            },
          }),
        ],
      }), intent: queryAbsenceIntent(), })

    expectGatewayFailure(queryResult, { operation: 'queryRows', guard: 'PermissionAmbiguous' })
    expectGatewayFailure(directResult, { operation: 'retrievePage', guard: 'PermissionAmbiguous' })
    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'PermissionAmbiguous',
    })
    expect(gatewayHarness.ledger.successfulTrashPages).toEqual([])
  })

  it('records directly classified remote trash as a tombstone event', () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot({
        queries: [
          querySurface({
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              membershipScope: 'all-data-source-rows',
              filtered: false,
              directRetrieve: 'in-trash',
            },
          }),
        ],
      }), intent: queryAbsenceIntent(), })

    expect(decision).toEqual({
      _tag: 'AppendEvents',
      events: [
        {
          _tag: 'TombstoneClassified',
          pageId: testIds.pageId,
          surface: queryAbsenceIntent().surface,
          reason: 'remote-trash',
        },
      ],
    })
  })

  it('keeps moved-out and restored membership distinct from remote trash', () => {
    const movedOut = planIntent({ snapshot: buildPlannerSnapshot({
        queries: [
          querySurface({
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              membershipScope: 'all-data-source-rows',
              filtered: false,
              directRetrieve: 'moved-out',
            },
          }),
        ],
      }), intent: queryAbsenceIntent(), })
    const restored = planIntent({ snapshot: buildPlannerSnapshot({
        queries: [
          querySurface({
            completeness: { terminal: true, cappedAtLimit: false, contractChanged: false },
            absence: {
              classified: true,
              membershipScope: 'all-data-source-rows',
              filtered: false,
              directRetrieve: 'accessible',
            },
          }),
        ],
      }), intent: queryAbsenceIntent(), })
    const deleteSnapshot = buildPlannerSnapshot()
    const deleteDecision = planIntent({ snapshot: buildPlannerSnapshot({
        rows: deleteSnapshot.rows.map((row) => ({
          pageId: row.pageId,
          dataSourceId: row.dataSourceId,
          propertiesHash: row.propertiesHash,
          inTrash: row.inTrash,
          movedOut: true,
          localDeleteCandidate: row.localDeleteCandidate,
        })),
      }), intent: localDeleteIntent({ explicitDestructiveIntent: true, policy: 'trustedRemoteTrash' }), })

    expect(movedOut).toMatchObject({
      _tag: 'AppendEvents',
      events: [{ _tag: 'TombstoneClassified', reason: 'moved-out' }],
    })
    expect(restored).toEqual({ _tag: 'AppendEvents', events: [] })
    expect(deleteDecision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'MoveOutNotDelete',
    })
  })

  it('rejects body adapter surface leaks and records no outbox settlement', async () => {
    const ports = makeHarnessPorts({
      bodyPages: [
        {
          pageId: testIds.pageId,
          pointer: bodyPointer(),
          requestId: testIds.requestId,
          safety: bodySafety({ adapterMutationSurfaces: ['body', 'schema'] }),
        },
      ],
    })
    const bodyPlan = await Effect.runPromise(ports.body.planLocalChange(bodyLocalChangeInput()))
    const decision = planIntent({ snapshot: buildPlannerSnapshot(), intent: bodyAdapterResultIntent(bodySafety({ adapterMutationSurfaces: ['body', 'schema'] })), })
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      expect(bodyPlan).toMatchObject({
        _tag: 'BodyConflict',
        reason: 'BodyAdapterNonBodyMutation',
      })
      expect(decision).toMatchObject({
        _tag: 'BlockedByGuard',
        guard: 'BodyAdapterNonBodyMutation',
      })
      expect(storeFixture.store.readOutbox(testIds.rootId)).toEqual([])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('turns local file delete into a candidate without remote trash', () => {
    const gatewayHarness = makeFakeGatewayHarness()
    const decision = planIntent({ snapshot: buildPlannerSnapshot(), intent: localDeleteIntent() })

    expect(decision).toEqual({
      _tag: 'AppendEvents',
      events: [
        {
          _tag: 'LocalDeleteCandidateAccepted',
          pageId: testIds.pageId,
          surface: localDeleteIntent().surface,
          reason: 'filesystem-delete-candidate',
        },
      ],
    })
    expect(gatewayHarness.ledger.attemptedTrashPages).toEqual([])
    expect(gatewayHarness.ledger.successfulTrashPages).toEqual([])
  })

  it('blocks destructive schema changes before remote schema writes are enqueued', () => {
    const gatewayHarness = makeFakeGatewayHarness()
    const destructive = planIntent({ snapshot: buildPlannerSnapshot(), intent: schemaMigrationIntent({
        safety: {
          affectsLocalIntent: false,
          destructiveMigrationRequired: true,
          optionDeletionLosesValues: false,
        },
      }), })
    const optionDeletion = planIntent({ snapshot: buildPlannerSnapshot(), intent: schemaMigrationIntent({
        safety: {
          affectsLocalIntent: false,
          destructiveMigrationRequired: false,
          optionDeletionLosesValues: true,
        },
      }), })

    expect(destructive).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'DestructiveSchemaMigrationRequired',
    })
    expect(optionDeletion).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'OptionDeletionLosesValues',
    })
    expect(gatewayHarness.ledger.attemptedPatchDataSourceSchemas).toEqual([])
    expect(gatewayHarness.ledger.successfulPatchDataSourceSchemas).toEqual([])
  })

  it('fails closed when page-property pagination is unavailable or incomplete', async () => {
    const gatewayHarness = makeFakeGatewayHarness({
      capabilities: ['data_source_retrieve', 'data_source_query', 'page_retrieve'],
    })
    const preflight = await Effect.runPromise(
      gatewayHarness.gateway.preflightCapabilities({
        _tag: 'CapabilityPreflightInput',
        dataSourceId: testIds.dataSourceId,
        requiredCapabilities: ['page_property_paginate'],
      }),
    )
    const decision = planIntent({ snapshot: buildPlannerSnapshot({
        properties: [
          {
            pageId: testIds.pageId,
            propertyId: testIds.propertyA,
            baseHash: hash('property-a-base'),
            remoteHash: hash('property-a-base'),
            availability: 'paginated-incomplete',
            pendingLocal: undefined,
          },
        ],
      }), intent: propertyEditIntent(), })

    expect(preflight.missingCapabilities).toEqual(['page_property_paginate'])
    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'PropertyValueIncomplete',
    })
    expect(gatewayHarness.ledger.attemptedPatchPageProperties).toEqual([])
  })

  it('records fake gateway remote trash attempts and successes when trash is called', async () => {
    const gatewayHarness = makeFakeGatewayHarness()
    const command = localDeleteIntent({
      explicitDestructiveIntent: true,
      policy: 'trustedRemoteTrash',
    }).command

    const requestId = await Effect.runPromise(gatewayHarness.gateway.trashPage(command))

    expect(requestId).toMatch(/^fake-req-/)
    expect(gatewayHarness.ledger.attemptedTrashPages).toEqual([command])
    expect(gatewayHarness.ledger.successfulTrashPages).toEqual([command])
  })

  it('executes trusted local delete as one settled remote trash write', async () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot(), intent: localDeleteIntent({ explicitDestructiveIntent: true, policy: 'trustedRemoteTrash' }), })
    expect(decision._tag).toBe('EnqueueCommands')
    if (decision._tag !== 'EnqueueCommands') return

    const command = decision.commands[0]!
    const gatewayHarness = makeFakeGatewayHarness()
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand({ store: storeFixture.store, command })

      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
        }),
      ).resolves.toMatchObject({
        _tag: 'settled',
        settlementKind: 'verified-success',
      })
      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
        }),
      ).resolves.toEqual({ _tag: 'idle' })

      expect(gatewayHarness.ledger.attemptedTrashPages).toEqual([command.command])
      expect(gatewayHarness.ledger.successfulTrashPages).toEqual([command.command])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          attemptCount: 1,
          state: 'settled',
          settlementEventId: expect.any(String),
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('executes restore commands as one settled remote lifecycle write', async () => {
    const command = plannedRestoreCommand()
    const gatewayHarness = makeFakeGatewayHarness({
      pages: [pageSnapshot({ inTrash: true })],
    })
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand({ store: storeFixture.store, command })

      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
        }),
      ).resolves.toMatchObject({
        _tag: 'settled',
        settlementKind: 'verified-success',
      })

      expect(gatewayHarness.ledger.attemptedRestorePages).toEqual([command.command])
      expect(gatewayHarness.ledger.successfulRestorePages).toEqual([command.command])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          attemptCount: 1,
          state: 'settled',
          settlementEventId: expect.any(String),
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('rejects invalid outbox settlement evidence in the SQLite fixture', () => {
    const decision = planIntent({ snapshot: buildPlannerSnapshot(), intent: propertyEditIntent() })
    expect(decision._tag).toBe('EnqueueCommands')
    if (decision._tag !== 'EnqueueCommands') return

    const storeFixture = makeStoreFixture({ mode: 'memory' })
    try {
      const command = decision.commands[0]!
      appendPlannedCommand({ store: storeFixture.store, command })
      storeFixture.store.appendEvent(
        remoteWriteAttemptedEvent({
          eventId: 'event-attempted-1',
          idempotencyKey: 'attempt:cmd-1:1',
          commandId: testIds.commandId,
        }),
      )
      storeFixture.store.appendEvent(
        remoteWriteSettledEvent({
          eventId: 'event-invalid-settlement',
          idempotencyKey: 'settled:cmd-1:mismatch',
          commandId: testIds.commandId,
          commandTag: 'PatchPageProperties',
          desiredHash: command.desiredHash,
          observedHash: hash('unexpected-observed'),
        }),
      )

      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          state: 'running',
          settlementEventId: undefined,
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('executes and settles a property patch from the outbox', async () => {
    const command = plannedPropertyCommand()
    if (command === undefined) return

    const gatewayHarness = makeFakeGatewayHarness()
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand({ store: storeFixture.store, command })

      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
        }),
      ).resolves.toMatchObject({
        _tag: 'settled',
        settlementKind: 'verified-success',
      })

      expect(gatewayHarness.ledger.attemptedPatchPageProperties).toEqual([command.command])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          state: 'settled',
          settlementEventId: expect.any(String),
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('blocks stale-base outbox commands without issuing duplicate remote writes', async () => {
    const command = plannedPropertyCommand()
    if (command === undefined) return

    const gatewayHarness = makeFakeGatewayHarness({
      pages: [pageSnapshot({ propertiesHash: hash('remote-properties') })],
    })
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand({ store: storeFixture.store, command })

      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
        }),
      ).resolves.toMatchObject({
        _tag: 'failed',
        attemptState: 'blocked',
        guard: 'StaleSurfaceBase',
      })

      expect(gatewayHarness.ledger.attemptedPatchPageProperties).toEqual([])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          state: 'blocked',
          settlementEventId: undefined,
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keeps read-after-write mismatch attempts unsettled', async () => {
    const command = plannedPropertyCommand()
    if (command === undefined) return

    const gatewayHarness = makeFakeGatewayHarness({
      readAfterWriteMismatchPageIds: [testIds.pageId],
    })
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand({ store: storeFixture.store, command })

      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
        }),
      ).resolves.toMatchObject({
        _tag: 'failed',
        attemptState: 'retryable',
        guard: 'ReadAfterWriteMismatch',
      })

      expect(gatewayHarness.ledger.attemptedPatchPageProperties).toEqual([command.command])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          state: 'retryable',
          settlementEventId: undefined,
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keeps same-attempt legacy running events without lease tokens fenced from the executor lease', async () => {
    const command = plannedPropertyCommand()
    if (command === undefined) return

    const gatewayHarness = makeFakeGatewayHarness({
      pages: [pageSnapshot({ propertiesHash: expectedPatchHash() })],
    })
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand({ store: storeFixture.store, command })
      expect(
        storeFixture.store.claimNextOutboxCommand({
          rootId: testIds.rootId,
          leaseToken: 'lease-1',
          leaseDurationMs: 60_000,
        }),
      ).toMatchObject({ attempt: 1, leaseToken: 'lease-1' })

      storeFixture.store.appendEvent(legacyRunningAttemptedEvent())

      expect(
        storeFixture.store.isOutboxLeaseActive({
          rootId: testIds.rootId,
          commandId: testIds.commandId,
          leaseToken: 'lease-1',
        }),
      ).toBe(true)
      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
          leaseToken: 'lease-2',
        }),
      ).resolves.toEqual({ _tag: 'idle' })
      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
          leaseToken: 'lease-2',
          leaseDurationMs: 0,
        }),
      ).resolves.toMatchObject({
        _tag: 'settled',
        settlementKind: 'verified-no-op',
      })

      expect(gatewayHarness.ledger.attemptedPatchPageProperties).toEqual([])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          attemptCount: 2,
          state: 'settled',
          settlementEventId: expect.any(String),
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('recovers a crash after a remote attempt by settling verified no-op without duplicate write', async () => {
    const command = plannedPropertyCommand()
    if (command === undefined) return

    const gatewayHarness = makeFakeGatewayHarness({
      pages: [pageSnapshot({ propertiesHash: expectedPatchHash() })],
    })
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand({ store: storeFixture.store, command })
      storeFixture.store.appendEvent(
        remoteWriteAttemptedEvent({
          eventId: 'event-crashed-attempt',
          idempotencyKey: 'attempt:cmd-1:1',
          commandId: testIds.commandId,
          attemptState: 'running',
        }),
      )

      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
          leaseToken: 'lease-2',
          leaseDurationMs: 0,
        }),
      ).resolves.toMatchObject({
        _tag: 'settled',
        settlementKind: 'verified-no-op',
      })

      expect(gatewayHarness.ledger.attemptedPatchPageProperties).toEqual([])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        {
          commandId: testIds.commandId,
          attemptCount: 2,
          state: 'settled',
          settlementEventId: expect.any(String),
        },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })
})
