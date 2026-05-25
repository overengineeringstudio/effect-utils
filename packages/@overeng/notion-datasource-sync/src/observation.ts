import { Chunk, Effect, Schema, Stream } from 'effect'

import { pageSurfaceKey, propertySurfaceKey, querySurfaceKey } from './canonical.ts'
import {
  BodyPushCommand,
  type PagePropertyItemPage,
  type QueryContract,
  type QueryRowsPage,
} from './commands.ts'
import {
  BodyPointer,
  CommandId,
  WorkspaceRelativePath,
  type AbsolutePath,
  type BodyPointer as BodyPointerType,
  type CapabilityName,
  type DataSourceId as DataSourceIdType,
  type Hash,
  type Hash as HashType,
  type LocalArtifactObservation,
  type MaterializeResult,
  type PageId,
  type PageId as PageIdType,
  type PropertyId,
  type PropertyId as PropertyIdType,
} from './domain.ts'
import { NotionGatewayError, type BodySyncError, type LocalStorageError } from './errors.ts'
import {
  IdempotencyKey,
  SyncEvent,
  SyncEventId,
  type SurfaceKey,
  type SyncEvent as SyncEventType,
  type SyncRootId,
} from './events.ts'
import { allGatewayCapabilities } from './gateway.ts'
import type { GuardName, PropertyAvailability, PropertyWriteClass } from './guards.ts'
import { bodyPathForRow } from './local-workspace.ts'
import type { OutboxCommandEnvelope, PlannerEvent } from './planner.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from './ports.ts'
import { hashStoreBytes } from './store-projections.ts'

export type SchemaPropertyObservation = {
  readonly propertyId: PropertyIdType
  readonly configHash: HashType
  readonly writeClass: PropertyWriteClass
}

export type RemoteObservationOptions = {
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceIdType
  readonly workspaceRoot: AbsolutePath
  readonly queryContract: QueryContract
  readonly schemaProperties: ReadonlyArray<SchemaPropertyObservation>
  readonly requiredCapabilities?: ReadonlyArray<CapabilityName>
  readonly materializeBodies?: boolean
  readonly bodyPathForPage?: (pageId: PageIdType) => WorkspaceRelativePath
  readonly now?: () => Date
}

export type RemoteObservationResult = {
  readonly events: ReadonlyArray<SyncEventType>
  readonly materialized: ReadonlyArray<MaterializeResult>
  readonly query: {
    readonly pages: number
    readonly rows: number
    readonly complete: boolean
    readonly cappedAtLimit: boolean
    readonly queryContractHash: HashType | undefined
  }
  readonly properties: {
    readonly observed: number
    readonly incomplete: number
  }
}

const decode = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: unknown,
): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const eventPayload = (value: unknown): SyncEventType['payload'] => ({
  _tag: 'VersionedJson',
  codecVersion: 'v1',
  canonicalJson: JSON.stringify(value),
})

const observedAt = (now: () => Date) => now().toISOString()

const eventBase = ({
  rootId,
  eventId,
  family,
  eventType,
  idempotencyKey,
  surface,
  payload,
  now,
}: {
  readonly rootId: SyncRootId
  readonly eventId: string
  readonly family: SyncEventType['family']
  readonly eventType: SyncEventType['eventType']
  readonly idempotencyKey: string
  readonly surface?: SurfaceKey
  readonly payload: unknown
  readonly now: () => Date
}) => ({
  eventId,
  rootId,
  sequence: '0',
  codecVersion: 'v1',
  family,
  eventType,
  idempotencyKey,
  surface: surface ?? null,
  causedByEventIds: [],
  payloadHash: hashStoreBytes('placeholder'),
  payload: eventPayload(payload),
  observedAt: observedAt(now),
})

const eventIdPart = (value: string): string => value.replaceAll(':', '-').replaceAll('/', '-')

const commandTag = (command: { readonly _tag: string }): string =>
  command._tag.replace(/Command$/, '')

const defaultBodyPathForPage = (pageId: PageIdType): WorkspaceRelativePath => {
  const decision = bodyPathForRow({ title: `page-${pageId}`, pageId })
  if (decision._tag === 'blocked') {
    return decode(WorkspaceRelativePath, `page-${pageId}.nmd`)
  }

  return decision.path
}

const collectStream = <TValue, TError>(
  stream: Stream.Stream<TValue, TError>,
): Effect.Effect<ReadonlyArray<TValue>, TError> =>
  stream.pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))

