import { HttpClient } from '@effect/platform'
import { Chunk, Effect, Layer, Option, Schema, Stream } from 'effect'

import {
  type DatabaseFilter,
  type DatabaseSort,
  NotionConfig,
  NotionDataSources,
  NotionDatabases,
  NotionPages,
  type NotionApiError,
  type NotionPage,
  type NotionPagePropertyItem,
  type PaginatedResult,
} from '@overeng/notion-effect-client'

import { canonicalHash, dataSourceMetadataHash, queryContractHash } from '../core/canonical.ts'
import type {
  CanonicalDataSourceIcon,
  CanonicalDataSourceMetadata,
  CanonicalOptionValue,
  CanonicalPropertyValue,
  PatchDataSourceMetadataCommand,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  QueryRowsInput,
  RestorePageCommand,
  SchemaPatchOperation,
  TrashPageCommand,
} from '../core/commands.ts'
import { PagePropertyItemPage, QueryRowsPage } from '../core/commands.ts'
import {
  DataSourceId,
  DataSourceSnapshot,
  NotionRequestId,
  PageId,
  PagePropertyItem,
  PageSnapshot,
  type PropertyId,
  QueryCursor,
  RowPageSnapshot,
  type CapabilityName,
  type Hash,
  type NotionApiContract as NotionApiContractType,
} from '../core/domain.ts'
import type { NotionGatewayError } from '../core/errors.ts'
import { blocked, guardStaleSurfaceBase, type GuardName } from '../core/guards.ts'
import { NotionDataSourceGateway, type NotionDataSourceGatewayShape } from '../core/ports.ts'
import {
  allGatewayCapabilities,
  makeCapabilityPreflightResult,
  makeGatewayError,
  makeNotionApiContract,
  makeNotionDataSourceGateway,
  supportedNotionApiVersion,
  type GatewayOperation,
} from './gateway.ts'

/** Schema-backed data-source projection consumed by the datasource-sync adapter. */
export type NotionGatewayDataSource = {
  readonly id: string
  readonly properties: Record<string, unknown>
  readonly title?: readonly unknown[]
  readonly description?: readonly unknown[]
  readonly icon?: unknown
  readonly parent?: { readonly type: 'database_id'; readonly database_id: string }
}

/** Schema-backed page projection consumed by the datasource-sync adapter. */
export type NotionGatewayPage = Pick<
  NotionPage,
  'id' | 'parent' | 'properties' | 'last_edited_time' | 'in_trash'
>

type NotionGatewayPagePropertyResult = PaginatedResult<NotionPagePropertyItem> & {
  readonly propertyItem?: unknown
}

type NotionGatewayDatabase = {
  readonly id: string
  readonly title?: readonly unknown[]
  readonly description?: readonly unknown[]
  readonly icon?: unknown
}

/**
 * Minimal Notion API surface the live datasource-sync gateway depends on.
 *
 * A thin contract over the upstream `notion-effect-client` so the gateway can be wired with
 * either the real HTTP client or a stub in tests; errors are intentionally `unknown` here so
 * the gateway translates them into typed `NotionGatewayError`s with the correct guard.
 */
export type NotionGatewayClient = {
  readonly retrieveDataSource: (input: {
    readonly dataSourceId: string
  }) => Effect.Effect<NotionGatewayDataSource, unknown>
  readonly queryDataSource: (input: {
    readonly dataSourceId: string
    readonly pageSize: number
    readonly startCursor: string | undefined
    readonly filter: DatabaseFilter | undefined
    readonly sorts: ReadonlyArray<DatabaseSort> | undefined
  }) => Effect.Effect<PaginatedResult<NotionGatewayPage>, unknown>
  readonly retrievePage: (input: {
    readonly pageId: string
  }) => Effect.Effect<NotionGatewayPage, unknown>
  readonly retrievePageProperty: (input: {
    readonly pageId: string
    readonly propertyId: string
    readonly pageSize: number
    readonly startCursor: string | undefined
  }) => Effect.Effect<NotionGatewayPagePropertyResult, unknown>
  readonly retrieveDatabase: (input: {
    readonly databaseId: string
  }) => Effect.Effect<NotionGatewayDatabase, unknown>
  readonly updatePage: (input: {
    readonly pageId: string
    readonly properties?: Record<string, unknown>
    readonly inTrash?: boolean
  }) => Effect.Effect<NotionGatewayPage, unknown>
  readonly updateDatabase: (input: {
    readonly databaseId: string
    readonly title?: readonly unknown[]
    readonly description?: readonly unknown[]
  }) => Effect.Effect<NotionGatewayDatabase, unknown>
  readonly updateDataSource: (input: {
    readonly dataSourceId: string
    readonly properties?: Record<string, unknown>
    readonly title?: readonly unknown[]
    readonly description?: readonly unknown[]
  }) => Effect.Effect<NotionGatewayDataSource, unknown>
}

