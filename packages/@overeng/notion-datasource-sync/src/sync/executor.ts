import { Chunk, Effect, Schema, Stream } from 'effect'

import type { PatchPagePropertiesCommand, RemoteWriteCommand } from '../core/commands.ts'
import { PropertyId, type Hash, type NotionRequestId, type PageId } from '../core/domain.ts'
import { LocalStoreError, NotionGatewayError, type BodySyncError } from '../core/errors.ts'
import { IdempotencyKey } from '../core/events.ts'
import type { GuardName } from '../core/guards.ts'
import { NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { notionRequestId } from '../gateway/gateway.ts'
import {
  commandKind as otelCommandKind,
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
} from '../observability/observability.ts'
import { hashStoreBytes, pageLifecycleHash } from '../store/projections.ts'
import {
  type ClaimedOutboxCommand,
  type NotionSyncStore,
  type OutboxClaimOptions,
} from '../store/store.ts'

/** Options for `executeOutboxOnce`: combines the store reference with outbox claim parameters (lease token, duration, root id). */
export type OutboxExecutorOptions = OutboxClaimOptions & {
  readonly store: NotionSyncStore
}

/**
 * Outcome of a single outbox executor step.
 *
 * - `idle` — no commands were ready to execute.
 * - `settled` — command executed and surface hash verified (success or idempotent no-op).
 * - `failed` — command was blocked, fenced, ambiguous, or encountered a retryable error; `guard` names the blocking condition.
 */
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

type RemoteWriteResult = {
  readonly requestId: NotionRequestId
  readonly createdPageId?: PageId
  readonly createdPropertiesHash?: Hash
}

const relationPatchVerificationHash = (
  command: PatchPagePropertiesCommand,
): Effect.Effect<Hash | undefined, NotionGatewayError, NotionDataSourceGateway> => {
  const entries = Object.entries(command.propertyPatch)
  const [propertyId, value] = entries[0] ?? []
  if (entries.length !== 1 || propertyId === undefined || value?._tag !== 'relation') {
    return Effect.succeed(undefined)
  }

  return Effect.gen(function* () {
    const gateway = yield* NotionDataSourceGateway
    const pages = yield* gateway
      .retrievePageProperty({
        _tag: 'RetrievePagePropertyInput',
        pageId: command.pageId,
        propertyId: Schema.decodeUnknownSync(PropertyId)(propertyId),
        startCursor: null,
      })
      .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
    const terminal = pages.at(-1)
    if (terminal === undefined || terminal.hasMore === true) return undefined
    const pageIds = pages
      .flatMap((page) => page.items)
      .map((item) => {
        if (item.valueJson === undefined) return undefined
        const decoded = JSON.parse(item.valueJson) as { readonly id?: unknown }
        return typeof decoded.id === 'string' ? decoded.id : undefined
      })
      .filter((pageId): pageId is string => pageId !== undefined)
      .toSorted()
    return hashStoreBytes(JSON.stringify({ _tag: 'relation', pageIds }))
  })
}

type ExecutorError = LocalStoreError | NotionGatewayError | BodySyncError

const idempotencyKey = Schema.decodeUnknownSync(IdempotencyKey)

const storeEffect = <TValue>({
  operation,
  f,
}: {
  readonly operation: string
  readonly f: () => TValue
}): Effect.Effect<TValue, LocalStoreError> =>
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
    case 'PatchDataSourceMetadataCommand':
    case 'PatchDatabaseMetadataCommand':
      return command.baseMetadataHash
    case 'BodyPushCommand':
      return command.baseBodyPointer.bodyHash
    case 'CreatePageCommand':
      return command.baseSchemaHash
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
          verificationHash: pageLifecycleHash({ pageId: command.pageId, inTrash: page.inTrash }),
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
      case 'CreatePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const dataSource = yield* gateway.retrieveDataSource(command.dataSourceId)
        return {
          baseHash: dataSource.schemaHash,
          verificationHash: dataSource.schemaHash,
          requestId: dataSource.requestId,
        }
      }
      case 'PatchDataSourceMetadataCommand': {
        const gateway = yield* NotionDataSourceGateway
        const dataSource = yield* gateway.retrieveDataSource(command.dataSourceId)
        if (dataSource.metadataHash === undefined) {
          return yield* Effect.fail(
            new NotionGatewayError({
              operation: 'retrieveDataSource',
              dataSourceId: command.dataSourceId,
              guard: 'CurrentSurfaceMissing',
              message: 'Current data-source metadata projection is missing',
            }),
          )
        }
        return {
          baseHash: dataSource.metadataHash,
          verificationHash: dataSource.metadataHash,
          requestId: dataSource.requestId,
        }
      }
      case 'PatchDatabaseMetadataCommand': {
        const gateway = yield* NotionDataSourceGateway
        const dataSource = yield* gateway.retrieveDataSource(command.dataSourceId)
        if (dataSource.metadataHash === undefined) {
          return yield* Effect.fail(
            new NotionGatewayError({
              operation: 'retrieveDataSource',
              dataSourceId: command.dataSourceId,
              guard: 'CurrentSurfaceMissing',
              message: 'Current database metadata projection is missing',
            }),
          )
        }
        return {
          baseHash: dataSource.metadataHash,
          verificationHash: dataSource.metadataHash,
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
  RemoteWriteResult,
  NotionGatewayError | BodySyncError,
  NotionDataSourceGateway | PageBodySyncPort
> =>
  Effect.gen(function* () {
    switch (command._tag) {
      case 'PatchPagePropertiesCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchPageProperties(command)
        return { requestId }
      }
      case 'CreatePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const result = yield* gateway.createPage(command)
        return {
          requestId: result.requestId,
          createdPageId: result.pageId,
          createdPropertiesHash: result.propertiesHash,
        }
      }
      case 'PatchDataSourceSchemaCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchDataSourceSchema(command)
        return { requestId }
      }
      case 'PatchDataSourceMetadataCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchDataSourceMetadata(command)
        return { requestId }
      }
      case 'PatchDatabaseMetadataCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.patchDatabaseMetadata(command)
        return { requestId }
      }
      case 'TrashPageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.trashPage(command)
        return { requestId }
      }
      case 'RestorePageCommand': {
        const gateway = yield* NotionDataSourceGateway
        const requestId = yield* gateway.restorePage(command)
        return { requestId }
      }
      case 'BodyPushCommand': {
        const body = yield* PageBodySyncPort
        const result = yield* body.push(command)
        return { requestId: result.requestId }
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
  storeEffect({
    operation: 'append-outbox-attempt-state',
    f: () =>
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
  }).pipe(
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
  createdPageId,
  settlementKind,
}: {
  readonly options: OutboxExecutorOptions
  readonly claimed: ClaimedOutboxCommand
  readonly command: RemoteWriteCommand
  readonly requestId: NotionRequestId
  readonly observedHash: Hash
  readonly createdPageId?: PageId
  readonly settlementKind: 'verified-success' | 'verified-no-op'
}) =>
  storeEffect({
    operation: 'append-outbox-settlement',
    f: () =>
      options.store.appendOutboxSettlement({
        rootId: claimed.rootId,
        commandId: claimed.commandId,
        commandKey: claimed.commandKey,
        surface: claimed.surface,
        commandTag: commandTag(command),
        requestId,
        desiredHash: claimed.desiredHash,
        observedHash,
        ...(createdPageId === undefined ? {} : { createdPageId }),
        settlementKind,
        idempotencyKey: idempotencyKey(`${claimed.commandKey}:settled`),
      }),
  }).pipe(
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

/** Claim and attempt to execute one pending outbox command: observe the current surface, execute the write if safe, then verify the post-write state. Returns `idle` when the outbox is empty. */
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
      const claimed = yield* storeEffect({
        operation: 'claim-next-outbox-command',
        f: () => options.store.claimNextOutboxCommand(options),
      })

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
        // Reclaiming an expired running command already records the ambiguous
        // attempt in the store. Do not append a second same-attempt event here;
        // for create-page commands, retrying blindly could duplicate a row.
        const result = {
          _tag: 'failed' as const,
          commandId: claimed.commandId,
          attemptState: 'ambiguous' as const,
          guard: 'AmbiguousCommandOutcome' as const,
        } satisfies OutboxExecutionResult
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

      const leaseActive = yield* storeEffect({
        operation: 'check-outbox-lease',
        f: () =>
          options.store.isOutboxLeaseActive({
            rootId: claimed.rootId,
            commandId: claimed.commandId,
            leaseToken: claimed.leaseToken,
          }),
      })

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

      const writeResult = yield* executeRemoteWrite(command).pipe(
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

      if ('_tag' in writeResult) {
        yield* annotateOutboxResult(writeResult)
        return writeResult
      }

      const after =
        command._tag === 'CreatePageCommand' &&
        writeResult.createdPageId !== undefined &&
        writeResult.createdPropertiesHash !== undefined
          ? {
              baseHash: command.baseSchemaHash,
              verificationHash: writeResult.createdPropertiesHash,
              requestId: writeResult.requestId,
            }
          : yield* observeCurrentSurface(command).pipe(
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

      // Page-property commands claim a property-surface hash, while the API only lets us
      // re-observe the full page property hash after patching.
      const propertyPatchChangedPage =
        command._tag === 'PatchPagePropertiesCommand' && after.baseHash !== before.baseHash
      const relationPatchHash =
        command._tag === 'PatchPagePropertiesCommand'
          ? yield* relationPatchVerificationHash(command).pipe(
              Effect.catchAll((error) =>
                recordAttemptState({
                  options,
                  claimed,
                  attemptState: 'retryable',
                  guard: guardFromWriteError(error),
                }),
              ),
            )
          : undefined
      if (typeof relationPatchHash === 'object' && '_tag' in relationPatchHash) {
        yield* annotateOutboxResult(relationPatchHash)
        return relationPatchHash
      }
      const createReturnedPage =
        command._tag === 'CreatePageCommand' && writeResult.createdPageId !== undefined
      const verified =
        after.verificationHash === claimed.desiredHash ||
        relationPatchHash === claimed.desiredHash ||
        propertyPatchChangedPage ||
        createReturnedPage
      const result =
        verified === true
          ? yield* settle({
              options,
              claimed,
              command,
              requestId: writeResult.requestId,
              observedHash:
                propertyPatchChangedPage === true || createReturnedPage === true
                  ? claimed.desiredHash
                  : after.verificationHash,
              ...(writeResult.createdPageId === undefined
                ? {}
                : { createdPageId: writeResult.createdPageId }),
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
