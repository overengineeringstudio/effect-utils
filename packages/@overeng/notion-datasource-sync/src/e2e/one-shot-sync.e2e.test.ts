import { Effect, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { makeFakePageBodySyncPort } from '../body/adapter.ts'
import { PatchPagePropertiesCommand, PagePropertyItemPage } from '../core/commands.ts'
import {
  AbsolutePath,
  BodyPointer,
  WorkspaceRelativePath,
  type MaterializePlan,
} from '../core/domain.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { readOneShotSyncStatus } from '../core/status.ts'
import { allGatewayCapabilities } from '../gateway/gateway.ts'
import { makeFakeLocalWorkspacePort, presentArtifactObservation } from '../local/workspace.ts'
import { hashStoreBytes } from '../store/projections.ts'
import { initOneShotSync, pullOneShotSync, pushOneShotSync, syncOneShot } from '../sync/sync.ts'
import {
  defaultQueryContract,
  decode,
  fakeBodyPage,
  fixedObservedAt,
  hash,
  makeFakeClock,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  propertyEditIntent,
  propertyPatchValue,
  testIds,
} from '../testing/harness.ts'

const workspaceRoot = decode({ schema: AbsolutePath, value: '/tmp/notion-ds-sync-one-shot' })

const schemaProperties = [
  {
    propertyId: testIds.propertyA,
    configHash: hash('config-a'),
    writeClass: 'writable' as const,
  },
]

const propertyPage = (valueHash = hash('property-a-base')) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId: testIds.propertyA,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId: testIds.pageId,
          propertyId: testIds.propertyA,
          itemHash: valueHash,
          valueHash,
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const bodyPageFor = (pageId: typeof testIds.pageId, bodyHash = hash(`body-${pageId}`)) =>
  fakeBodyPage({
    pageId,
    pointer: decode({
      schema: BodyPointer,
      value: {
        _tag: 'BodyPointer',
        pageId,
        bodyHash,
        observedAt: fixedObservedAt,
      },
    }),
  })

const runWithPorts = <TValue, TError>(
  effect: Effect.Effect<
    TValue,
    TError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  >,
  input: {
    readonly gateway: ReturnType<typeof makeFakeGatewayHarness>['gateway']
    readonly body?: ReturnType<typeof makeHarnessPorts>['body']
    readonly workspace?: ReturnType<typeof makeHarnessPorts>['workspace']
  },
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(NotionDataSourceGateway, input.gateway),
      Effect.provideService(PageBodySyncPort, input.body ?? makeHarnessPorts().body),
      Effect.provideService(LocalWorkspacePort, input.workspace ?? makeHarnessPorts().workspace),
    ),
  )

const hidePageFromQuery = (
  gateway: ReturnType<typeof makeFakeGatewayHarness>['gateway'],
  hiddenPageId: typeof testIds.pageId,
) => ({
  ...gateway,
  queryRows: (input: Parameters<typeof gateway.queryRows>[0]) =>
    gateway.queryRows(input).pipe(
      Stream.map((page) =>
        Object.assign({}, page, {
          rows: page.rows.filter((row) => row.pageId !== hiddenPageId),
          nextCursor: null,
          hasMore: false,
          cappedAtLimit: false,
        }),
      ),
    ),
})