/** Tagged error raised when the live gateway is asked to perform an operation it cannot map onto the underlying Notion client. */
export class UnsupportedAdapterOperation extends Schema.TaggedError<UnsupportedAdapterOperation>()(
  'UnsupportedAdapterOperation',
  {
    operation: Schema.String,
    capability: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

/** Optional configuration knobs for the live Notion gateway — pin the configured API version and reported client version. */
export type NotionDataSourceGatewayLiveOptions = {
  readonly configuredApiVersion?: string
  readonly clientVersion?: string
}

const supportedNotionEffectClientCapabilities: ReadonlyArray<CapabilityName> = [
  'data_source_retrieve',
  'data_source_query',
  'page_retrieve',
  'page_property_paginate',
  'page_property_update',
  'page_trash',
  'page_restore',
  'schema_update',
  'data_source_metadata_update',
] as const satisfies ReadonlyArray<CapabilityName>

const unavailableRequestId = NotionRequestId.make('notion-client-success-request-id-unavailable')

const decodeDateTimeUtc = Schema.decodeUnknownSync(Schema.DateTimeUtc)

const observedNow = () => decodeDateTimeUtc(new Date().toISOString())

const notionApiErrorRequestId = (error: NotionApiError): string | undefined =>
  Option.getOrUndefined(error.requestId)

const isNotionApiError = (cause: unknown): cause is NotionApiError =>
  typeof cause === 'object' && cause !== null && '_tag' in cause && cause._tag === 'NotionApiError'

const isNotionGatewayError = (cause: unknown): cause is NotionGatewayError =>
  typeof cause === 'object' &&
  cause !== null &&
  '_tag' in cause &&
  cause._tag === 'NotionGatewayError'

const isPermissionAmbiguous = (error: NotionApiError): boolean =>
  error.status === 403 ||
  error.status === 404 ||
  error.code === 'restricted_resource' ||
  error.code === 'object_not_found'

const mapClientError =
  (input: {
    readonly operation: GatewayOperation
    readonly dataSourceId?: DataSourceId
    readonly pageId?: PageId
  }) =>
  (cause: unknown): NotionGatewayError => {
    if (isNotionGatewayError(cause) === true) {
      return cause
    }

    if (isNotionApiError(cause) === false) {
      return makeGatewayError({
        ...input,
        message: `Notion adapter operation failed: ${input.operation}`,
        cause,
      })
    }

    const requestId = notionApiErrorRequestId(cause)

    return makeGatewayError({
      ...input,
      ...(requestId === undefined ? {} : { requestId }),
      ...(isPermissionAmbiguous(cause) === true ? { guard: 'PermissionAmbiguous' } : {}),
      message: cause.message,
      cause,
    })
  }

const unsupportedOperation = (input: {
  readonly operation: GatewayOperation
  readonly capability?: CapabilityName
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
  readonly message: string
}): NotionGatewayError =>
  makeGatewayError({
    operation: input.operation,
    ...(input.dataSourceId === undefined ? {} : { dataSourceId: input.dataSourceId }),
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
    guard: 'UnsupportedRemoteShape',
    message: input.message,
    cause: new UnsupportedAdapterOperation({
      operation: input.operation,
      ...(input.capability === undefined ? {} : { capability: input.capability }),
      message: input.message,
    }),
  })

const gatewayGuardError = (input: {
  readonly operation: GatewayOperation
  readonly guard: GuardName
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
  readonly message: string
}): NotionGatewayError =>
  makeGatewayError({
    operation: input.operation,
    ...(input.dataSourceId === undefined ? {} : { dataSourceId: input.dataSourceId }),
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
    guard: input.guard,
    message: input.message,
  })

const optionalDataSourceIdFromPage = (page: NotionGatewayPage): DataSourceId | undefined =>
  page.parent.type === 'data_source_id' ? DataSourceId.make(page.parent.data_source_id) : undefined

const richTextPlainText = (value: readonly unknown[]): string =>
  value
    .map((part) =>
      typeof part === 'object' && part !== null && 'plain_text' in part
        ? String((part as { readonly plain_text: unknown }).plain_text)
        : '',
    )
    .join('')

const canonicalIconFromRemote = (
  icon: NotionGatewayDataSource['icon'],
): CanonicalDataSourceIcon => {
  if (icon === undefined || icon === null || typeof icon !== 'object' || !('type' in icon)) {
    return { _tag: 'none' }
  }
  const iconRecord = icon as Record<string, unknown>
  switch (iconRecord.type) {
    case 'emoji':
      return { _tag: 'emoji', emoji: String(iconRecord.emoji ?? '') }
    case 'custom_emoji':
      return {
        _tag: 'custom_emoji',
        id:
          typeof iconRecord.custom_emoji === 'object' &&
          iconRecord.custom_emoji !== null &&
          'id' in iconRecord.custom_emoji
            ? String(iconRecord.custom_emoji.id)
            : 'unknown',
      }
    case 'icon':
      return {
        _tag: 'notion_icon',
        name:
          typeof iconRecord.icon === 'object' &&
          iconRecord.icon !== null &&
          'name' in iconRecord.icon
            ? String(iconRecord.icon.name)
            : 'unknown',
        ...(typeof iconRecord.icon === 'object' &&
        iconRecord.icon !== null &&
        'color' in iconRecord.icon &&
        typeof iconRecord.icon.color === 'string'
          ? { color: iconRecord.icon.color }
          : {}),
      }
    case 'external':
      return {
        _tag: 'external',
        urlHash: canonicalHash(
          typeof iconRecord.external === 'object' &&
            iconRecord.external !== null &&
            'url' in iconRecord.external
            ? String(iconRecord.external.url)
            : '',
        ),
      }
    case 'file':
      return { _tag: 'transient_file' }
    default:
      return { _tag: 'none' }
  }
}

/** Project a remote Notion data source into the canonical metadata surface (title, description, icon) used for sync planning. */
export const canonicalDataSourceMetadataFromRemote = (
  dataSource: NotionGatewayDataSource,
): CanonicalDataSourceMetadata => ({
  _tag: 'CanonicalDataSourceMetadata',
  titlePlainText: richTextPlainText(dataSource.title ?? []),
  descriptionPlainText: richTextPlainText(dataSource.description ?? []),
  icon: canonicalIconFromRemote(dataSource.icon),
})

const richTextWrite = (plainText: string): ReadonlyArray<unknown> => [
  { type: 'text', text: { content: plainText } },
]

const dataSourceSnapshotFromRemote = (dataSource: NotionGatewayDataSource) =>
  DataSourceSnapshot.make({
    _tag: 'DataSourceSnapshot',
    dataSourceId: DataSourceId.make(dataSource.id),
    requestId: unavailableRequestId,
    observedAt: observedNow(),
    schemaHash: canonicalHash(dataSource.properties),
    metadataHash: dataSourceMetadataHash(canonicalDataSourceMetadataFromRemote(dataSource)),
  })

const pageSnapshotFromRemote = (page: NotionGatewayPage) =>
  PageSnapshot.make({
    _tag: 'PageSnapshot',
    pageId: PageId.make(page.id),
    ...(optionalDataSourceIdFromPage(page) === undefined
      ? {}
      : { dataSourceId: optionalDataSourceIdFromPage(page) }),
    requestId: unavailableRequestId,
    observedAt: observedNow(),
    propertiesHash: canonicalHash(page.properties),
    inTrash: page.in_trash,
  })

const rowSnapshotFromRemote = (page: NotionGatewayPage) =>
  RowPageSnapshot.make({
    _tag: 'RowPageSnapshot',
    pageId: PageId.make(page.id),
    propertiesHash: canonicalHash(page.properties),
    lastEditedTime: decodeDateTimeUtc(page.last_edited_time),
    inTrash: page.in_trash,
  })

const optionValue = (option: CanonicalOptionValue) => ({
  ...(option.id === undefined ? {} : { id: option.id }),
  name: option.name,
  ...(option.color === undefined ? {} : { color: option.color }),
})

const encodeDateTimeUtc = (value: typeof Schema.DateTimeUtc.Type): string =>
  Schema.encodeSync(Schema.DateTimeUtc)(value)

const propertyValueToNotion = (
  value: CanonicalPropertyValue,
): Effect.Effect<unknown, NotionGatewayError> => {
  switch (value._tag) {
    case 'title':
      return Effect.succeed({
        title: [{ type: 'text', text: { content: value.plainText } }],
      })
    case 'rich_text':
      return Effect.succeed({
        rich_text: [{ type: 'text', text: { content: value.plainText } }],
      })
    case 'number':
      return Effect.succeed({ number: value.value })
    case 'checkbox':
      return Effect.succeed({ checkbox: value.checked })
    case 'date':
      return Effect.succeed({
        date: {
          start: encodeDateTimeUtc(value.start),
          ...(value.end === null ? {} : { end: encodeDateTimeUtc(value.end) }),
        },
      })
    case 'select':
      return Effect.succeed({
        select: value.option === null ? null : optionValue(value.option),
      })
    case 'multi_select':
      return Effect.succeed({
        multi_select: value.options.map(optionValue),
      })
    case 'status':
      return Effect.succeed({
        status: value.option === null ? null : optionValue(value.option),
      })
    case 'relation':
      return Effect.succeed({
        relation: value.pageIds.map((pageId) => ({ id: pageId })),
      })
    case 'people':
      return Effect.succeed({
        people: value.userIds.map((id) => ({ id })),
      })
    case 'email':
      return Effect.succeed({ email: value.value })
    case 'url':
      return Effect.succeed({ url: value.value })
    case 'phone_number':
      return Effect.succeed({ phone_number: value.value })
    case 'empty':
    case 'files':
      return Effect.fail(
        unsupportedOperation({
          operation: 'patchPageProperties',
          capability: 'page_property_update',
          message: `Canonical ${value._tag} property writes need additional remote shape information`,
        }),
      )
    case 'computed':
      return Effect.fail(
        gatewayGuardError({
          operation: 'patchPageProperties',
          guard: 'ComputedPropertyWrite',
          message: 'Computed Notion properties cannot be written',
        }),
      )
  }
}

/**
 * Convert a `CanonicalPropertyValue` patch into the Notion API's property update payload.
 *
 * Fails with the corresponding `NotionGatewayError` guard (e.g. `ComputedPropertyWrite`,
 * `UnsupportedRemoteShape`) when a value cannot be expressed in the Notion property model,
 * so the caller can reject before issuing the request.
 */
export const pagePropertyPatchToNotion = (
  patch: Readonly<Record<string, CanonicalPropertyValue>>,
): Effect.Effect<Record<string, unknown>, NotionGatewayError> =>
  Effect.forEach(Object.entries(patch), ([propertyId, value]) =>
    propertyValueToNotion(value).pipe(Effect.map((notionValue) => [propertyId, notionValue])),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)))

