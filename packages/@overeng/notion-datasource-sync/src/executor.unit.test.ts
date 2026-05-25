import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { executeOutboxOnce } from './executor.ts'
import { planIntent } from './planner.ts'
import {
  NotionDataSourceGateway,
  PageBodySyncPort,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from './ports.ts'
import { hashStoreBytes } from './store-projections.ts'
import {
  appendPlannedCommand,
  buildPlannerSnapshot,
  hash,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  propertyEditIntent,
  testIds,
} from './testing/harness.ts'

const expectedPatchHash = () =>
  hashStoreBytes(`page-properties\t${testIds.pageId}\t${testIds.commandId}\t${testIds.propertyA}`)

const plannedPropertyCommand = (desiredHash: ReturnType<typeof expectedPatchHash>) => {
  const decision = planIntent(buildPlannerSnapshot(), propertyEditIntent({ desiredHash }))
  if (decision._tag !== 'EnqueueCommands') {
    throw new Error(`Expected property edit to enqueue a command, got ${decision._tag}`)
  }

  return decision.commands[0]!
}

const runExecutor = ({
  gateway,
  body,
  store,
  leaseDurationMs = 60_000,
}: {
  readonly gateway: NotionDataSourceGatewayShape
  readonly body: PageBodySyncPortShape
  readonly store: ReturnType<typeof makeStoreFixture>['store']
  readonly leaseDurationMs?: number
}) =>
  Effect.runPromise(
    executeOutboxOnce({
      store,
      rootId: testIds.rootId,
      leaseToken: 'lease-1',
      leaseDurationMs,
    }).pipe(
      Effect.provideService(NotionDataSourceGateway, gateway),
      Effect.provideService(PageBodySyncPort, body),
    ),
  )

describe('outbox executor', () => {
  it('settles an already-applied command as a verified no-op without writing', async () => {
    const desiredHash = expectedPatchHash()
    const gatewayHarness = makeFakeGatewayHarness({
      pages: [pageSnapshot({ propertiesHash: desiredHash })],
    })
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand(storeFixture.store, plannedPropertyCommand(desiredHash))

      await expect(
        runExecutor({
          gateway: gatewayHarness.gateway,
          body: ports.body,
          store: storeFixture.store,
        }),
      ).resolves.toMatchObject({
        _tag: 'settled',
        settlementKind: 'verified-no-op',
      })

      expect(gatewayHarness.ledger.attemptedPatchPageProperties).toEqual([])
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        { commandId: testIds.commandId, state: 'settled', settlementEventId: expect.any(String) },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('blocks stale-base commands before issuing a remote write', async () => {
    const gatewayHarness = makeFakeGatewayHarness({
      pages: [pageSnapshot({ propertiesHash: hash('remote-drift') })],
    })
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand(storeFixture.store, plannedPropertyCommand(expectedPatchHash()))

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
        { commandId: testIds.commandId, state: 'blocked', settlementEventId: undefined },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('keeps read-after-write mismatches unsettled with diagnostic guard state', async () => {
    const gatewayHarness = makeFakeGatewayHarness({
      readAfterWriteMismatchPageIds: [testIds.pageId],
    })
    const ports = makeHarnessPorts()
    const storeFixture = makeStoreFixture({ mode: 'memory' })

    try {
      appendPlannedCommand(storeFixture.store, plannedPropertyCommand(expectedPatchHash()))

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

      expect(gatewayHarness.ledger.attemptedPatchPageProperties).toHaveLength(1)
      expect(storeFixture.store.readOutbox(testIds.rootId)).toMatchObject([
        { commandId: testIds.commandId, state: 'retryable', settlementEventId: undefined },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })
})