describe('one-shot sync orchestration', () => {
  it('initial bind and pull produce clean status while dry-run status does not write', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const inlineTitleJson = JSON.stringify({ _tag: 'title', plainText: 'Initial task' })
    const gatewayHarness = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({
          propertyValuesJson: {
            [testIds.propertyA]: inlineTitleJson,
          },
        }),
      ],
      propertyPages: [propertyPage()],
    })

    try {
      expect(
        initOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          dryRun: true,
          now: clock.now,
        }),
      ).toMatchObject({ state: 'clean', binding: undefined })
      expect(storeFixture.store.replay(testIds.rootId)).toEqual([])

      const initStatus = initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      expect(initStatus).toMatchObject({
        state: 'clean',
        binding: { dataSourceId: testIds.dataSourceId, workspaceRoot },
      })

      const pull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )

      expect(pull.status).toMatchObject({
        state: 'clean',
        counts: {
          pending: 0,
          conflict: 0,
          blocked: 0,
          projections: { dataSources: 1, rows: 1, properties: 1, bodies: 1 },
        },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('uses inline query-row property values without per-row retrievePage when bodies are disabled', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const inlineTitleJson = JSON.stringify({ _tag: 'title', plainText: 'Initial task' })
    const gatewayHarness = makeFakeGatewayHarness({
      pages: [
        pageSnapshot({
          propertyValuesJson: {
            [testIds.propertyA]: inlineTitleJson,
          },
        }),
      ],
      propertyPages: [propertyPage()],
    })
    let retrievePageCalls = 0
    const gateway = {
      ...gatewayHarness.gateway,
      retrievePage: (pageId: Parameters<typeof gatewayHarness.gateway.retrievePage>[0]) => {
        retrievePageCalls += 1
        return gatewayHarness.gateway.retrievePage(pageId)
      },
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      const pull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          materializeBodies: false,
          now: clock.now,
        }),
        { gateway },
      )

      expect(pull.status.state).toBe('clean')
      expect(pull.observation.query.rows).toBe(1)
      expect(retrievePageCalls).toBe(0)
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).properties).toEqual([
        expect.objectContaining({
          pageId: testIds.pageId,
          propertyId: testIds.propertyA,
          baseHash: hashStoreBytes(inlineTitleJson),
          remoteHash: hashStoreBytes(inlineTitleJson),
        }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('pulls a remote property change into projections and remains locally clean', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway },
      )
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        {
          gateway: makeFakeGatewayHarness({
            pages: [pageSnapshot({ propertiesHash: hash('properties-remote') })],
            propertyPages: [propertyPage(hash('property-a-remote'))],
          }).gateway,
        },
      )

      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).properties).toEqual([
        {
          pageId: testIds.pageId,
          propertyId: testIds.propertyA,
          baseHash: hash('property-a-remote'),
          remoteHash: hash('property-a-remote'),
          availability: 'complete',
          pendingLocal: undefined,
        },
      ])
      expect(storeFixture.store.readStatusProjection(testIds.rootId).outbox.queued).toBe(0)
    } finally {
      storeFixture.cleanup()
    }
  })

  it('plans, enqueues, and executes a local property edit through the fake gateway', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const expectedPropertiesHash = hashStoreBytes(
      `page-properties\t${testIds.pageId}\t${testIds.commandId}\t${testIds.propertyA}`,
    )

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )

      const command = decode({
        schema: PatchPagePropertiesCommand,
        value: {
          _tag: 'PatchPagePropertiesCommand',
          commandId: testIds.commandId,
          pageId: testIds.pageId,
          basePropertiesHash: hash('properties-a'),
          propertyPatch: { [testIds.propertyA]: propertyPatchValue('Local edit') },
        },
      })
      const push = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          localIntents: [
            propertyEditIntent({
              command,
              baseHash: hash('property-a-base'),
              desiredHash: expectedPropertiesHash,
              expectedPropertyConfigHash: hash('config-a'),
            }),
          ],
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )

      expect(push.plan).toMatchObject({ enqueuedCommands: 1, blocked: 0, conflicts: 0 })
      expect(push.executor.results).toContainEqual({
        _tag: 'settled',
        commandId: testIds.commandId,
        settlementKind: 'verified-success',
      })
      expect(gatewayHarness.ledger.successfulPatchPageProperties).toEqual([command])
      expect(push.status).toMatchObject({ state: 'clean', counts: { pending: 0 } })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('records query cap incompleteness without advancing absence or tombstone facts', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({
      queryResultCap: 1,
      pages: [
        pageSnapshot(),
        pageSnapshot({
          pageId: testIds.otherPageId,
          propertiesHash: hash('properties-other'),
        }),
      ],
      propertyPages: [propertyPage()],
    })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      const pull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )

      expect(pull.observation.query).toMatchObject({
        rows: 1,
        complete: false,
        cappedAtLimit: true,
      })
      expect(pull.status).toMatchObject({
        state: 'blocked',
        counts: {
          blocked: 2,
          tombstones: { unclassified: 0 },
          checkpoints: { incompleteQueries: 1, cappedQueries: 1 },
        },
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).tombstones).toEqual(
        [],
      )
    } finally {
      storeFixture.cleanup()
    }
  })

  it('persists missing page-property pagination capability before returning blocked', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    let retrievePagePropertyCalls = 0
    const gatewayHarness = makeFakeGatewayHarness({
      capabilities: allGatewayCapabilities.filter(
        (capability) => capability !== 'page_property_paginate',
      ),
      propertyPages: [propertyPage()],
    })
    const gateway = {
      ...gatewayHarness.gateway,
      retrievePageProperty: (
        input: Parameters<typeof gatewayHarness.gateway.retrievePageProperty>[0],
      ) => {
        retrievePagePropertyCalls += 1
        return gatewayHarness.gateway.retrievePageProperty(input)
      },
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      const pull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway },
      )

      expect(retrievePagePropertyCalls).toBe(0)
      expect(pull.status).toMatchObject({
        state: 'blocked',
        counts: {
          capabilities: { unsupported: 1 },
        },
      })
      expect(
        readOneShotSyncStatus({ store: storeFixture.store, rootId: testIds.rootId }).state,
      ).toBe('blocked')

      const recovered = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway },
      )

      expect(recovered.status).toMatchObject({
        state: 'clean',
        counts: { capabilities: { unsupported: 0 } },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('persists recurrent capability and page-property checkpoint failures after recovery', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const options = {
      store: storeFixture.store,
      rootId: testIds.rootId,
      dataSourceId: testIds.dataSourceId,
      workspaceRoot,
      queryContract: defaultQueryContract(),
      schemaProperties,
      now: clock.now,
    }
    const gatewayWithoutPagePropertyCapability = makeFakeGatewayHarness({
      capabilities: allGatewayCapabilities.filter(
        (capability) => capability !== 'page_property_paginate',
      ),
      propertyPages: [propertyPage()],
    }).gateway
    const gatewayWithMissingProperty = makeFakeGatewayHarness().gateway
    const gatewayWithProperty = makeFakeGatewayHarness({ propertyPages: [propertyPage()] }).gateway

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })

      await runWithPorts(pullOneShotSync(options), {
        gateway: gatewayWithoutPagePropertyCapability,
      })
      clock.advanceMillis(1)
      await runWithPorts(pullOneShotSync(options), { gateway: gatewayWithMissingProperty })
      clock.advanceMillis(1)
      const recovered = await runWithPorts(pullOneShotSync(options), {
        gateway: gatewayWithProperty,
      })
      clock.advanceMillis(1)
      const propertyFailedAgain = await runWithPorts(pullOneShotSync(options), {
        gateway: gatewayWithMissingProperty,
      })
      clock.advanceMillis(1)
      await runWithPorts(pullOneShotSync(options), {
        gateway: gatewayWithoutPagePropertyCapability,
      })

      expect(recovered.status).toMatchObject({
        state: 'clean',
        counts: {
          capabilities: { unsupported: 0 },
          checkpoints: { incompleteProperties: 0 },
        },
      })
      expect(propertyFailedAgain.status).toMatchObject({
        state: 'clean',
        counts: { checkpoints: { incompleteProperties: 1 } },
      })
      expect(
        readOneShotSyncStatus({ store: storeFixture.store, rootId: testIds.rootId }),
      ).toMatchObject({
        state: 'blocked',
        counts: {
          capabilities: { unsupported: 1 },
          checkpoints: { incompleteProperties: 1 },
        },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('directly classifies query-absence candidates and clears accessible disappearances', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const initialPages = [
      pageSnapshot(),
      pageSnapshot({ pageId: testIds.otherPageId, propertiesHash: hash('properties-other') }),
    ]
    const body = makeHarnessPorts({
      bodyPages: [bodyPageFor(testIds.pageId), bodyPageFor(testIds.otherPageId)],
    }).body

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: makeFakeGatewayHarness({ pages: initialPages }).gateway, body },
      )
      const gateway = makeFakeGatewayHarness({ pages: initialPages }).gateway
      const pull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: hidePageFromQuery(gateway, testIds.otherPageId), body },
      )

      expect(pull.status).toMatchObject({
        state: 'clean',
        counts: { tombstones: { unclassified: 0 } },
      })
      const snapshot = storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId)
      expect(snapshot.tombstones).toEqual([])
      expect(snapshot.queries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pageId: testIds.otherPageId,
            absence: expect.objectContaining({
              classified: true,
              directRetrieve: 'accessible',
            }),
          }),
        ]),
      )
    } finally {
      storeFixture.cleanup()
    }
  })

  it('records direct query-absence classifiers for remote trash and moved-out pages', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const initialPages = [
      pageSnapshot(),
      pageSnapshot({ pageId: testIds.otherPageId, propertiesHash: hash('properties-other') }),
    ]
    const body = makeHarnessPorts({
      bodyPages: [bodyPageFor(testIds.pageId), bodyPageFor(testIds.otherPageId)],
    }).body

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: makeFakeGatewayHarness({ pages: initialPages }).gateway, body },
      )

      const trashedGateway = makeFakeGatewayHarness({
        pages: [
          pageSnapshot(),
          pageSnapshot({
            pageId: testIds.otherPageId,
            propertiesHash: hash('properties-other-trashed'),
            inTrash: true,
          }),
        ],
      }).gateway
      const trashedPull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: hidePageFromQuery(trashedGateway, testIds.otherPageId), body },
      )

      expect(trashedPull.status).toMatchObject({
        state: 'clean',
        counts: { tombstones: { unclassified: 0 } },
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).tombstones).toEqual([
        expect.objectContaining({
          pageId: testIds.otherPageId,
          state: 'remote-trash',
          directRetrieve: 'in-trash',
        }),
      ])

      const movedGateway = makeFakeGatewayHarness({
        pages: [
          pageSnapshot(),
          pageSnapshot({
            pageId: testIds.otherPageId,
            dataSourceId: testIds.otherDataSourceId,
            propertiesHash: hash('properties-other-moved'),
          }),
        ],
      }).gateway
      const movedPull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: movedGateway, body },
      )

      expect(movedPull.status).toMatchObject({
        state: 'clean',
        counts: { tombstones: { unclassified: 0 } },
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).tombstones).toEqual([
        expect.objectContaining({
          pageId: testIds.otherPageId,
          state: 'moved-out',
          directRetrieve: 'moved-out',
        }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keeps permission-ambiguous query absence blocked with classifier evidence', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const initialPages = [
      pageSnapshot(),
      pageSnapshot({ pageId: testIds.otherPageId, propertiesHash: hash('properties-other') }),
    ]
    const body = makeHarnessPorts({
      bodyPages: [bodyPageFor(testIds.pageId), bodyPageFor(testIds.otherPageId)],
    }).body

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: makeFakeGatewayHarness({ pages: initialPages }).gateway, body },
      )
      const ambiguousGateway = makeFakeGatewayHarness({
        pages: [pageSnapshot()],
        permissionAmbiguousPageIds: [testIds.otherPageId],
      }).gateway
      const pull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: ambiguousGateway, body },
      )

      expect(pull.status).toMatchObject({
        state: 'blocked',
        counts: { tombstones: { unclassified: 1 } },
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).tombstones).toEqual([
        expect.objectContaining({
          pageId: testIds.otherPageId,
          state: 'candidate',
          directRetrieve: 'permission-ambiguous',
        }),
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('does not record disappearance candidates from capped query results', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const pages = [
      pageSnapshot(),
      pageSnapshot({ pageId: testIds.otherPageId, propertiesHash: hash('properties-other') }),
    ]
    const body = makeHarnessPorts({
      bodyPages: [bodyPageFor(testIds.pageId), bodyPageFor(testIds.otherPageId)],
    }).body

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: makeFakeGatewayHarness({ pages }).gateway, body },
      )
      const pull = await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties: [],
          now: clock.now,
        }),
        { gateway: makeFakeGatewayHarness({ pages, queryResultCap: 1 }).gateway, body },
      )

      expect(pull.status).toMatchObject({
        state: 'blocked',
        counts: {
          tombstones: { unclassified: 0 },
          checkpoints: { incompleteQueries: 1, cappedQueries: 1 },
        },
      })
      expect(storeFixture.store.readPlannerProjectionSnapshot(testIds.rootId).tombstones).toEqual(
        [],
      )
    } finally {
      storeFixture.cleanup()
    }
  })

  it('persists blocked planner decisions into fresh status reads', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )
      const push = await runWithPorts(
        pushOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          workspaceRoot,
          localIntents: [propertyEditIntent({ expectedPropertyConfigHash: hash('stale-config') })],
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway },
      )

      expect(push.plan).toMatchObject({ blocked: 1, enqueuedCommands: 0, conflicts: 0 })
      expect(push.status.state).toBe('blocked')
      expect(
        readOneShotSyncStatus({ store: storeFixture.store, rootId: testIds.rootId }),
      ).toMatchObject({
        state: 'blocked',
        counts: { guards: { blocked: 1 } },
      })
    } finally {
      storeFixture.cleanup()
    }
  })

  it('materializes bodies through PageBodySyncPort without datasource mutation', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const materializedPlans: MaterializePlan[] = []
    const baseWorkspace = makeFakeLocalWorkspacePort()
    const workspace = {
      ...baseWorkspace,
      materialize: (plan: MaterializePlan) =>
        baseWorkspace
          .materialize(plan)
          .pipe(Effect.tap(() => Effect.sync(() => materializedPlans.push(plan)))),
    }
    let observedBodies = 0
    const baseBody = makeFakePageBodySyncPort({ pages: [fakeBodyPage()] })
    const body = {
      ...baseBody,
      observe: (input: {
        readonly _tag: 'ObserveBodyInput'
        readonly pageId: typeof testIds.pageId
      }) =>
        baseBody.observe(input).pipe(Effect.tap(() => Effect.sync(() => (observedBodies += 1)))),
    }

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway, body, workspace },
      )

      expect(observedBodies).toBe(1)
      expect(materializedPlans).toMatchObject([
        { pageId: testIds.pageId, bodyPointer: { bodyHash: hash('body-a') } },
      ])
      expect(gatewayHarness.ledger.successfulPatchPageProperties).toEqual([])
      expect(gatewayHarness.ledger.successfulPatchDataSourceSchemas).toEqual([])
      expect(gatewayHarness.ledger.successfulTrashPages).toEqual([])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('counts only inserted body-conflict events in push summaries', async () => {
    const clock = makeFakeClock()
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })
    const localObservation = presentArtifactObservation({
      pageId: testIds.pageId,
      path: decode({ schema: WorkspaceRelativePath, value: 'page-1.nmd' }),
      contentHash: hash('body-local'),
      observedAt: decode({ schema: Schema.DateTimeUtc, value: fixedObservedAt }),
    })
    const ports = makeHarnessPorts({
      bodyPages: [fakeBodyPage({ remoteBodyHash: hash('body-remote') })],
      localObservations: [localObservation],
    })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      await runWithPorts(
        pullOneShotSync({
          store: storeFixture.store,
          rootId: testIds.rootId,
          dataSourceId: testIds.dataSourceId,
          workspaceRoot,
          queryContract: defaultQueryContract(),
          schemaProperties,
          now: clock.now,
        }),
        { gateway: gatewayHarness.gateway, body: ports.body, workspace: ports.workspace },
      )
      const pushOptions = {
        store: storeFixture.store,
        rootId: testIds.rootId,
        workspaceRoot,
        now: clock.now,
      }
      const first = await runWithPorts(pushOneShotSync(pushOptions), {
        gateway: gatewayHarness.gateway,
        body: ports.body,
        workspace: ports.workspace,
      })
      const second = await runWithPorts(pushOneShotSync(pushOptions), {
        gateway: gatewayHarness.gateway,
        body: ports.body,
        workspace: ports.workspace,
      })

      expect(first.plan).toMatchObject({ appendedEvents: 1, conflicts: 1 })
      expect(second.plan).toMatchObject({ appendedEvents: 0, conflicts: 0 })
      expect(second.status.state).toBe('conflict')
    } finally {
      storeFixture.cleanup()
    }
  })

  it('is clean and no-op on an idempotent second sync', async () => {
    const clock = makeFakeClock(fixedObservedAt)
    const storeFixture = makeStoreFixture({ mode: 'memory', now: clock.now })
    const gatewayHarness = makeFakeGatewayHarness({ propertyPages: [propertyPage()] })

    try {
      initOneShotSync({
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        now: clock.now,
      })
      const options = {
        store: storeFixture.store,
        rootId: testIds.rootId,
        dataSourceId: testIds.dataSourceId,
        workspaceRoot,
        queryContract: defaultQueryContract(),
        schemaProperties,
        now: clock.now,
      }
      const first = await runWithPorts(syncOneShot(options), { gateway: gatewayHarness.gateway })
      const eventCountAfterFirst = storeFixture.store.replay(testIds.rootId).length
      const second = await runWithPorts(syncOneShot(options), { gateway: gatewayHarness.gateway })

      expect(first.status.state).toBe('clean')
      expect(second.status.state).toBe('clean')
      expect(second.pull.appendedEvents).toBe(0)
      expect(second.push.plan).toMatchObject({
        appendedEvents: 0,
        enqueuedCommands: 0,
        blocked: 0,
        conflicts: 0,
      })
      expect(second.push.executor.results).toEqual([{ _tag: 'idle' }])
      expect(storeFixture.store.replay(testIds.rootId)).toHaveLength(eventCountAfterFirst)
    } finally {
      storeFixture.cleanup()
    }
  })
})
