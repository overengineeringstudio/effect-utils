import { Chunk, Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { propertySurfaceKey } from '../canonical.ts'
import { AbsolutePath } from '../domain.ts'
import { planIntent, type PlannerProjectionSnapshot } from '../planner.ts'
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
  concreteScenarioReferenceGaps,
  e2eHarnessScenarios,
  guardScenarioCoverageGaps,
  invalidScenarioRequirementIdGaps,
  scenarioImplementationGaps,
  type GuardScenarioEntry,
  type ScenarioId,
  type ScenarioMetadata,
} from '../testing/scenarios.ts'

const collectStream = <TValue, TError>(
  stream: Stream.Stream<TValue, TError>,
): Promise<ReadonlyArray<TValue>> =>
  Effect.runPromise(stream.pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray)))

const implementedFakeScenarioIds = new Set<ScenarioId>([
  'NDS-L2-clean-pull-status',
  'NDS-L2-local-property-edit-enqueue',
  'NDS-L2-same-property-conflict',
  'NDS-L2-disjoint-property-merge',
  'NDS-L2-query-cap-blocks-absence',
  'NDS-L2-filtered-absence-not-proof',
  'NDS-L2-body-adapter-surface-leak',
  'NDS-L2-local-delete-candidate-only',
  'NDS-L3-outbox-invalid-settlement-rejected',
])

describe('notion datasource sync fake-service E2E harness', () => {
  it('keeps typed scenario metadata in lockstep with guard and requirement coverage', () => {
    assertAllCoreGuardsHaveScenarioEntries({
      file: 'src/e2e/fake-service.e2e.test.ts',
      implementedScenarioIds: implementedFakeScenarioIds,
    })

    expect(guardScenarioCoverageGaps()).toEqual([])
    expect(concreteScenarioReferenceGaps()).toEqual([])
    expect(invalidScenarioRequirementIdGaps()).toEqual([])
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
  })

  it('fails traceability when concrete guard mappings or requirement IDs are invalid', () => {
    expect(
      concreteScenarioReferenceGaps([
        {
          guard: 'StaleSurfaceBase',
          scenarioId: 'NDS-L2-missing-scenario',
          requirementIds: ['R21'],
          lowestPlannerLevel: 'L1',
          highestIntegrationLevel: 'L2',
        },
      ] satisfies ReadonlyArray<GuardScenarioEntry>),
    ).toEqual([
      {
        _tag: 'missing-declared-guard-scenario-reference',
        guard: 'StaleSurfaceBase',
        scenarioId: 'NDS-L2-missing-scenario',
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
        ports.workspace.scan(decode(AbsolutePath, '/tmp/notion-ds-sync-fixture')),
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

  it('plans and persists a local property edit as one guarded outbox command', () => {
    const decision = planIntent(buildPlannerSnapshot(), propertyEditIntent())
    expect(decision._tag).toBe('EnqueueCommands')
    if (decision._tag !== 'EnqueueCommands') return

    const storeFixture = makeStoreFixture({ mode: 'memory' })
    try {
      appendPlannedCommand(storeFixture.store, decision.commands[0]!)

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
    const decision = planIntent(
      buildPlannerSnapshot({
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
      }),
      propertyEditIntent(),
    )

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
          surface: propertySurfaceKey(testIds.pageId, testIds.propertyB),
        },
      ],
    } satisfies Partial<PlannerProjectionSnapshot>)

    expect(planIntent(snapshot, propertyEditIntent())).toMatchObject({
      _tag: 'EnqueueCommands',
      commands: [{ commandId: testIds.commandId }],
    })
  })

  it('blocks absence classification when the query cap is reached', () => {
    const decision = planIntent(
      buildPlannerSnapshot({
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
      }),
      queryAbsenceIntent(),
    )

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'QueryResultCapExceeded',
    })
  })

  it('keeps filtered absence from becoming tombstone proof', () => {
    const decision = planIntent(
      buildPlannerSnapshot({
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
      }),
      queryAbsenceIntent(),
    )

    expect(decision).toMatchObject({
      _tag: 'BlockedByGuard',
      guard: 'FilteredAbsenceNotProof',
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
    const decision = planIntent(
      buildPlannerSnapshot(),
      bodyAdapterResultIntent(bodySafety({ adapterMutationSurfaces: ['body', 'schema'] })),
    )
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
    const decision = planIntent(buildPlannerSnapshot(), localDeleteIntent())

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

  it('rejects invalid outbox settlement evidence in the SQLite fixture', () => {
    const decision = planIntent(buildPlannerSnapshot(), propertyEditIntent())
    expect(decision._tag).toBe('EnqueueCommands')
    if (decision._tag !== 'EnqueueCommands') return

    const storeFixture = makeStoreFixture({ mode: 'memory' })
    try {
      const command = decision.commands[0]!
      appendPlannedCommand(storeFixture.store, command)
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
})