type AddPropertyDefinitionRuntime = (SchemaPatchOperation & { _tag: 'AddProperty' })['definition']

const addPropertyDefinitionToNotion = (
  definition: AddPropertyDefinitionRuntime,
): Record<string, unknown> => {
  switch (definition._tag) {
    case 'rich_text':
    case 'number':
    case 'checkbox':
    case 'date':
    case 'url':
    case 'email':
    case 'phone_number':
    case 'people':
      return { [definition._tag]: {} }
    case 'select':
    case 'multi_select':
      return {
        [definition._tag]: { options: definition.options.map(optionValue) },
      }
  }
}

const buildAddSelectOptionsPayload = (
  operation: Extract<SchemaPatchOperation, { _tag: 'AddSelectOptions' }>,
): Effect.Effect<readonly [string, Record<string, unknown>], NotionGatewayError> => {
  if (operation.newOptions.length === 0) {
    return Effect.fail(
      unsupportedOperation({
        operation: 'patchDataSourceSchema',
        capability: 'schema_update',
        message: `AddSelectOptions requires at least one new option for property ${operation.propertyId}`,
      }),
    )
  }

  const seenNames = new Set<string>()
  const seenIds = new Set<string>()
  const existingNames = new Set<string>()
  const existingIds = new Set<string>()

  for (const option of operation.existingOptions) {
    if (seenNames.has(option.name) === true) {
      return Effect.fail(
        unsupportedOperation({
          operation: 'patchDataSourceSchema',
          capability: 'schema_update',
          message: `AddSelectOptions existingOptions contains duplicate option name '${option.name}' for property ${operation.propertyId}`,
        }),
      )
    }
    seenNames.add(option.name)
    existingNames.add(option.name)
    if (option.id !== undefined) {
      if (seenIds.has(option.id) === true) {
        return Effect.fail(
          unsupportedOperation({
            operation: 'patchDataSourceSchema',
            capability: 'schema_update',
            message: `AddSelectOptions existingOptions contains duplicate option id '${option.id}' for property ${operation.propertyId}`,
          }),
        )
      }
      seenIds.add(option.id)
      existingIds.add(option.id)
    }
  }

  for (const option of operation.newOptions) {
    if (existingNames.has(option.name) === true) {
      return Effect.fail(
        unsupportedOperation({
          operation: 'patchDataSourceSchema',
          capability: 'schema_update',
          message: `AddSelectOptions newOptions name '${option.name}' already exists for property ${operation.propertyId}`,
        }),
      )
    }
    if (seenNames.has(option.name) === true) {
      return Effect.fail(
        unsupportedOperation({
          operation: 'patchDataSourceSchema',
          capability: 'schema_update',
          message: `AddSelectOptions newOptions contains duplicate option name '${option.name}' for property ${operation.propertyId}`,
        }),
      )
    }
    seenNames.add(option.name)
    if (option.id !== undefined) {
      if (existingIds.has(option.id) === true) {
        return Effect.fail(
          unsupportedOperation({
            operation: 'patchDataSourceSchema',
            capability: 'schema_update',
            message: `AddSelectOptions newOptions id '${option.id}' already exists for property ${operation.propertyId}`,
          }),
        )
      }
      if (seenIds.has(option.id) === true) {
        return Effect.fail(
          unsupportedOperation({
            operation: 'patchDataSourceSchema',
            capability: 'schema_update',
            message: `AddSelectOptions newOptions contains duplicate option id '${option.id}' for property ${operation.propertyId}`,
          }),
        )
      }
      seenIds.add(option.id)
    }
  }

  const combined = [...operation.existingOptions, ...operation.newOptions].map(optionValue)
  return Effect.succeed([operation.propertyId, { [operation.propertyType]: { options: combined } }])
}

