import { Effect, Schema } from 'effect'

import type { RemoteWriteCommand } from './commands.ts'
import type { Hash, NotionRequestId } from './domain.ts'
import { LocalStoreError, NotionGatewayError, type BodySyncError } from './errors.ts'
import { IdempotencyKey } from './events.ts'
import { notionRequestId } from './gateway.ts'
import type { GuardName } from './guards.ts'
import {
  commandKind as otelCommandKind,
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
} from './observability.ts'
import { NotionDataSourceGateway, PageBodySyncPort } from './ports.ts'
import { pageLifecycleHash } from './store-projections.ts'
import {
  type ClaimedOutboxCommand,
  type NotionSyncStore,
  type OutboxClaimOptions,
} from './store.ts'

export type OutboxExecutorOptions = OutboxClaimOptions & {
  readonly store: NotionSyncStore
}

export type OutboxExecutionResult =
  | { readonly _tag: 'idle' }
  | {
      readonly _tag: 'settled'
      readonly commandId: ClaimedOutboxCommand['commandId']
      readonly settlementKind: 'verified-success' | 'verified-no-op'
    }
  | {
      readonly _tag: 'failed'
      readonly commandId: ClaimedOutboxCommand['commandId']
      readonly guard: GuardName
      readonly attemptState: 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
    }

type CurrentSurface = {
  readonly baseHash: Hash
  readonly verificationHash: Hash
  readonly requestId: NotionRequestId
}

type ExecutorError = LocalStoreError | NotionGatewayError | BodySyncError

const idempotencyKey = Schema.decodeUnknownSync(IdempotencyKey)

const storeEffect = <TValue>(
  operation: string,
  f: () => TValue,
): Effect.Effect<TValue, LocalStoreError> =>
  Effect.try({
    try: f,
    catch: (cause) =>
      cause instanceof LocalStoreError
        ? cause
        : new LocalStoreError({
            operation,
            message: `Local store operation failed: ${operation}`,
            cause,
          }),
  })

const commandTag = (command: RemoteWriteCommand): string => command._tag.replace(/Command$/, '')

const commandPageId = (command: RemoteWriteCommand): string | undefined =>
  'pageId' in command ? command.pageId : undefined

const commandDataSourceId = (command: RemoteWriteCommand): string | undefined =>
  'dataSourceId' in command ? command.dataSourceId : undefined

const commandSpanAttributes = (input: {
  readonly operation: string
  readonly command: RemoteWriteCommand
}) =>
  spanAttributes({
    [spanAttr.spanLabel]: spanLabel(
      input.operation,
      otelCommandKind(input.command._tag),
      shortSpanId(input.command.commandId),
    ),
    [spanAttr.processRole]: 'library',
    [spanAttr.operation]: input.operation,
    [spanAttr.commandId]: input.command.commandId,
    [spanAttr.commandKind]: otelCommandKind(input.command._tag),
    [spanAttr.dataSourceId]: commandDataSourceId(input.command),
    [spanAttr.pageId]: commandPageId(input.command),
  })

const commandBaseHash = (command: RemoteWriteCommand): Hash => {
  switch (command._tag) {
    case 'PatchPagePropertiesCommand':
    case 'TrashPageCommand':
    case 'RestorePageCommand':
      return command.basePropertiesHash
    case 'PatchDataSourceSchemaCommand':
      return command.baseSchemaHash
    case 'BodyPushCommand':
      return command.baseBodyPointer.bodyHash
  }
}

const observeCurrentSurface = (
  command: RemoteWriteCommand,
): Effect.Effect<
  CurrentSurface,
  NotionGatewayError | BodySyncError,
  NotionDataSourceGateway | PageBodySyncPort
> =>
  Effect.gen(function* () {
    switch (command._tag) {
      case 'PatchPagePropertiesCommand':
      case 'TrashPageCommand':
      case 'RestorePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const page = yield* gateway.retrievePage(command.pageId)
        if (command._tag === 'PatchPagePropertiesCommand') {
          return {
            baseHash: page.propertiesHash,
            verificationHash: page.propertiesHash,
            requestId: page.requestId,
          }
        }
        return {
          baseHash: page.propertiesHash,
          verificationHash: pageLifecycleHash(command.pageId, page.inTrash),
          requestId: page.requestId,
        }
      }
      case 'PatchDataSourceSchemaCommand': {
        const gateway = yield* NotionDataSourceGateway
        const dataSource = yield* gateway.retrieveDataSource(command.dataSourceId)
        return {
          baseHash: dataSource.schemaHash,
          verificationHash: dataSource.schemaHash,
          requestId: dataSource.requestId,
        }
      }
      case 'BodyPushCommand': {
        const body = yield* PageBodySyncPort
        const pointer = yield* body.observe({ _tag: 'ObserveBodyInput', pageId: command.pageId })
        return {
          baseHash: pointer.bodyHash,
          verificationHash: pointer.bodyHash,
          requestId: notionRequestId(`body-observe:${command.commandId}`),
        }
      }
    }
  }).pipe(
    Effect.withSpan(spanNames.outboxObserveSurface, {
      attributes: commandSpanAttributes({
        operation: 'observeCurrentSurface',
        command,
      }),
    }),
  )

