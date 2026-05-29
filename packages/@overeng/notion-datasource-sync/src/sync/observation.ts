import { Chunk, Effect, Schema, Stream } from 'effect'

import {
  dataSourceMetadataSurfaceKey,
  pageSurfaceKey,
  propertySurfaceKey,
  querySurfaceKey,
} from '../core/canonical.ts'
import {
  BodyPushCommand,
  type PagePropertyItemPage,
  QueryContract,
  type QueryRowsPage,
} from '../core/commands.ts'
import {
  BodyPointer,
  CommandId,
  PageSnapshot,
  WorkspaceRelativePath,
  type AbsolutePath,
  type BodyPointer as BodyPointerType,
  type CapabilityName,
  type DataSourceId as DataSourceIdType,
  type DataSourcePropertySnapshot,
  type Hash,
  type Hash as HashType,
  type LocalArtifactObservation,
  type MaterializeResult,
  type PageId,
  type PageId as PageIdType,
  type PropertyId,
  type PropertyId as PropertyIdType,
  type QueryCursor,
} from '../core/domain.ts'
import { NotionGatewayError, type BodySyncError, type LocalStorageError } from '../core/errors.ts'
import {
  IdempotencyKey,
  SyncEvent,
  SyncEventId,
  type SurfaceKey,
  type SyncEvent as SyncEventType,
  type SyncRootId,
} from '../core/events.ts'
import type { GuardName, PropertyAvailability, PropertyWriteClass } from '../core/guards.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { reportSyncProgress } from '../core/progress.ts'
import { readOnlyGatewayCapabilities } from '../gateway/gateway.ts'
import { bodyPathForRow } from '../local/workspace.ts'
import { spanAttr, spanAttributes, spanNames } from '../observability/observability.ts'
import type { OutboxCommandEnvelope, PlannerEvent } from '../planner/planner.ts'
import { hashStoreBytes } from '../store/projections.ts'

/** Caller-supplied descriptor for a schema property that should be observed per row during a remote observation pass. */
export type SchemaPropertyObservation = {
  readonly propertyId: PropertyIdType
  readonly name?: string
  readonly type?: string
  readonly configHash: HashType
  readonly writeClass: PropertyWriteClass
  readonly ordinal?: number
  readonly configJson?: string | undefined
}

/** Configuration for `observeRemoteDataSource`: identifies the data source, the query contract, schema properties to fetch per row, and optional body materialization settings. */
export type RemoteObservationOptions = {
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceIdType
  readonly workspaceRoot: AbsolutePath
  readonly queryContract: QueryContract
  readonly schemaProperties?: ReadonlyArray<SchemaPropertyObservation>
  readonly requiredCapabilities?: ReadonlyArray<CapabilityName>
  readonly materializeBodies?: boolean
  readonly rowLimit?: number
  readonly bodyPathForPage?: (pageId: PageIdType) => WorkspaceRelativePath
  readonly startCursor?: QueryCursor | null
  readonly now?: () => Date
}

/** Output of `observeRemoteDataSource`: the raw sync events to persist, materialized body results, and query/property scan summaries. */
export type RemoteObservationResult = {
  readonly events: ReadonlyArray<SyncEventType>
  readonly materialized: ReadonlyArray<MaterializeResult>
  readonly query: {
    readonly startCursor: QueryCursor | null
    readonly pages: number
    readonly rows: number
    readonly complete: boolean
    readonly cappedAtLimit: boolean
    readonly rowLimit: number | undefined
    readonly queryContractHash: HashType | undefined
  }
  readonly properties: {
    readonly observed: number
    readonly incomplete: number
  }
}

const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

const eventPayload = (value: unknown): SyncEventType['payload'] => ({
  _tag: 'VersionedJson',
  codecVersion: 'v1',
  canonicalJson: JSON.stringify(value),
})

const observedAt = (now: () => Date) => now().toISOString()

const encodeDateTimeUtc = Schema.encodeSync(Schema.DateTimeUtc)

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
    return decode({ schema: WorkspaceRelativePath, value: `page-${pageId}.nmd` })
  }

  return decision.path
}

const collectStream = <TValue, TError>(
  stream: Stream.Stream<TValue, TError>,
): Effect.Effect<ReadonlyArray<TValue>, TError> =>
  stream.pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))

const maxObservedHighWatermark = ({
  initial,
  rows,
  complete,
}: {
  readonly initial: typeof Schema.DateTimeUtc.Type | null
  readonly rows: ReadonlyArray<QueryRowsPage['rows'][number]>
  readonly complete: boolean
}): typeof Schema.DateTimeUtc.Type | null => {
  if (complete === false) return initial

  return rows.reduce((max, row) => {
    if (max === null) return row.lastEditedTime
    return encodeDateTimeUtc(row.lastEditedTime) > encodeDateTimeUtc(max) ? row.lastEditedTime : max
  }, initial)
}