const propertyValueHash = (pages: ReadonlyArray<PagePropertyItemPage>): HashType | undefined => {
  const terminalPage = pages.at(-1)
  if (terminalPage === undefined || terminalPage.hasMore === true) return undefined
  const valueHashes = pages.flatMap((page) => page.items.map((item) => item.valueHash))
  if (valueHashes.length === 1) return valueHashes[0]
  return hashStoreBytes(`property-items\t${valueHashes.join('\n')}`)
}

const propertyAvailability = (pages: ReadonlyArray<PagePropertyItemPage>): PropertyAvailability =>
  pages.at(-1)?.hasMore === false ? 'complete' : 'paginated-incomplete'

const uniqueCapabilities = (
  capabilities: ReadonlyArray<CapabilityName>,
): ReadonlyArray<CapabilityName> => [...new Set(capabilities)]

const requiredObservationCapabilities = (
  options: RemoteObservationOptions,
): ReadonlyArray<CapabilityName> =>
  uniqueCapabilities([
    ...(options.requiredCapabilities ?? allGatewayCapabilities),
    'data_source_retrieve',
    'data_source_query',
    'page_retrieve',
    ...(options.schemaProperties.length === 0 ? [] : (['page_property_paginate'] as const)),
  ])

const pagePropertyFailureAvailability = (error: NotionGatewayError): PropertyAvailability =>
  error.guard === 'UnsupportedRemoteShape' ? 'unsupported' : 'paginated-incomplete'

export const makeSyncBindingRecordedEvent = (input: {
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceIdType
  readonly workspaceRoot: AbsolutePath
  readonly storeIdentity: string
  readonly now?: () => Date
}): Extract<SyncEventType, { readonly _tag: 'SyncBindingRecorded' }> => {
  const now = input.now ?? (() => new Date())
  return decode(SyncEvent, {
    _tag: 'SyncBindingRecorded',
    ...eventBase({
      rootId: input.rootId,
      eventId: `binding:${eventIdPart(input.dataSourceId)}:${hashStoreBytes(input.workspaceRoot)}`,
      family: 'SyncRootBound',
      eventType: 'SyncBindingRecorded',
      idempotencyKey: `binding:${input.dataSourceId}:${hashStoreBytes(input.workspaceRoot)}`,
      surface: querySurfaceKey(input.dataSourceId, hashStoreBytes(input.workspaceRoot)),
      payload: {
        dataSourceId: input.dataSourceId,
        workspaceRootHash: hashStoreBytes(input.workspaceRoot),
        storeIdentity: input.storeIdentity,
      },
      now,
    }),
    dataSourceId: input.dataSourceId,
    workspaceRoot: input.workspaceRoot,
    storeIdentity: input.storeIdentity,
  })
}

export const makeRemoteWritePlannedEvent = (
  command: OutboxCommandEnvelope,
  now: () => Date = () => new Date(),
): Extract<SyncEventType, { readonly _tag: 'RemoteWritePlanned' }> =>
  decode(SyncEvent, {
    _tag: 'RemoteWritePlanned',
    ...eventBase({
      rootId: command.rootId,
      eventId: `planned:${eventIdPart(command.commandId)}`,
      family: 'CommandEnqueued',
      eventType: 'RemoteWritePlanned',
      idempotencyKey: command.commandKey,
      surface: command.surface,
      payload: { command: command.command },
      now,
    }),
    commandId: command.commandId,
    commandKey: command.commandKey,
    intentEventId: command.intentEventId,
    commandTag: commandTag(command.command),
    baseHash: command.baseHash,
    desiredHash: command.desiredHash,
    preflight: command.preflight,
  })

