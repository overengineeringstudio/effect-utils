import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { pageSurfaceKey } from '../core/canonical.ts'
import { RestorePageCommand } from '../core/commands.ts'
import {
  NotionDataSourceGateway,
  PageBodySyncPort,
  type NotionDataSourceGatewayShape,
  type PageBodySyncPortShape,
} from '../core/ports.ts'
import { planIntent, type OutboxCommandEnvelope } from '../planner/planner.ts'
import { hashStoreBytes, pageLifecycleHash } from '../store/projections.ts'
import {
  appendPlannedCommand,
  buildPlannerSnapshot,
  decode,
  hash,
  localDeleteIntent,
  makeFakeGatewayHarness,
  makeHarnessPorts,
  makeStoreFixture,
  pageSnapshot,
  propertyEditIntent,
  testIds,
} from '../testing/harness.ts'
import { executeOutboxOnce } from './executor.ts'

const expectedPatchHash = () =>
  hashStoreBytes(`page-properties\t${testIds.pageId}\t${testIds.commandId}\t${testIds.propertyA}`)

const plannedPropertyCommand = (desiredHash: ReturnType<typeof expectedPatchHash>) => {
  const decision = planIntent({ snapshot: buildPlannerSnapshot(), intent: propertyEditIntent({ desiredHash }) })
  if (decision._tag !== 'EnqueueCommands') {
    throw new Error(`Expected property edit to enqueue a command, got ${decision._tag}`)
  }

  return decision.commands[0]!
}

const plannedTrustedTrashCommand = () => {
  const decision = planIntent({ snapshot: buildPlannerSnapshot(), intent: localDeleteIntent({ explicitDestructiveIntent: true, policy: 'trustedRemoteTrash' }), })
  if (decision._tag !== 'EnqueueCommands') {
    throw new Error(`Expected trusted local delete to enqueue a command, got ${decision._tag}`)
  }

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
      appendPlannedCommand({ store: storeFixture.store, command: plannedPropertyCommand(desiredHash) })

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
      appendPlannedCommand({ store: storeFixture.store, command: plannedPropertyCommand(expectedPatchHash()) })

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
      appendPlannedCommand({ store: storeFixture.store, command: plannedPropertyCommand(expectedPatchHash()) })

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

  it('settles trusted remote trash by lifecycle state without retrying duplicate writes', async () => {
    const command = plannedTrustedTrashCommand()
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
        { commandId: testIds.commandId, state: 'settled', settlementEventId: expect.any(String) },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })

  it('settles restore commands by lifecycle state', async () => {
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
        { commandId: testIds.commandId, state: 'settled', settlementEventId: expect.any(String) },
      ])
    } finally {
      storeFixture.cleanup()
    }
  })
})