const propertyValueHash = (pages: ReadonlyArray<PagePropertyItemPage>): HashType | undefined => {
  const terminalPage = pages.at(-1)
  if (terminalPage === undefined || terminalPage.hasMore === true) return undefined
  const valueHashes = pages.flatMap((page) => [
    ...page.items.map((item) => item.valueHash),
    ...(page.listMetadataHash === undefined ? [] : [page.listMetadataHash]),
  ])
  if (valueHashes.length === 1) return valueHashes[0]
  return hashStoreBytes(`property-items\t${valueHashes.join('\n')}`)
}

const propertyAvailability = (pages: ReadonlyArray<PagePropertyItemPage>): PropertyAvailability =>
  pages.at(-1)?.hasMore === false ? 'complete' : 'paginated-incomplete'

const paginatedPropertyValueJson = ({
  propertyType,
  propertyPages,
}: {
  readonly propertyType: string
  readonly propertyPages: ReadonlyArray<PagePropertyItemPage>
}): string | undefined => {
  if (propertyType === 'relation') {
    const pageIds: string[] = []
    for (const item of propertyPages.flatMap((page) => page.items)) {
      if (item.valueJson === undefined) continue
      const value = JSON.parse(item.valueJson) as { readonly id?: unknown }
      if (typeof value.id === 'string') pageIds.push(value.id)
    }
    return JSON.stringify({ _tag: 'relation', pageIds })
  }

  return propertyPages
    .flatMap((page) => page.items)
    .map((item) => item.valueJson)
    .find((value) => value !== undefined)
}

const uniqueCapabilities = (
  capabilities: ReadonlyArray<CapabilityName>,
): ReadonlyArray<CapabilityName> => [...new Set(capabilities)]

const requiredObservationCapabilities = (
  options: RemoteObservationOptions,
): ReadonlyArray<CapabilityName> =>
  uniqueCapabilities([
    ...(options.requiredCapabilities ?? readOnlyGatewayCapabilities),
    'data_source_retrieve',
    'data_source_query',
    'page_retrieve',
    ...(options.schemaProperties !== undefined && options.schemaProperties.length > 0
      ? (['page_property_paginate'] as const)
      : []),
  ])

const pagePropertyFailureAvailability = (error: NotionGatewayError): PropertyAvailability =>
  error.guard === 'UnsupportedRemoteShape' ? 'unsupported' : 'paginated-incomplete'

const schemaPropertiesObservationHash = (
  properties: ReadonlyArray<SchemaPropertyObservation | DataSourcePropertySnapshot>,
): HashType =>
  hashStoreBytes(
    JSON.stringify(
      properties
        .toSorted((left, right) => left.propertyId.localeCompare(right.propertyId))
        .map((property) => ({
          propertyId: property.propertyId,
          configHash: property.configHash,
          writeClass: property.writeClass,
          ordinal: 'ordinal' in property ? property.ordinal : undefined,
        })),
    ),
  )

const rowProjectionPayloadHash = (input: {
  readonly inTrash: boolean
  readonly payload: unknown
}): HashType => hashStoreBytes(JSON.stringify(input))

const shouldPaginateProperty = (propertyType: string | undefined): boolean =>
  propertyType === 'relation' || propertyType === 'people' || propertyType === 'files'