const schemaOperationToProperty = (
  operation: SchemaPatchOperation,
): Effect.Effect<readonly [string, Record<string, unknown>], NotionGatewayError> => {
  switch (operation._tag) {
    case 'AddProperty':
      return Effect.succeed([operation.name, addPropertyDefinitionToNotion(operation.definition)])
    case 'RenameProperty':
      return Effect.succeed([operation.propertyId, { name: operation.newName }])
    case 'AddSelectOptions':
      return buildAddSelectOptionsPayload(operation)
  }
}

/**
 * Translates the conservative schema operation list into the Notion
 * `update_data_source` properties payload. Fails closed when:
 *
 * - `operations` is empty (no supported schema patch to apply).
 * - Two operations target the same Notion property key (ambiguous merge).
 * - An `AddSelectOptions` operation has empty `newOptions`, duplicate
 *   option names/ids in the combined `existingOptions ++ newOptions` list,
 *   or attempts to add an option that already exists on the property.
 */
export const dataSourceOperationsToNotion = (
  operations: ReadonlyArray<SchemaPatchOperation>,
): Effect.Effect<Record<string, unknown>, NotionGatewayError> => {
  if (operations.length === 0) {
    return Effect.fail(
      unsupportedOperation({
        operation: 'patchDataSourceSchema',
        capability: 'schema_update',
        message:
          'Schema patch requires at least one supported operation (AddProperty, RenameProperty, or AddSelectOptions)',
      }),
    )
  }

  return Effect.reduce(operations, {} as Record<string, unknown>, (properties, operation) =>
    schemaOperationToProperty(operation).pipe(
      Effect.flatMap(([key, value]) =>
        Object.prototype.hasOwnProperty.call(properties, key) === true
          ? Effect.fail(
              unsupportedOperation({
                operation: 'patchDataSourceSchema',
                capability: 'schema_update',
                message: `Schema patch contains multiple operations targeting the same property key: ${key}`,
              }),
            )
          : Effect.succeed({ ...properties, [key]: value }),
      ),
    ),
  )
}

const querySortsToNotion = (
  input: QueryRowsInput,
): Effect.Effect<ReadonlyArray<DatabaseSort> | undefined, NotionGatewayError> =>
  input.queryContract.sorts.length === 0
    ? Effect.succeed(undefined)
    : Effect.succeed(
        input.queryContract.sorts.map((sort) => ({
          property: sort.propertyId,
          direction: sort.direction,
        })),
      )

const unsupportedQueryFilter = ({
  input,
  message,
}: {
  readonly input: QueryRowsInput
  readonly message: string
}): Effect.Effect<never, NotionGatewayError> =>
  Effect.fail(
    unsupportedOperation({
      operation: 'queryRows',
      capability: 'data_source_query',
      dataSourceId: input.dataSourceId,
      message,
    }),
  )

const optionName = (option: CanonicalOptionValue | null): string | null =>
  option === null ? null : option.name

const propertyValueFilterOperand = (input: {
  readonly queryInput: QueryRowsInput
  readonly value: CanonicalPropertyValue
}): Effect.Effect<
  { readonly propertyType: string; readonly operand: string | number | boolean | null },
  NotionGatewayError