const executeRemoteWrite = (
  command: RemoteWriteCommand,
): Effect.Effect<
  NotionRequestId,
  NotionGatewayError | BodySyncError,
  NotionDataSourceGateway | PageBodySyncPort
> =>
  Effect.gen(function* () {
    switch (command._tag) {
      case 'PatchPagePropertiesCommand': {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.patchPageProperties(command)
      }
      case 'PatchDataSourceSchemaCommand': {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.patchDataSourceSchema(command)
      }
      case 'TrashPageCommand': {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.trashPage(command)
      }
      case 'RestorePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        return yield* gateway.restorePage(command)
      }
      case 'BodyPushCommand': {
        const body = yield* PageBodySyncPort
        const result = yield* body.push(command)
        return result.requestId
      }
    }
  }).pipe(
    Effect.withSpan(spanNames.outboxWriteRemote, {
      attributes: commandSpanAttributes({
        operation: 'executeRemoteWrite',
        command,
      }),
    }),
  )

const guardFromWriteError = (error: NotionGatewayError | BodySyncError): GuardName =>
  error instanceof NotionGatewayError && error.guard !== undefined
    ? error.guard
    : 'CurrentSurfaceMissing'

const recordAttemptState = ({
  options,
  claimed,
  attemptState,
  guard,
}: {
  readonly options: OutboxExecutorOptions
  readonly claimed: ClaimedOutboxCommand
  readonly attemptState: 'retryable' | 'blocked' | 'fenced' | 'ambiguous'
  readonly guard: GuardName
}) =>
  storeEffect('append-outbox-attempt-state', () =>
    options.store.appendOutboxAttemptState({
      rootId: claimed.rootId,
      commandId: claimed.commandId,
      commandKey: claimed.commandKey,
      surface: claimed.surface,
      attempt: claimed.attempt,
      attemptState,
      leaseToken: claimed.leaseToken,
      guard,
      idempotencyKey: idempotencyKey(
        `${claimed.commandKey}:attempt-state:${claimed.attempt}:${attemptState}:${guard}`,
      ),
    }),
  ).pipe(
    Effect.as({
      _tag: 'failed' as const,
      commandId: claimed.commandId,
      guard,
      attemptState,
    }),
  )

const settle = ({
  options,
  claimed,
  command,
  requestId,
  observedHash,
  settlementKind,
}: {
  readonly options: OutboxExecutorOptions
  readonly claimed: ClaimedOutboxCommand
  readonly command: RemoteWriteCommand
  readonly requestId: NotionRequestId
  readonly observedHash: Hash
  readonly settlementKind: 'verified-success' | 'verified-no-op'
}) =>
  storeEffect('append-outbox-settlement', () =>
    options.store.appendOutboxSettlement({
      rootId: claimed.rootId,
      commandId: claimed.commandId,
      commandKey: claimed.commandKey,
      surface: claimed.surface,
      commandTag: commandTag(command),
      requestId,
      desiredHash: claimed.desiredHash,
      observedHash,
      settlementKind,
      idempotencyKey: idempotencyKey(`${claimed.commandKey}:settled`),
    }),
  ).pipe(
    Effect.as({
      _tag: 'settled' as const,
      commandId: claimed.commandId,
      settlementKind,
    }),
  )

const annotateOutboxResult = (result: OutboxExecutionResult) =>
  Effect.annotateCurrentSpan(
    spanAttributes({
      [spanAttr.result]: result._tag,
      [spanAttr.guard]: result._tag === 'failed' ? result.guard : undefined,
      [spanAttr.settlementKind]: result._tag === 'settled' ? result.settlementKind : undefined,
    }),
  )