/** Build a `SyncBindingRecorded` event that anchors a data source to its local workspace root path; idempotent via content-based event id. */
export const makeSyncBindingRecordedEvent = (input: {
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceIdType
  readonly workspaceRoot: AbsolutePath
  readonly storeIdentity: string
  readonly now?: () => Date
}): Extract<SyncEventType, { readonly _tag: 'SyncBindingRecorded' }> => {
  const now = input.now ?? (() => new Date())
  return decode({
    schema: SyncEvent,
    value: {
      _tag: 'SyncBindingRecorded',
      ...eventBase({
        rootId: input.rootId,
        eventId: `binding:${eventIdPart(input.dataSourceId)}:${hashStoreBytes(input.workspaceRoot)}`,
        family: 'SyncRootBound',
        eventType: 'SyncBindingRecorded',
        idempotencyKey: `binding:${input.dataSourceId}:${hashStoreBytes(input.workspaceRoot)}`,
        surface: querySurfaceKey({
          dataSourceId: input.dataSourceId,
          queryContractHash: hashStoreBytes(input.workspaceRoot),
        }),
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
    },
  })
}

/** Build a `RemoteWritePlanned` event from an outbox command envelope, recording it in the event log before the command is executed. */
export const makeRemoteWritePlannedEvent = ({
  command,
  now = () => new Date(),
}: {
  readonly command: OutboxCommandEnvelope
  readonly now?: () => Date
}): Extract<SyncEventType, { readonly _tag: 'RemoteWritePlanned' }> =>
  decode({
    schema: SyncEvent,
    value: {
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
    },
  })

/** Translate a `PlannerEvent` into its corresponding store `SyncEvent`; returns `undefined` for event variants that have no durable representation (e.g. `LocalDeleteCandidateAccepted`). */
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
      return decode({
        schema: SyncEvent,
        value: {
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
        },
      })
    case 'TombstoneCandidateObserved':
      return decode({
        schema: SyncEvent,
        value: {
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
        },
      })
    case 'TombstoneClassified':
      return decode({
        schema: SyncEvent,
        value: {
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
        },
      })
    case 'LocalDeleteCandidateAccepted':
    case 'RemoteObservationAccepted':
      return undefined
  }
}

/** Build a `GuardBlocked` event recording that a named guard prevented planning on a given surface. */
export const makeGuardBlockedEvent = (input: {
  readonly rootId: SyncRootId
  readonly guard: GuardName
  readonly surface: SurfaceKey
  readonly message: string
  readonly evidence?: unknown
  readonly now?: () => Date
}): Extract<SyncEventType, { readonly _tag: 'GuardBlocked' }> => {
  const now = input.now ?? (() => new Date())
  return decode({
    schema: SyncEvent,
    value: {
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
    },
  })
}

/** Build a `TombstoneCandidateObserved` event for a page that was absent from a completed query scan, signalling it as a candidate for tombstone classification. */
export const makeQueryAbsenceCandidateEvent = (input: {
  readonly rootId: SyncRootId
  readonly dataSourceId: DataSourceIdType
  readonly pageId: PageIdType
  readonly queryContractHash: HashType
  readonly queryContract: QueryContract
  readonly directRetrieve?:
    | 'not-run'
    | 'accessible'
    | 'in-trash'
    | 'moved-out'
    | 'permission-ambiguous'
    | 'inaccessible'
    | 'unknown'
  readonly now?: () => Date
}): Extract<SyncEventType, { readonly _tag: 'TombstoneCandidateObserved' }> => {
  const now = input.now ?? (() => new Date())
  const directRetrieve = input.directRetrieve ?? 'not-run'
  const classifierPart = directRetrieve === 'not-run' ? '' : `:${directRetrieve}`
  const filtered =
    input.queryContract.filter !== null ||
    input.queryContract.membershipScope !== 'all-data-source-rows'

  return decode({
    schema: SyncEvent,
    value: {
      _tag: 'TombstoneCandidateObserved',
      ...eventBase({
        rootId: input.rootId,
        eventId: `absence:${eventIdPart(input.dataSourceId)}:${eventIdPart(input.pageId)}:${input.queryContractHash}${classifierPart}`,
        family: 'RemoteObserved',
        eventType: 'TombstoneCandidateObserved',
        idempotencyKey: `absence:${input.dataSourceId}:${input.pageId}:${input.queryContractHash}${classifierPart}`,
        surface: querySurfaceKey({
          dataSourceId: input.dataSourceId,
          queryContractHash: input.queryContractHash,
        }),
        payload: {
          dataSourceId: input.dataSourceId,
          pageId: input.pageId,
          queryContractHash: input.queryContractHash,
          classified: directRetrieve !== 'not-run',
          membershipScope: input.queryContract.membershipScope,
          filtered,
          directRetrieve,
        },
        now,
      }),
      pageId: input.pageId,
      reason: filtered === true ? 'filtered_absence_not_proof' : 'query_absence_unclassified',
    },
  })
}

/** Build a `ConflictRaised` event recording a detected divergence between local and remote content on a given surface. */
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
  return decode({
    schema: SyncEvent,
    value: {
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
    },
  })
}

/** Derive a deterministic `CommandId` from a semantic key string; prefixes with `cmd:` after URL-safe escaping. */
export const commandIdFor = (value: string): typeof CommandId.Type =>
  decode({ schema: CommandId, value: `cmd:${eventIdPart(value)}` })

/** Derive a deterministic intent `SyncEventId` from a semantic key string; prefixes with `intent:`. */
export const intentEventIdFor = (value: string): typeof SyncEventId.Type =>
  decode({ schema: SyncEventId, value: `intent:${eventIdPart(value)}` })