> => {
  switch (input.value._tag) {
    case 'title':
      return Effect.succeed({ propertyType: 'title', operand: input.value.plainText })
    case 'rich_text':
      return Effect.succeed({ propertyType: 'rich_text', operand: input.value.plainText })
    case 'number':
      return Effect.succeed({ propertyType: 'number', operand: input.value.value })
    case 'checkbox':
      return Effect.succeed({ propertyType: 'checkbox', operand: input.value.checked })
    case 'date':
      return Effect.succeed({
        propertyType: 'date',
        operand: encodeDateTimeUtc(input.value.start),
      })
    case 'select':
      return Effect.succeed({ propertyType: 'select', operand: optionName(input.value.option) })
    case 'multi_select':
      return input.value.options.length === 1
        ? Effect.succeed({
            propertyType: 'multi_select',
            operand: input.value.options[0]?.name ?? null,
          })
        : unsupportedQueryFilter({
            input: input.queryInput,
            message:
              'Multi-select filters require exactly one option for the supported canonical subset',
          })
    case 'status':
      return Effect.succeed({ propertyType: 'status', operand: optionName(input.value.option) })
    case 'relation':
      return input.value.pageIds.length === 1
        ? Effect.succeed({ propertyType: 'relation', operand: input.value.pageIds[0] ?? null })
        : unsupportedQueryFilter({
            input: input.queryInput,
            message:
              'Relation filters require exactly one page ID for the supported canonical subset',
          })
    case 'people':
      return input.value.userIds.length === 1
        ? Effect.succeed({ propertyType: 'people', operand: input.value.userIds[0] ?? null })
        : unsupportedQueryFilter({
            input: input.queryInput,
            message:
              'People filters require exactly one user ID for the supported canonical subset',
          })
    case 'email':
      return Effect.succeed({ propertyType: 'email', operand: input.value.value })
    case 'url':
      return Effect.succeed({ propertyType: 'url', operand: input.value.value })
    case 'phone_number':
      return Effect.succeed({ propertyType: 'phone_number', operand: input.value.value })
    case 'empty':
    case 'files':
    case 'computed':
      return unsupportedQueryFilter({
        input: input.queryInput,
        message: `Canonical ${input.value._tag} filters need additional remote shape information`,
      })
  }
}

const isFilterOperatorSupported = ({
  propertyType,
  operator,
}: {
  readonly propertyType: string
  readonly operator: string
}): boolean => {
  const textOperators = new Set([
    'equals',
    'does_not_equal',
    'contains',
    'does_not_contain',
    'starts_with',
    'ends_with',
  ])
  const equalityOperators = new Set(['equals', 'does_not_equal'])
  const comparisonOperators = new Set(['equals', 'does_not_equal', 'greater_than', 'less_than'])
  const dateOperators = new Set(['equals', 'on_or_before', 'on_or_after'])

  switch (propertyType) {
    case 'title':
    case 'rich_text':
    case 'email':
    case 'url':
    case 'phone_number':
      return textOperators.has(operator)
    case 'number':
      return comparisonOperators.has(operator)
    case 'checkbox':
    case 'select':
    case 'status':
      return equalityOperators.has(operator)
    case 'date':
      return dateOperators.has(operator)
    case 'multi_select':
    case 'relation':
    case 'people':
      return operator === 'contains' || operator === 'does_not_contain'
    default:
      return false
  }
}

const propertyValueFilterToNotion = (input: {
  readonly queryInput: QueryRowsInput
  readonly filter: Extract<QueryRowsInput['queryContract']['filter'], { _tag: 'property_value' }>
}): Effect.Effect<DatabaseFilter, NotionGatewayError> => {
  if (input.filter.value === null) {
    return unsupportedQueryFilter({
      input: input.queryInput,
      message: `Canonical query operator ${input.filter.operator} requires a property value carrying the Notion property type`,
    })
  }

  return propertyValueFilterOperand({
    queryInput: input.queryInput,
    value: input.filter.value,
  }).pipe(
    Effect.flatMap(({ propertyType, operand }) =>
      input.filter.operator === 'is_empty' || input.filter.operator === 'is_not_empty'
        ? Effect.succeed({
            property: input.filter.propertyId,
            [propertyType]: { [input.filter.operator]: true },
          })
        : operand === null
          ? unsupportedQueryFilter({
              input: input.queryInput,
              message: `Canonical query operator ${input.filter.operator} cannot be compiled for an empty ${propertyType} value`,
            })
          : isFilterOperatorSupported({ propertyType, operator: input.filter.operator }) === false
            ? unsupportedQueryFilter({
                input: input.queryInput,
                message: `Canonical query operator ${input.filter.operator} is not supported for Notion ${propertyType} filters`,
              })
            : Effect.succeed({
                property: input.filter.propertyId,
                [propertyType]: { [input.filter.operator]: operand },
              }),
    ),
  )
}

const canonicalFilterToNotion = (
  input: QueryRowsInput,
): Effect.Effect<DatabaseFilter | undefined, NotionGatewayError> => {
  const filter = input.queryContract.filter
  if (filter === null || filter._tag === 'none') {
    return Effect.succeed(undefined)
  }
  if (filter._tag === 'compound_hash') {
    return unsupportedQueryFilter({
      input,
      message: 'Hashed compound query filters cannot be reconstructed into Notion filter payloads',
    })
  }
  return propertyValueFilterToNotion({ queryInput: input, filter })
}

const highWatermarkFilterToNotion = (input: QueryRowsInput): DatabaseFilter | undefined =>
  input.queryContract.highWatermark === null
    ? undefined
    : {
        timestamp: 'last_edited_time',
        last_edited_time: { on_or_after: encodeDateTimeUtc(input.queryContract.highWatermark) },
      }

const queryFilterToNotion = (
  input: QueryRowsInput,
): Effect.Effect<DatabaseFilter | undefined, NotionGatewayError> =>
  canonicalFilterToNotion(input).pipe(
    Effect.map((filter) => {
      const highWatermarkFilter = highWatermarkFilterToNotion(input)
      if (filter === undefined) return highWatermarkFilter
      if (highWatermarkFilter === undefined) return filter
      return { and: [filter, highWatermarkFilter] }
    }),
  )