export const makePlannerEvent = ({
  rootId,
  event,
  now = () => new Date(),
}: {
  readonly rootId: SyncRootId
  readonly event: PlannerEvent
  readonly now?: () => Date
}): SyncEventType | undefined => {
  switch (event._tag) {
    case 'PathClaimAccepted':
      return decode(SyncEvent, {
        _tag: 'PathClaimed',
        ...eventBase({
          rootId,
          eventId: `path:${eventIdPart(event.path)}:${eventIdPart(event.pageId)}`,
          family: 'LocalIntentAccepted',
          eventType: 'PathClaimed',
          idempotencyKey: `path:${event.path}:${event.pageId}`,
          surface: event.surface,
          payload: { path: event.path, pageId: event.pageId },
          now,
        }),
        pageId: event.pageId,
        relativePath: event.path,
        claimState: 'active',
      })
    case 'TombstoneCandidateObserved':
      return decode(SyncEvent, {
        _tag: 'TombstoneCandidateObserved',
        ...eventBase({
          rootId,
          eventId: `tombstone-candidate:${eventIdPart(event.pageId)}`,
          family: 'RemoteObserved',
          eventType: 'TombstoneCandidateObserved',
          idempotencyKey: `tombstone-candidate:${event.pageId}`,
          surface: event.surface,
          payload: {},
          now,
        }),
        pageId: event.pageId,
        reason:
          event.reason === 'filtered-absence-not-proof'
            ? 'filtered_absence_not_proof'
            : 'query_absence_unclassified',
      })
    case 'TombstoneClassified':
      return decode(SyncEvent, {
        _tag: 'TombstoneRecorded',
        ...eventBase({
          rootId,
          eventId: `tombstone:${eventIdPart(event.pageId)}:${event.reason}`,
          family: 'TombstoneClassified',
          eventType: 'TombstoneRecorded',
          idempotencyKey: `tombstone:${event.pageId}:${event.reason}`,
          surface: event.surface,
          payload: {},
          now,
        }),
        pageId: event.pageId,
        reason:
          event.reason === 'remote-trash'
            ? 'remote_trash'
            : event.reason === 'moved-out'
              ? 'moved_out'
              : event.reason,
      })
    case 'LocalDeleteCandidateAccepted':
    case 'RemoteObservationAccepted':
      return undefined
  }
}

export const makeGuardBlockedEvent = (input: {
  readonly rootId: SyncRootId
  readonly guard: GuardName
  readonly surface: SurfaceKey
  readonly message: string
  readonly evidence?: unknown
  readonly now?: () => Date
}): Extract<SyncEventType, { readonly _tag: 'GuardBlocked' }> => {
  const now = input.now ?? (() => new Date())
  return decode(SyncEvent, {
    _tag: 'GuardBlocked',
    ...eventBase({
      rootId: input.rootId,
      eventId: `guard-block:${eventIdPart(input.surface)}:${input.guard}`,
      family: 'GuardBlocked',
      eventType: 'GuardBlocked',
      idempotencyKey: `guard-block:${input.surface}:${input.guard}`,
      surface: input.surface,
      payload: { evidence: input.evidence ?? {} },
      now,
    }),
    guard: input.guard,
    message: input.message,
  })
}

export const makeQueryAbsenceCandidateEvent = (input: {
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceIdType
  readonly pageId: PageIdType
  readonly queryContractHash: HashType
  readonly queryContract: QueryContract
  readonly now?: () => Date
}): Extract<SyncEventType, { readonly _tag: 'TombstoneCandidateObserved' }> => {
  const now = input.now ?? (() => new Date())
  const filtered =
    input.queryContract.filter !== null ||
    input.queryContract.membershipScope !== 'all-data-source-rows'

  return decode(SyncEvent, {
    _tag: 'TombstoneCandidateObserved',
    ...eventBase({
      rootId: input.rootId,
      eventId: `absence:${eventIdPart(input.dataSourceId)}:${eventIdPart(input.pageId)}:${input.queryContractHash}`,
      family: 'RemoteObserved',
      eventType: 'TombstoneCandidateObserved',
      idempotencyKey: `absence:${input.dataSourceId}:${input.pageId}:${input.queryContractHash}`,
      surface: querySurfaceKey(input.dataSourceId, input.queryContractHash),
      payload: {
        dataSourceId: input.dataSourceId,
        pageId: input.pageId,
        queryContractHash: input.queryContractHash,
        classified: false,
        membershipScope: input.queryContract.membershipScope,
        filtered,
        directRetrieve: 'not-run',
      },
      now,
    }),
    pageId: input.pageId,
    reason: filtered ? 'filtered_absence_not_proof' : 'query_absence_unclassified',
  })
}