/** Derive a deterministic `IdempotencyKey` for an outbox command from a semantic key string; uses the `intent:` prefix. */
export const commandKeyFor = (value: string): typeof IdempotencyKey.Type =>
  decode({ schema: IdempotencyKey, value: `intent:${eventIdPart(value)}` })

/** Query the remote Notion data source, retrieve per-row properties and bodies, and return the full set of sync events to persist — without writing to the store. */
export const observeRemoteDataSource = Effect.fn(spanNames.observationRemote, {
  attributes: spanAttributes({
    [spanAttr.spanLabel]: 'remote',
    [spanAttr.processRole]: 'library',
    [spanAttr.operation]: 'observe-remote',
  }),
})(
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
        decode({
          schema: SyncEvent,
          value: {
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
          },
        }),
        ...requiredCapabilities.map((capability) => {
          const capabilityState =
            preflight.supportedCapabilities.includes(capability) === true
              ? 'supported'
              : 'unsupported'
          const capabilityPart = `${eventIdPart(options.dataSourceId)}:${capability}:${capabilityState}${
            capabilityState === 'unsupported' ? `:${now().toISOString()}` : ''
          }`

          return decode({
            schema: SyncEvent,
            value: {
              _tag: 'CapabilityPreflightChecked',
              ...eventBase({
                rootId: options.rootId,
                eventId: `capability:${capabilityPart}`,
                family: 'CompatibilityChecked',
                eventType: 'CapabilityPreflightChecked',
                idempotencyKey: `capability:${capabilityPart}`,
                surface: querySurfaceKey({
                  dataSourceId: options.dataSourceId,
                  queryContractHash: hashStoreBytes('capabilities'),
                }),
                payload: { capability },
                now,
              }),
              dataSourceId: options.dataSourceId,
              capability,
              supported: capabilityState === 'supported',
              requestId: preflight.dataSourceId === options.dataSourceId ? undefined : undefined,
            },
          })
        }),
      ]

      if (preflight.missingCapabilities.length > 0) {
        return {
          events,
          materialized: [],
          query: {
            startCursor: options.startCursor ?? null,
            pages: 0,
            rows: 0,
            complete: false,
            cappedAtLimit: false,
            rowLimit: options.rowLimit,
            queryContractHash: undefined,
          },
          properties: {
            observed: 0,
            incomplete: 0,
          },
        }
      }

      const dataSource = yield* gateway.retrieveDataSource(options.dataSourceId)
      const observedSchemaProperties = dataSource.schemaProperties ?? []
      const schemaProperties =
        options.schemaProperties === undefined ? observedSchemaProperties : options.schemaProperties
      const normalizedSchemaProperties = schemaProperties.map((property, ordinal) => {
        const normalized = {
          _tag: 'DataSourcePropertySnapshot' as const,
          propertyId: property.propertyId,
          name: property.name ?? property.propertyId,
          type: property.type ?? 'unknown',
          configHash: property.configHash,
          writeClass: property.writeClass,
          ordinal:
            'ordinal' in property && property.ordinal !== undefined ? property.ordinal : ordinal,
        }
        return 'configJson' in property && property.configJson !== undefined
          ? Object.assign(normalized, { configJson: property.configJson })
          : normalized
      })
      if (
        normalizedSchemaProperties.some((property) => shouldPaginateProperty(property.type)) ===
          true &&
        preflight.supportedCapabilities.includes('page_property_paginate') === false
      ) {
        const pagePropertyPreflight = yield* gateway.preflightCapabilities({
          _tag: 'CapabilityPreflightInput',
          dataSourceId: options.dataSourceId,
          requiredCapabilities: ['page_property_paginate'],
        })
        const capabilityState =
          pagePropertyPreflight.supportedCapabilities.includes('page_property_paginate') === true
            ? 'supported'
            : 'unsupported'
        const capabilityPart = `${eventIdPart(options.dataSourceId)}:page_property_paginate:${capabilityState}${
          capabilityState === 'unsupported' ? `:${now().toISOString()}` : ''
        }`
        events.push(
          decode({
            schema: SyncEvent,
            value: {
              _tag: 'CapabilityPreflightChecked',
              ...eventBase({
                rootId: options.rootId,
                eventId: `capability:${capabilityPart}`,
                family: 'CompatibilityChecked',
                eventType: 'CapabilityPreflightChecked',
                idempotencyKey: `capability:${capabilityPart}`,
                surface: querySurfaceKey({
                  dataSourceId: options.dataSourceId,
                  queryContractHash: hashStoreBytes('capabilities'),
                }),
                payload: { capability: 'page_property_paginate' },
                now,
              }),
              dataSourceId: options.dataSourceId,
              capability: 'page_property_paginate',
              supported: capabilityState === 'supported',
              requestId:
                pagePropertyPreflight.dataSourceId === options.dataSourceId ? undefined : undefined,
            },
          }),
        )
        if (pagePropertyPreflight.missingCapabilities.length > 0) {
          return {
            events,
            materialized: [],
            query: {
              startCursor: options.startCursor ?? null,
              pages: 0,
              rows: 0,
              complete: false,
              cappedAtLimit: false,
              rowLimit: options.rowLimit,
              queryContractHash: undefined,
            },
            properties: {
              observed: 0,
              incomplete: 0,
            },
          }
        }
      }
      const queryContract =
        options.rowLimit === undefined
          ? options.queryContract
          : decode({
              schema: QueryContract,
              value: {
                ...options.queryContract,
                pageSize: Math.min(options.queryContract.pageSize, options.rowLimit),
              },
            })
      const queryPageLimit =
        options.rowLimit === undefined
          ? undefined
          : Math.max(1, Math.ceil(options.rowLimit / queryContract.pageSize))
      let observedQueryPages = 0
      let observedQueryRows = 0
      yield* reportSyncProgress({ _tag: 'phase', phase: 'querying' })
      const queryPages = yield* collectStream(
        gateway
          .queryRows({
            _tag: 'QueryRowsInput',
            dataSourceId: options.dataSourceId,
            queryContract,
            startCursor: options.startCursor ?? null,
          })
          .pipe(
            queryPageLimit === undefined ? (stream) => stream : Stream.take(queryPageLimit),
            Stream.tap((page) => {
              observedQueryPages += 1
              observedQueryRows += page.rows.length
              return reportSyncProgress({
                _tag: 'query-page',
                pages: observedQueryPages,
                rows: observedQueryRows,
                hasMore: page.hasMore,
              })
            }),
          ),
      )
      const queryContractHash =
        queryPages.at(-1)?.queryContractHash ?? queryPages[0]?.queryContractHash
      const complete = queryPages.at(-1)?.hasMore === false
      const queriedRows = queryPages.flatMap((page: QueryRowsPage) => page.rows)
      const queryRows =
        options.rowLimit === undefined ? queriedRows : queriedRows.slice(0, options.rowLimit)
      const cappedByLimit =
        options.rowLimit !== undefined &&
        (queriedRows.length > queryRows.length || queryPages.at(-1)?.hasMore === true)
      const cappedAtLimit = cappedByLimit || queryPages.some((page) => page.cappedAtLimit)
      const highWatermark = maxObservedHighWatermark({
        initial: queryContract.highWatermark,
        rows: queryRows,
        complete: complete && cappedAtLimit === false,
      })
      const schemaPropertiesHash = schemaPropertiesObservationHash(normalizedSchemaProperties)
      events.push(
        decode({
          schema: SyncEvent,
          value: {
            _tag: 'DataSourceObserved',
            ...eventBase({
              rootId: options.rootId,
              eventId: `data-source:${eventIdPart(dataSource.dataSourceId)}:${dataSource.schemaHash}`,
              family: 'RemoteObserved',
              eventType: 'DataSourceObserved',
              idempotencyKey: `data-source:${dataSource.dataSourceId}:${dataSource.schemaHash}`,
              surface: querySurfaceKey({
                dataSourceId: dataSource.dataSourceId,
                queryContractHash: hashStoreBytes('schema'),
              }),
              payload: {},
              now,
            }),
            dataSourceId: dataSource.dataSourceId,
            requestId: dataSource.requestId,
            schemaHash: dataSource.schemaHash,
          },
        }),
      )
      events.push(
        decode({
          schema: SyncEvent,
          value: {
            _tag: 'DataSourceSchemaObserved',
            ...eventBase({
              rootId: options.rootId,
              eventId: `data-source-schema:${eventIdPart(dataSource.dataSourceId)}:${dataSource.schemaHash}:${schemaPropertiesHash}`,
              family: 'RemoteObserved',
              eventType: 'DataSourceSchemaObserved',
              idempotencyKey: `data-source-schema:${dataSource.dataSourceId}:${dataSource.schemaHash}:${schemaPropertiesHash}`,
              surface: querySurfaceKey({
                dataSourceId: dataSource.dataSourceId,
                queryContractHash: hashStoreBytes('schema'),
              }),
              payload: { schemaProperties: normalizedSchemaProperties },
              now,
            }),
            dataSourceId: dataSource.dataSourceId,
            requestId: dataSource.requestId,
            schemaHash: dataSource.schemaHash,
            schemaProperties: normalizedSchemaProperties,
          },
        }),
      )
      if (dataSource.metadataHash !== undefined) {
        events.push(
          decode({
            schema: SyncEvent,
            value: {
              _tag: 'DataSourceMetadataObserved',
              ...eventBase({
                rootId: options.rootId,
                eventId: `data-source-metadata:${eventIdPart(dataSource.dataSourceId)}:${dataSource.metadataHash}`,
                family: 'RemoteObserved',
                eventType: 'DataSourceMetadataObserved',
                idempotencyKey: `data-source-metadata:${dataSource.dataSourceId}:${dataSource.metadataHash}`,
                surface: dataSourceMetadataSurfaceKey(dataSource.dataSourceId),
                payload: {},
                now,
              }),
              dataSourceId: dataSource.dataSourceId,
              ...(dataSource.parentDatabaseId === undefined
                ? {}
                : { parentDatabaseId: dataSource.parentDatabaseId }),
              requestId: dataSource.requestId,
              metadataHash: dataSource.metadataHash,
              ...(dataSource.metadataJson === undefined
                ? {}
                : { metadataJson: dataSource.metadataJson }),
              ...(dataSource.metadataTitlePlainText === undefined
                ? {}
                : { titlePlainText: dataSource.metadataTitlePlainText }),
              ...(dataSource.metadataDescriptionPlainText === undefined
                ? {}
                : { descriptionPlainText: dataSource.metadataDescriptionPlainText }),
            },
          }),
        )
      }
      if (dataSource.parentDatabaseId !== undefined && gateway.listDataSourceViews !== undefined) {
        const views = yield* collectStream(
          gateway.listDataSourceViews({
            databaseId: dataSource.parentDatabaseId,
            dataSourceId: dataSource.dataSourceId,
          }),
        ).pipe(
          Effect.match({
            onFailure: () => [] as const,
            onSuccess: (snapshots) => snapshots,
          }),
        )
        for (const view of views) {
          events.push(
            decode({
              schema: SyncEvent,
              value: {
                _tag: 'DataSourceViewObserved',
                ...eventBase({
                  rootId: options.rootId,
                  eventId: `view:${eventIdPart(view.viewId)}:${view.viewHash}`,
                  family: 'RemoteObserved',
                  eventType: 'DataSourceViewObserved',
                  idempotencyKey: `view:${view.viewId}:${view.viewHash}`,
                  surface: querySurfaceKey({
                    dataSourceId: view.dataSourceId,
                    queryContractHash: hashStoreBytes('views'),
                  }),
                  payload: { viewJson: view.viewJson },
                  now,
                }),
                dataSourceId: view.dataSourceId,
                databaseId: view.databaseId,
                viewId: view.viewId,
                requestId: view.requestId,
                viewName: view.name,
                viewType: view.viewType,
                viewHash: view.viewHash,
                viewJson: view.viewJson,
              },
            }),
          )
        }
      }
      const materialized: MaterializeResult[] = []
      let observedProperties = 0
      let incompleteProperties = 0
      let remainingRows = queryRows.length
      let hydratedRows = 0

      for (const queryPage of queryPages) {
        if (remainingRows <= 0) break
        for (const row of queryPage.rows.slice(0, remainingRows)) {
          remainingRows -= 1
          hydratedRows += 1
          yield* reportSyncProgress({
            _tag: 'hydrate-row',
            current: hydratedRows,
            total: queryRows.length,
          })
          const page =
            row.propertyValuesJson === undefined
              ? yield* gateway.retrievePage(row.pageId)
              : PageSnapshot.make({
                  _tag: 'PageSnapshot',
                  pageId: row.pageId,
                  ...(row.dataSourceId === undefined ? {} : { dataSourceId: row.dataSourceId }),
                  requestId: queryPage.requestId,
                  observedAt: Schema.decodeSync(Schema.DateTimeUtc)(now().toISOString()),
                  propertiesHash: row.propertiesHash,
                  propertyValuesJson: row.propertyValuesJson,
                  inTrash: row.inTrash,
                })
          const bodyPointer =
            options.materializeBodies === false
              ? Schema.decodeUnknownSync(BodyPointer)({
                  _tag: 'BodyPointer',
                  pageId: row.pageId,
                  bodyHash: hashStoreBytes(`body:not-materialized:${row.pageId}`),
                  observedAt: now().toISOString(),
                  safety: {
                    truncated: false,
                    unknownBlockCause: undefined,
                    selection: 'safe',
                    wouldDeleteChildren: false,
                    syncedPageUnsupported: false,
                    adapterConflict: false,
                    adapterMutationSurfaces: [],
                  },
                })
              : yield* body.observe({ _tag: 'ObserveBodyInput', pageId: row.pageId })
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
          const rowPayload = {
            bodyPath: path,
            sidecarIdentityProven: materializeResult !== undefined,
            ownWriteMaterializationIds:
              materializeResult === undefined ? [] : [materializeResult.ownWriteSuppressionToken],
            safety: bodyPointer.safety,
          }
          const rowPayloadHash = rowProjectionPayloadHash({
            inTrash: page.inTrash,
            payload: rowPayload,
          })

          events.push(
            decode({
              schema: SyncEvent,
              value: {
                _tag: 'RowObserved',
                ...eventBase({
                  rootId: options.rootId,
                  eventId: `row:${eventIdPart(row.pageId)}:${page.propertiesHash}:${bodyPointer.bodyHash}:${rowPayloadHash}`,
                  family: 'RemoteObserved',
                  eventType: 'RowObserved',
                  idempotencyKey: `row:${row.pageId}:${page.propertiesHash}:${bodyPointer.bodyHash}:${rowPayloadHash}`,
                  surface: pageSurfaceKey(row.pageId),
                  payload: rowPayload,
                  now,
                }),
                dataSourceId: page.dataSourceId ?? options.dataSourceId,
                pageId: row.pageId,
                propertiesHash: page.propertiesHash,
                bodyPointer: Schema.encodeSync(BodyPointer)(bodyPointer),
                inTrash: page.inTrash,
              },
            }),
          )

          for (const property of normalizedSchemaProperties) {
            const inlineValueJson = page.propertyValuesJson?.[property.propertyId]
            if (
              options.schemaProperties === undefined &&
              inlineValueJson !== undefined &&
              shouldPaginateProperty(property.type) === false
            ) {
              const valueHash = hashStoreBytes(inlineValueJson)
              observedProperties += 1
              const propertyPart = `${eventIdPart(row.pageId)}:${eventIdPart(property.propertyId)}:${valueHash}`
              events.push(
                decode({
                  schema: SyncEvent,
                  value: {
                    _tag: 'PagePropertyCheckpointRecorded',
                    ...eventBase({
                      rootId: options.rootId,
                      eventId: `property:${propertyPart}`,
                      family: 'QueryScanRecorded',
                      eventType: 'PagePropertyCheckpointRecorded',
                      idempotencyKey: `property:${propertyPart}`,
                      surface: propertySurfaceKey({
                        pageId: row.pageId,
                        propertyId: property.propertyId,
                      }),
                      payload: {
                        availability: 'complete',
                        baseHash: valueHash,
                        valueJson: inlineValueJson,
                      },
                      now,
                    }),
                    pageId: row.pageId,
                    propertyId: property.propertyId,
                    nextCursor: null,
                    complete: true,
                    valueHash,
                  },
                }),
              )
              continue
            }

            if (
              options.schemaProperties === undefined &&
              shouldPaginateProperty(property.type) === false
            ) {
              continue
            }

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
              const observedAtPart = now().toISOString()
              incompleteProperties += 1
              const propertyPart = `${eventIdPart(row.pageId)}:${eventIdPart(property.propertyId)}:failed:${availability}:${observedAtPart}`
              events.push(
                decode({
                  schema: SyncEvent,
                  value: {
                    _tag: 'PagePropertyCheckpointRecorded',
                    ...eventBase({
                      rootId: options.rootId,
                      eventId: `property:${propertyPart}`,
                      family: 'QueryScanRecorded',
                      eventType: 'PagePropertyCheckpointRecorded',
                      idempotencyKey: `property:${propertyPart}`,
                      surface: propertySurfaceKey({
                        pageId: row.pageId,
                        propertyId: property.propertyId,
                      }),
                      payload: { availability },
                      now,
                    }),
                    pageId: row.pageId,
                    propertyId: property.propertyId,
                    nextCursor: null,
                    complete: false,
                  },
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

            const valueJson = paginatedPropertyValueJson({
              propertyType: property.type ?? 'unknown',
              propertyPages,
            })
            const propertyPart = `${eventIdPart(row.pageId)}:${eventIdPart(property.propertyId)}:${valueHash ?? `incomplete:${availability}`}`
            events.push(
              decode({
                schema: SyncEvent,
                value: {
                  _tag: 'PagePropertyCheckpointRecorded',
                  ...eventBase({
                    rootId: options.rootId,
                    eventId: `property:${propertyPart}`,
                    family: 'QueryScanRecorded',
                    eventType: 'PagePropertyCheckpointRecorded',
                    idempotencyKey: `property:${propertyPart}`,
                    surface: propertySurfaceKey({
                      pageId: row.pageId,
                      propertyId: property.propertyId,
                    }),
                    payload: {
                      availability,
                      baseHash: valueHash,
                      ...(valueJson === undefined ? {} : { valueJson }),
                    },
                    now,
                  }),
                  pageId: row.pageId,
                  propertyId: property.propertyId,
                  nextCursor: propertyPages.at(-1)?.nextCursor ?? null,
                  complete: valueHash !== undefined,
                  ...(valueHash === undefined ? {} : { valueHash }),
                },
              }),
            )
          }
        }
      }

      if (queryContractHash !== undefined) {
        const queryCheckpointState =
          complete === true && cappedAtLimit === false ? 'complete' : 'incomplete'
        const nextCursor = queryPages.at(-1)?.nextCursor ?? null
        const cursorPart = nextCursor === null ? 'terminal' : eventIdPart(nextCursor)
        events.push(
          decode({
            schema: SyncEvent,
            value: {
              _tag: 'QueryScanCheckpointRecorded',
              ...eventBase({
                rootId: options.rootId,
                eventId: `query:${eventIdPart(options.dataSourceId)}:${queryContractHash}:${queryCheckpointState}:${cursorPart}`,
                family: 'QueryScanRecorded',
                eventType: 'QueryScanCheckpointRecorded',
                idempotencyKey: `query:${options.dataSourceId}:${queryContractHash}:${queryCheckpointState}:${cursorPart}`,
                surface: querySurfaceKey({ dataSourceId: options.dataSourceId, queryContractHash }),
                payload: {
                  cappedAtLimit,
                  contractChanged: false,
                },
                now,
              }),
              dataSourceId: options.dataSourceId,
              queryContractHash,
              nextCursor,
              complete: complete && cappedAtLimit === false,
              highWatermark: highWatermark === null ? null : encodeDateTimeUtc(highWatermark),
            },
          }),
        )
      }

      return {
        events,
        materialized,
        query: {
          startCursor: options.startCursor ?? null,
          pages: queryPages.length,
          rows: queryRows.length,
          complete: complete && cappedAtLimit === false,
          cappedAtLimit,
          rowLimit: options.rowLimit,
          queryContractHash,
        },
        properties: {
          observed: observedProperties,
          incomplete: incompleteProperties,
        },
      }
    }),
)