const validateBasePropertiesHash = (input: {
  readonly operation: GatewayOperation
  readonly page: NotionGatewayPage
  readonly pageId: PageId
  readonly basePropertiesHash: Hash
}) => {
  const currentHash = canonicalHash(input.page.properties)
  const decision = guardStaleSurfaceBase({
    baseHash: input.basePropertiesHash,
    currentHash,
  })

  return decision._tag === 'allowed'
    ? Effect.void
    : Effect.fail(
        gatewayGuardError({
          operation: input.operation,
          guard: decision.guard,
          pageId: input.pageId,
          message: decision.message,
        }),
      )
}

const paginatedResultNextCursor = (
  result: PaginatedResult<NotionGatewayPage>,
): QueryCursor | null =>
  Option.match(result.nextCursor, {
    onNone: () => null,
    onSome: (cursor) => QueryCursor.make(cursor),
  })

const queryRowsPageFromRemote = (input: {
  readonly queryInput: QueryRowsInput
  readonly apiContract: NotionApiContractType
  readonly result: PaginatedResult<NotionGatewayPage>
}): typeof QueryRowsPage.Type =>
  QueryRowsPage.make({
    _tag: 'QueryRowsPage',
    apiVersion: input.apiContract.apiVersion,
    requestId: unavailableRequestId,
    queryContractHash: queryContractHash({
      input: input.queryInput,
      apiVersion: input.apiContract.apiVersion,
    }),
    rows: input.result.results.map((page) => ({
      _tag: 'QueriedRow',
      pageId: rowSnapshotFromRemote(page).pageId,
      propertiesHash: rowSnapshotFromRemote(page).propertiesHash,
      lastEditedTime: rowSnapshotFromRemote(page).lastEditedTime,
      inTrash: rowSnapshotFromRemote(page).inTrash,
    })),
    nextCursor: paginatedResultNextCursor(input.result),
    hasMore: input.result.hasMore,
    cappedAtLimit: false,
  })

const propertyValueFromRemoteItem = (item: NotionPagePropertyItem): unknown => {
  const value = item[item.type]
  return value === undefined ? item : value
}

const pagePropertyItemsPageFromRemote = (input: {
  readonly propertyInput: {
    readonly pageId: PageId
    readonly propertyId: PropertyId
  }
  readonly apiContract: NotionApiContractType
  readonly result: NotionGatewayPagePropertyResult
}) =>
  PagePropertyItemPage.make({
    _tag: 'PagePropertyItemPage',
    apiVersion: input.apiContract.apiVersion,
    requestId: unavailableRequestId,
    pageId: input.propertyInput.pageId,
    propertyId: input.propertyInput.propertyId,
    items: input.result.results.map((item) =>
      PagePropertyItem.make({
        _tag: 'PagePropertyItem',
        pageId: input.propertyInput.pageId,
        propertyId: input.propertyInput.propertyId,
        itemHash: canonicalHash(item),
        valueHash: canonicalHash(propertyValueFromRemoteItem(item)),
      }),
    ),
    listMetadataHash:
      input.result.propertyItem === undefined
        ? undefined
        : canonicalHash(input.result.propertyItem),
    nextCursor: Option.match(input.result.nextCursor, {
      onNone: () => null,
      onSome: (cursor) => QueryCursor.make(cursor),
    }),
    hasMore: input.result.hasMore,
  })

/**
 * Adapt the upstream `notion-effect-client` namespaced API to the gateway's `NotionGatewayClient` shape.
 *
 * Takes a single `provideClientEnv` runner that injects `NotionConfig` + `HttpClient` and returns the
 * resulting effect with those services discharged, so callers can supply whichever transport (live HTTP,
 * fake, fixture-recorder) they want without leaking it into the gateway type.
 */