export const makeConflictRaisedEvent = (input: {
  readonly rootId: SyncRootId
  readonly pageId: PageIdType
  readonly propertyId?: PropertyIdType
  readonly surface: SurfaceKey
  readonly baseHash: HashType
  readonly localHash: HashType
  readonly remoteHash: HashType
  readonly conflictKind?: Extract<
    SyncEventType,
    { readonly _tag: 'ConflictRaised' }
  >['conflictKind']
  readonly message: string
  readonly now?: () => Date
}): Extract<SyncEventType, { readonly _tag: 'ConflictRaised' }> => {
  const now = input.now ?? (() => new Date())
  return decode(SyncEvent, {
    _tag: 'ConflictRaised',
    ...eventBase({
      rootId: input.rootId,
      eventId: `conflict:${eventIdPart(input.surface)}:${input.localHash}:${input.remoteHash}`,
      family: 'ConflictDetected',
      eventType: 'ConflictRaised',
      idempotencyKey: `conflict:${input.surface}:${input.localHash}:${input.remoteHash}`,
      surface: input.surface,
      payload: { message: input.message },
      now,
    }),
    conflictKind: input.conflictKind,
    pageId: input.pageId,
    propertyId: input.propertyId,
    baseHash: input.baseHash,
    localHash: input.localHash,
    remoteHash: input.remoteHash,
  })
}

export const commandIdFor = (value: string): typeof CommandId.Type =>
  decode(CommandId, `cmd:${eventIdPart(value)}`)

export const intentEventIdFor = (value: string): typeof SyncEventId.Type =>
  decode(SyncEventId, `intent:${eventIdPart(value)}`)

export const commandKeyFor = (value: string): typeof IdempotencyKey.Type =>
  decode(IdempotencyKey, `intent:${eventIdPart(value)}`)