export const executeOutboxOnce = Effect.fn(spanNames.outboxAttempt)(
  (
    options: OutboxExecutorOptions,
  ): Effect.Effect<
    OutboxExecutionResult,
    ExecutorError,
    NotionDataSourceGateway | PageBodySyncPort
  > =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          [spanAttr.spanLabel]: spanLabel('outbox', shortSpanId(options.rootId)),
          [spanAttr.processRole]: 'library',
          [spanAttr.operation]: 'executeOutboxOnce',
          [spanAttr.rootId]: options.rootId,
          [spanAttr.leaseDurationMs]: options.leaseDurationMs,
        }),
      )
      const claimed = yield* storeEffect('claim-next-outbox-command', () =>
        options.store.claimNextOutboxCommand(options),
      )

      if (claimed === undefined) {
        const result = { _tag: 'idle' as const }
        yield* Effect.annotateCurrentSpan({
          [spanAttr.spanLabel]: spanLabel('outbox', 'idle'),
        })
        yield* annotateOutboxResult(result)
        return result
      }

      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          [spanAttr.spanLabel]: spanLabel('outbox', shortSpanId(claimed.commandId)),
          [spanAttr.commandId]: claimed.commandId,
          [spanAttr.attempt]: claimed.attempt,
        }),
      )

      if (claimed.command === undefined) {
        const result = yield* recordAttemptState({
          options,
          claimed,
          attemptState: 'blocked',
          guard: 'CurrentSurfaceMissing',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      const command = claimed.command
      yield* Effect.annotateCurrentSpan(
        spanAttributes({
          [spanAttr.spanLabel]: spanLabel(
            otelCommandKind(command._tag),
            shortSpanId(command.commandId),
          ),
          [spanAttr.commandKind]: otelCommandKind(command._tag),
          [spanAttr.dataSourceId]: commandDataSourceId(command),
          [spanAttr.pageId]: commandPageId(command),
        }),
      )
      const before = yield* observeCurrentSurface(command).pipe(
        Effect.catchAll((error) =>
          recordAttemptState({
            options,
            claimed,
            attemptState:
              error instanceof NotionGatewayError && error.guard === 'StaleSurfaceBase'
                ? 'blocked'
                : 'retryable',
            guard: guardFromWriteError(error),
          }),
        ),
      )

      if ('_tag' in before) {
        yield* annotateOutboxResult(before)
        return before
      }

      if (before.verificationHash === claimed.desiredHash) {
        const result = yield* settle({
          options,
          claimed,
          command,
          requestId: before.requestId,
          observedHash: before.verificationHash,
          settlementKind: 'verified-no-op',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      if (claimed.attemptState === 'ambiguous') {
        const result = yield* recordAttemptState({
          options,
          claimed,
          attemptState: 'ambiguous',
          guard: 'AmbiguousCommandOutcome',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      if (before.baseHash !== commandBaseHash(command)) {
        const result = yield* recordAttemptState({
          options,
          claimed,
          attemptState: 'blocked',
          guard: 'StaleSurfaceBase',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      const leaseActive = yield* storeEffect('check-outbox-lease', () =>
        options.store.isOutboxLeaseActive({
          rootId: claimed.rootId,
          commandId: claimed.commandId,
          leaseToken: claimed.leaseToken,
        }),
      )

      if (leaseActive === false) {
        const result = yield* recordAttemptState({
          options,
          claimed,
          attemptState: 'fenced',
          guard: 'LeaseFenceMismatch',
        })
        yield* annotateOutboxResult(result)
        return result
      }

      const requestId = yield* executeRemoteWrite(command).pipe(
        Effect.catchAll((error) =>
          recordAttemptState({
            options,
            claimed,
            attemptState:
              error instanceof NotionGatewayError && error.guard === 'StaleSurfaceBase'
                ? 'blocked'
                : 'retryable',
            guard: guardFromWriteError(error),
          }),
        ),
      )

      if (typeof requestId !== 'string') {
        yield* annotateOutboxResult(requestId)
        return requestId
      }

      const after = yield* observeCurrentSurface(command).pipe(
        Effect.catchAll((error) =>
          recordAttemptState({
            options,
            claimed,
            attemptState: 'retryable',
            guard: guardFromWriteError(error),
          }),
        ),
      )

      if ('_tag' in after) {
        yield* annotateOutboxResult(after)
        return after
      }

      const result =
        after.verificationHash === claimed.desiredHash
          ? yield* settle({
              options,
              claimed,
              command,
              requestId,
              observedHash: after.verificationHash,
              settlementKind: 'verified-success',
            })
          : yield* recordAttemptState({
              options,
              claimed,
              attemptState: 'retryable',
              guard: 'ReadAfterWriteMismatch',
            })
      yield* annotateOutboxResult(result)
      return result
    }),
)