export const makeNotionEffectClientGatewayClient = (
  provideClientEnv: <A, E>(
    effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E>,
): NotionGatewayClient => ({
  retrieveDataSource: ({ dataSourceId }) =>
    provideClientEnv(NotionDataSources.retrieve({ dataSourceId })),
  queryDataSource: ({ dataSourceId, pageSize, startCursor, filter, sorts }) =>
    provideClientEnv(
      NotionDatabases.query({
        dataSourceId,
        pageSize,
        ...(startCursor === undefined ? {} : { startCursor }),
        ...(filter === undefined ? {} : { filter }),
        ...(sorts === undefined ? {} : { sorts }),
      }),
    ),
  retrievePage: ({ pageId }) => provideClientEnv(NotionPages.retrieve({ pageId })),
  retrievePageProperty: ({ pageId, propertyId, pageSize, startCursor }) =>
    provideClientEnv(
      NotionPages.retrieveProperty({
        pageId,
        propertyId,
        pageSize,
        ...(startCursor === undefined ? {} : { startCursor }),
      }),
    ),
  retrieveDatabase: ({ databaseId }) => provideClientEnv(NotionDatabases.retrieve({ databaseId })),
  updatePage: ({ pageId, properties, inTrash }) =>
    provideClientEnv(
      NotionPages.update({
        pageId,
        ...(properties === undefined ? {} : { properties }),
        ...(inTrash === undefined ? {} : { in_trash: inTrash }),
      }),
    ),
  updateDatabase: ({ databaseId, title, description }) =>
    provideClientEnv(
      NotionDatabases.update({
        databaseId,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      }),
    ),
  updateDataSource: ({ dataSourceId, properties, title, description }) =>
    provideClientEnv(
      NotionDataSources.update({
        dataSourceId,
        ...(properties === undefined ? {} : { properties }),
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
      }),
    ),
})

/**
 * Build a live `NotionDataSourceGateway` from a `NotionGatewayClient`.
 *
 * Wraps every operation in capability/preflight guards and translates the client's `unknown`
 * errors into typed `NotionGatewayError`s with the appropriate guard (PermissionAmbiguous,
 * StaleSurfaceBase, ReadAfterWriteMismatch, etc.).
 */
export const makeNotionDataSourceGatewayFromClient = ({
  client,
  options = {},
}: {
  readonly client: NotionGatewayClient
  readonly options?: NotionDataSourceGatewayLiveOptions
}): NotionDataSourceGatewayShape => {
  const apiContract = makeNotionApiContract({
    clientVersion: options.clientVersion ?? 'notion-effect-client:0.1.0',
    supportedCapabilities: supportedNotionEffectClientCapabilities,
  })

  return makeNotionDataSourceGateway({
    configuredApiVersion: options.configuredApiVersion ?? supportedNotionApiVersion,
    apiContract,
    preflightCapabilities: (input) =>
      client.retrieveDataSource({ dataSourceId: input.dataSourceId }).pipe(
        Effect.map(() => makeCapabilityPreflightResult({ input, apiContract })),
        Effect.mapError(
          mapClientError({
            operation: 'preflightCapabilities',
            dataSourceId: input.dataSourceId,
          }),
        ),
      ),
    retrieveDataSource: (id) =>
      client
        .retrieveDataSource({ dataSourceId: id })
        .pipe(
          Effect.map(dataSourceSnapshotFromRemote),
          Effect.mapError(mapClientError({ operation: 'retrieveDataSource', dataSourceId: id })),
        ),
    queryRows: (input) =>
      Stream.unwrap(
        queryFilterToNotion(input).pipe(
          Effect.zipWith(querySortsToNotion(input), (filter, sorts) => ({ filter, sorts })),
          Effect.map(({ filter, sorts }) =>
            Stream.unfoldChunkEffect(Option.some(input.startCursor), (cursor) =>
              Option.match(cursor, {
                onNone: () => Effect.succeed(Option.none()),
                onSome: (startCursor) =>
                  client
                    .queryDataSource({
                      dataSourceId: input.dataSourceId,
                      pageSize: input.queryContract.pageSize,
                      startCursor: startCursor ?? undefined,
                      filter,
                      sorts,
                    })
                    .pipe(
                      Effect.map((result) =>
                        Option.some([
                          Chunk.of(
                            queryRowsPageFromRemote({ queryInput: input, apiContract, result }),
                          ),
                          result.hasMore === false || Option.isNone(result.nextCursor) === true
                            ? Option.none<QueryCursor | null>()
                            : Option.some(paginatedResultNextCursor(result)),
                        ] as const),
                      ),
                      Effect.mapError(
                        mapClientError({
                          operation: 'queryRows',
                          dataSourceId: input.dataSourceId,
                        }),
                      ),
                    ),
              }),
            ),
          ),
        ),
      ),
    retrievePage: (id) =>
      client
        .retrievePage({ pageId: id })
        .pipe(
          Effect.map(pageSnapshotFromRemote),
          Effect.mapError(mapClientError({ operation: 'retrievePage', pageId: id })),
        ),
    retrievePageProperty: (input) =>
      Stream.unfoldChunkEffect(Option.some(input.startCursor), (cursor) =>
        Option.match(cursor, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (startCursor) =>
            client
              .retrievePageProperty({
                pageId: input.pageId,
                propertyId: input.propertyId,
                pageSize: 100,
                startCursor: startCursor ?? undefined,
              })
              .pipe(
                Effect.map((result) =>
                  Option.some([
                    Chunk.of(
                      pagePropertyItemsPageFromRemote({
                        propertyInput: input,
                        apiContract,
                        result,
                      }),
                    ),
                    result.hasMore === false || Option.isNone(result.nextCursor) === true
                      ? Option.none<QueryCursor | null>()
                      : Option.some(
                          Option.match(result.nextCursor, {
                            onNone: () => null,
                            onSome: (nextCursor) => QueryCursor.make(nextCursor),
                          }),
                        ),
                  ] as const),
                ),
                Effect.mapError(
                  mapClientError({ operation: 'retrievePageProperty', pageId: input.pageId }),
                ),
              ),
        }),
      ),
    patchPageProperties: (command: PatchPagePropertiesCommand) =>
      client.retrievePage({ pageId: command.pageId }).pipe(
        Effect.mapError(
          mapClientError({ operation: 'patchPageProperties', pageId: command.pageId }),
        ),
        Effect.tap((page) =>
          validateBasePropertiesHash({
            operation: 'patchPageProperties',
            page,
            pageId: command.pageId,
            basePropertiesHash: command.basePropertiesHash,
          }),
        ),
        Effect.zipRight(pagePropertyPatchToNotion(command.propertyPatch)),
        Effect.flatMap((properties) =>
          client.updatePage({ pageId: command.pageId, properties }).pipe(
            Effect.map(() => unavailableRequestId),
            Effect.mapError(
              mapClientError({ operation: 'patchPageProperties', pageId: command.pageId }),
            ),
          ),
        ),
      ),
    patchDataSourceSchema: (command: PatchDataSourceSchemaCommand) =>
      client.retrieveDataSource({ dataSourceId: command.dataSourceId }).pipe(
        Effect.mapError(
          mapClientError({
            operation: 'patchDataSourceSchema',
            dataSourceId: command.dataSourceId,
          }),
        ),
        Effect.tap((dataSource) => {
          const currentHash = canonicalHash(dataSource.properties)
          const decision = guardStaleSurfaceBase({
            baseHash: command.baseSchemaHash,
            currentHash,
          })
          return decision._tag === 'allowed'
            ? Effect.void
            : Effect.fail(
                gatewayGuardError({
                  operation: 'patchDataSourceSchema',
                  dataSourceId: command.dataSourceId,
                  guard: decision.guard,
                  message: decision.message,
                }),
              )
        }),
        Effect.zipRight(dataSourceOperationsToNotion(command.operations)),
        Effect.flatMap((properties) =>
          client.updateDataSource({ dataSourceId: command.dataSourceId, properties }).pipe(
            Effect.as(unavailableRequestId),
            Effect.mapError(
              mapClientError({
                operation: 'patchDataSourceSchema',
                dataSourceId: command.dataSourceId,
              }),
            ),
          ),
        ),
      ),
    patchDataSourceMetadata: (command: PatchDataSourceMetadataCommand) =>
      client.retrieveDataSource({ dataSourceId: command.dataSourceId }).pipe(
        Effect.mapError(
          mapClientError({
            operation: 'patchDataSourceMetadata',
            dataSourceId: command.dataSourceId,
          }),
        ),
        Effect.tap((dataSource) => {
          const currentHash = dataSourceMetadataHash(
            canonicalDataSourceMetadataFromRemote(dataSource),
          )
          const decision = guardStaleSurfaceBase({
            baseHash: command.baseMetadataHash,
            currentHash,
          })
          return decision._tag === 'allowed'
            ? Effect.void
            : Effect.fail(
                gatewayGuardError({
                  operation: 'patchDataSourceMetadata',
                  dataSourceId: command.dataSourceId,
                  guard: decision.guard,
                  message: decision.message,
                }),
              )
        }),
        Effect.flatMap(() =>
          client.retrieveDataSource({ dataSourceId: command.dataSourceId }).pipe(
            Effect.flatMap((dataSource) =>
              dataSource.parent?.database_id === undefined
                ? Effect.fail(
                    unsupportedOperation({
                      operation: 'patchDataSourceMetadata',
                      capability: 'data_source_metadata_update',
                      dataSourceId: command.dataSourceId,
                      message:
                        'Data-source metadata description writes require an owning database parent',
                    }),
                  )
                : client.updateDatabase({
                    databaseId: dataSource.parent.database_id,
                    ...(command.metadataPatch.titlePlainText === undefined
                      ? {}
                      : { title: richTextWrite(command.metadataPatch.titlePlainText) }),
                    ...(command.metadataPatch.descriptionPlainText === undefined
                      ? {}
                      : { description: richTextWrite(command.metadataPatch.descriptionPlainText) }),
                  }),
            ),
            Effect.as(unavailableRequestId),
            Effect.mapError(
              mapClientError({
                operation: 'patchDataSourceMetadata',
                dataSourceId: command.dataSourceId,
              }),
            ),
          ),
        ),
      ),
    trashPage: (command: TrashPageCommand) =>
      client.retrievePage({ pageId: command.pageId }).pipe(
        Effect.mapError(mapClientError({ operation: 'trashPage', pageId: command.pageId })),
        Effect.tap((page) =>
          validateBasePropertiesHash({
            operation: 'trashPage',
            page,
            pageId: command.pageId,
            basePropertiesHash: command.basePropertiesHash,
          }),
        ),
        Effect.flatMap(() =>
          client
            .updatePage({ pageId: command.pageId, inTrash: true })
            .pipe(
              Effect.as(unavailableRequestId),
              Effect.mapError(mapClientError({ operation: 'trashPage', pageId: command.pageId })),
            ),
        ),
      ),
    restorePage: (command: RestorePageCommand) =>
      client.retrievePage({ pageId: command.pageId }).pipe(
        Effect.mapError(mapClientError({ operation: 'restorePage', pageId: command.pageId })),
        Effect.tap((page) =>
          validateBasePropertiesHash({
            operation: 'restorePage',
            page,
            pageId: command.pageId,
            basePropertiesHash: command.basePropertiesHash,
          }),
        ),
        Effect.flatMap(() =>
          client
            .updatePage({ pageId: command.pageId, inTrash: false })
            .pipe(
              Effect.as(unavailableRequestId),
              Effect.mapError(mapClientError({ operation: 'restorePage', pageId: command.pageId })),
            ),
        ),
      ),
  })
}