export const observeRemoteDataSource = Effect.fn(
  'NotionDatasourceSync.Observation.observeRemoteDataSource',
)(
  (
    options: RemoteObservationOptions,
  ): Effect.Effect<
    RemoteObservationResult,
    NotionGatewayError | BodySyncError | LocalStorageError,
    NotionDataSourceGateway | PageBodySyncPort | LocalWorkspacePort
  > =>
    Effect.gen(function* () {
      const now = options.now ?? (() => new Date())
      const gateway = yield* NotionDataSourceGateway
      const body = yield* PageBodySyncPort
      const workspace = yield* LocalWorkspacePort
      const requiredCapabilities = requiredObservationCapabilities(options)
      const preflight = yield* gateway.preflightCapabilities({
        _tag: 'CapabilityPreflightInput',
        dataSourceId: options.dataSourceId,
        requiredCapabilities: [...requiredCapabilities],
      })
      const events: SyncEventType[] = [
        decode(SyncEvent, {
          _tag: 'ApiContractObserved',
          ...eventBase({
            rootId: options.rootId,
            eventId: `api:${gateway.apiContract.apiVersion}`,
            family: 'CompatibilityChecked',
            eventType: 'ApiContractObserved',
            idempotencyKey: `api:${gateway.apiContract.apiVersion}`,
            payload: gateway.apiContract,
            now,
          }),
          apiContract: gateway.apiContract,
        }),
        ...requiredCapabilities.map((capability) => {
          const capabilityState = preflight.supportedCapabilities.includes(capability)
            ? 'supported'
            : 'unsupported'

          return decode(SyncEvent, {
            _tag: 'CapabilityPreflightChecked',
            ...eventBase({
              rootId: options.rootId,
              eventId: `capability:${eventIdPart(options.dataSourceId)}:${capability}:${capabilityState}`,
              family: 'CompatibilityChecked',
              eventType: 'CapabilityPreflightChecked',
              idempotencyKey: `capability:${options.dataSourceId}:${capability}:${capabilityState}`,
              surface: querySurfaceKey(options.dataSourceId, hashStoreBytes('capabilities')),
              payload: { capability },
              now,
            }),
            dataSourceId: options.dataSourceId,
            capability,
            supported: capabilityState === 'supported',
            requestId: preflight.dataSourceId === options.dataSourceId ? undefined : undefined,
          })
        }),
      ]

      if (preflight.missingCapabilities.length > 0) {
        return {
          events,
          materialized: [],
          query: {
            pages: 0,
            rows: 0,
            complete: false,
            cappedAtLimit: false,
            queryContractHash: undefined,
          },
          properties: {
            observed: 0,
            incomplete: 0,
          },
        }
      }

      const dataSource = yield* gateway.retrieveDataSource(options.dataSourceId)
      const queryPages = yield* collectStream(
        gateway.queryRows({
          _tag: 'QueryRowsInput',
          dataSourceId: options.dataSourceId,
          queryContract: options.queryContract,
          startCursor: null,
        }),
      )
      const queryContractHash =
        queryPages.at(-1)?.queryContractHash ?? queryPages[0]?.queryContractHash
      const complete = queryPages.at(-1)?.hasMore === false
      const cappedAtLimit = queryPages.some((page) => page.cappedAtLimit)
      events.push(
        decode(SyncEvent, {
          _tag: 'DataSourceObserved',
          ...eventBase({
            rootId: options.rootId,
            eventId: `data-source:${eventIdPart(dataSource.dataSourceId)}:${dataSource.schemaHash}`,
            family: 'RemoteObserved',
            eventType: 'DataSourceObserved',
            idempotencyKey: `data-source:${dataSource.dataSourceId}:${dataSource.schemaHash}`,
            surface: querySurfaceKey(dataSource.dataSourceId, hashStoreBytes('schema')),
            payload: { schemaProperties: options.schemaProperties },
            now,
          }),
          dataSourceId: dataSource.dataSourceId,
          requestId: dataSource.requestId,
          schemaHash: dataSource.schemaHash,
        }),
      )
      const materialized: MaterializeResult[] = []
      let observedProperties = 0
      let incompleteProperties = 0

      for (const queryPage of queryPages) {
        for (const row of queryPage.rows) {
          const page = yield* gateway.retrievePage(row.pageId)
          const bodyPointer = yield* body.observe({ _tag: 'ObserveBodyInput', pageId: row.pageId })
          const path = (options.bodyPathForPage ?? defaultBodyPathForPage)(row.pageId)
          const materializeResult =
            options.materializeBodies === false
              ? undefined
              : yield* workspace.materialize({
                  _tag: 'MaterializePlan',
                  pageId: row.pageId,
                  path,
                  bodyPointer,
                })

          if (materializeResult !== undefined) {
            materialized.push(materializeResult)
          }

          events.push(
            decode(SyncEvent, {
              _tag: 'RowObserved',
              ...eventBase({
                rootId: options.rootId,
                eventId: `row:${eventIdPart(row.pageId)}:${page.propertiesHash}:${bodyPointer.bodyHash}`,
                family: 'RemoteObserved',
                eventType: 'RowObserved',
                idempotencyKey: `row:${row.pageId}:${page.propertiesHash}:${bodyPointer.bodyHash}`,
                surface: pageSurfaceKey(row.pageId),
                payload: {
                  bodyPath: path,
                  sidecarIdentityProven: materializeResult !== undefined,
                  ownWriteMaterializationIds:
                    materializeResult === undefined
                      ? []
                      : [materializeResult.ownWriteSuppressionToken],
                  safety: bodyPointer.safety,
                },
                now,
              }),
              dataSourceId: page.dataSourceId ?? options.dataSourceId,
              pageId: row.pageId,
              propertiesHash: page.propertiesHash,
              bodyPointer: Schema.encodeSync(BodyPointer)(bodyPointer),
              inTrash: page.inTrash,
            }),
          )

          for (const property of options.schemaProperties) {
            const propertyPagesResult = yield* collectStream(
              gateway.retrievePageProperty({
                _tag: 'RetrievePagePropertyInput',
                pageId: row.pageId,
                propertyId: property.propertyId,
                startCursor: null,
              }),
            ).pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: 'failed' as const, error }),
                onSuccess: (pages) => ({ _tag: 'succeeded' as const, pages }),
              }),
            )

            if (propertyPagesResult._tag === 'failed') {
              const availability =
                propertyPagesResult.error instanceof NotionGatewayError
                  ? pagePropertyFailureAvailability(propertyPagesResult.error)
                  : 'paginated-incomplete'
              incompleteProperties += 1
              events.push(
                decode(SyncEvent, {
                  _tag: 'PagePropertyCheckpointRecorded',
                  ...eventBase({
                    rootId: options.rootId,
                    eventId: `property:${eventIdPart(row.pageId)}:${eventIdPart(property.propertyId)}:failed`,
                    family: 'QueryScanRecorded',
                    eventType: 'PagePropertyCheckpointRecorded',
                    idempotencyKey: `property:${row.pageId}:${property.propertyId}:failed`,
                    surface: propertySurfaceKey(row.pageId, property.propertyId),
                    payload: { availability },
                    now,
                  }),
                  pageId: row.pageId,
                  propertyId: property.propertyId,
                  nextCursor: null,
                  complete: false,
                }),
              )
              continue
            }

            const propertyPages = propertyPagesResult.pages
            const valueHash = propertyValueHash(propertyPages)
            const availability = propertyAvailability(propertyPages)
            if (availability === 'complete') {
              observedProperties += 1
            } else {
              incompleteProperties += 1
            }

            events.push(
              decode(SyncEvent, {
                _tag: 'PagePropertyCheckpointRecorded',
                ...eventBase({
                  rootId: options.rootId,
                  eventId: `property:${eventIdPart(row.pageId)}:${eventIdPart(property.propertyId)}:${valueHash ?? 'incomplete'}`,
                  family: 'QueryScanRecorded',
                  eventType: 'PagePropertyCheckpointRecorded',
                  idempotencyKey: `property:${row.pageId}:${property.propertyId}:${valueHash ?? 'incomplete'}`,
                  surface: propertySurfaceKey(row.pageId, property.propertyId),
                  payload: { availability, baseHash: valueHash },
                  now,
                }),
                pageId: row.pageId,
                propertyId: property.propertyId,
                nextCursor: propertyPages.at(-1)?.nextCursor ?? null,
                complete: valueHash !== undefined,
                ...(valueHash === undefined ? {} : { valueHash }),
              }),
            )
          }
        }
      }

      if (queryContractHash !== undefined) {
        const queryCheckpointState = complete && cappedAtLimit === false ? 'complete' : 'incomplete'
        events.push(
          decode(SyncEvent, {
            _tag: 'QueryScanCheckpointRecorded',
            ...eventBase({
              rootId: options.rootId,
              eventId: `query:${eventIdPart(options.dataSourceId)}:${queryContractHash}:${queryCheckpointState}`,
              family: 'QueryScanRecorded',
              eventType: 'QueryScanCheckpointRecorded',
              idempotencyKey: `query:${options.dataSourceId}:${queryContractHash}:${queryCheckpointState}`,
              surface: querySurfaceKey(options.dataSourceId, queryContractHash),
              payload: {
                cappedAtLimit,
                contractChanged: false,
              },
              now,
            }),
            dataSourceId: options.dataSourceId,
            queryContractHash,
            nextCursor: queryPages.at(-1)?.nextCursor ?? null,
            complete: complete && cappedAtLimit === false,
            highWatermark: null,
          }),
        )
      }

      return {
        events,
        materialized,
        query: {
          pages: queryPages.length,
          rows: queryPages.flatMap((page: QueryRowsPage) => page.rows).length,
          complete: complete && cappedAtLimit === false,
          cappedAtLimit,
          queryContractHash,
        },
        properties: {
          observed: observedProperties,
          incomplete: incompleteProperties,
        },
      }
    }),
)