/** Construct a `BodyPushCommand` from a locally-observed body change, deriving a deterministic command id from the page id and local hash. */
export const bodyPushCommandFromLocalChange = (input: {
  readonly pageId: PageId
  readonly baseBodyPointer: BodyPointerType
  readonly localBodyHash: Hash
  readonly localBodyPath?: WorkspaceRelativePath
  readonly localBodyContent?: string
}): typeof BodyPushCommand.Type =>
  decode({
    schema: BodyPushCommand,
    value: {
      _tag: 'BodyPushCommand',
      commandId: commandIdFor(`body:${input.pageId}:${input.localBodyHash}`),
      pageId: input.pageId,
      baseBodyPointer: Schema.encodeSync(BodyPointer)(input.baseBodyPointer),
      nextBodyHash: input.localBodyHash,
      ...(input.localBodyPath === undefined ? {} : { localBodyPath: input.localBodyPath }),
      ...(input.localBodyContent === undefined ? {} : { localBodyContent: input.localBodyContent }),
    },
  })

/** Derive stable `commandId`, `intentEventId`, and `commandKey` for a property write intent from its page, property, and target hash. */
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

/** Result of scanning the local workspace; wraps the raw `LocalArtifactObservation` stream output. */
export type LocalWorkspaceObservationResult = {
  readonly observations: ReadonlyArray<LocalArtifactObservation>
}

/** Scan the local workspace directory via `LocalWorkspacePort` and collect all artifact observations (changed, deleted, unchanged pages). */
export const observeLocalWorkspace = Effect.fn(spanNames.observationLocal, {
  attributes: spanAttributes({
    [spanAttr.spanLabel]: 'local',
    [spanAttr.processRole]: 'library',
    [spanAttr.operation]: 'observe-local',
  }),
})(
  (
    root: AbsolutePath,
  ): Effect.Effect<LocalWorkspaceObservationResult, LocalStorageError, LocalWorkspacePort> =>
    Effect.gen(function* () {
      const workspace = yield* LocalWorkspacePort
      const observations = yield* collectStream(workspace.scan(root))
      return { observations }
    }),
)