/** The gateway capabilities the live notion-effect-client adapter does NOT yet implement — used by tests to assert preflight rejection. */
export const unsupportedNotionEffectClientGatewayCapabilities = allGatewayCapabilities.filter(
  (capability) => supportedNotionEffectClientCapabilities.includes(capability) === false,
)

/** Preflight check that returns an `allowed` decision or a `CapabilityPreflightFailed` block when any required capability is missing from the live adapter. */
export const guardRealAdapterCapabilities = (input: {
  readonly requiredCapabilities: ReadonlyArray<CapabilityName>
}) => {
  const supportedSet = new Set(supportedNotionEffectClientCapabilities)
  const missingCapability = input.requiredCapabilities.find(
    (capability) => supportedSet.has(capability) === false,
  )

  return missingCapability === undefined
    ? { _tag: 'allowed' as const }
    : blocked({
        guard: 'CapabilityPreflightFailed',
        message: `Missing Notion adapter capability: ${missingCapability}`,
      })
}

/** Live Effect `Layer` providing `NotionDataSourceGateway` from the upstream `notion-effect-client`; requires `NotionConfig` and `HttpClient`. */
export const NotionDataSourceGatewayLive: Layer.Layer<
  NotionDataSourceGateway,
  never,
  NotionConfig | HttpClient.HttpClient
> = Layer.effect(
  NotionDataSourceGateway,
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const httpClient = yield* HttpClient.HttpClient
    const provideClientEnv = <A, E>(
      effect: Effect.Effect<A, E, NotionConfig | HttpClient.HttpClient>,
    ) =>
      effect.pipe(
        Effect.provideService(NotionConfig, config),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      )

    return makeNotionDataSourceGatewayFromClient({
      client: makeNotionEffectClientGatewayClient(provideClientEnv),
    })
  }),
)