export const bodyPushCommandFromLocalChange = (input: {
  readonly pageId: PageId
  readonly baseBodyPointer: BodyPointerType
  readonly localBodyHash: Hash
}): typeof BodyPushCommand.Type =>
  decode(BodyPushCommand, {
    _tag: 'BodyPushCommand',
    commandId: commandIdFor(`body:${input.pageId}:${input.localBodyHash}`),
    pageId: input.pageId,
    baseBodyPointer: Schema.encodeSync(BodyPointer)(input.baseBodyPointer),
    nextBodyHash: input.localBodyHash,
  })

export const localPropertyIntentIds = (input: {
  readonly pageId: PageId
  readonly propertyId: PropertyId
  readonly desiredHash: Hash
}) => ({
  commandId: commandIdFor(`property:${input.pageId}:${input.propertyId}:${input.desiredHash}`),
  intentEventId: intentEventIdFor(
    `property:${input.pageId}:${input.propertyId}:${input.desiredHash}`,
  ),
  commandKey: commandKeyFor(`property:${input.pageId}:${input.propertyId}:${input.desiredHash}`),
})

export type LocalWorkspaceObservationResult = {
  readonly observations: ReadonlyArray<LocalArtifactObservation>
}

export const observeLocalWorkspace = Effect.fn(
  'NotionDatasourceSync.Observation.observeLocalWorkspace',
)(
  (
    root: AbsolutePath,
  ): Effect.Effect<LocalWorkspaceObservationResult, LocalStorageError, LocalWorkspacePort> =>
    Effect.gen(function* () {
      const workspace = yield* LocalWorkspacePort
      const observations = yield* collectStream(workspace.scan(root))
      return { observations }
    }),
)
