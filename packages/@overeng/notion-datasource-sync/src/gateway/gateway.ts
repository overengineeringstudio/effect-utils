import { Effect, Layer, Schema, Stream } from 'effect'

import type {
  RetrievePagePropertyInput,
  CreatePageCommand,
  PatchDatabaseMetadataCommand,
  PatchDataSourceMetadataCommand,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  QueryRowsInput,
  RestorePageCommand,
  TrashPageCommand,
} from '../core/commands.ts'
import {
  CapabilityPreflightResult,
  ClientVersion,
  NotionApiContract,
  NotionRequestId,
  SupportedNotionApiVersion,
  type CapabilityName,
  type CapabilityPreflightInput,
  type DataSourceId,
  type NotionApiContract as NotionApiContractType,
  type PageId,
  type PropertyId,
  type SupportedNotionApiVersion as SupportedNotionApiVersionType,
} from '../core/domain.ts'
import { NotionGatewayError } from '../core/errors.ts'
import { guardApiVersion, type GuardName } from '../core/guards.ts'
import { NotionDataSourceGateway, type NotionDataSourceGatewayShape } from '../core/ports.ts'
import {
  commandKind,
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
} from '../observability/observability.ts'

/** The Notion API version string that this gateway implementation targets. */
export const supportedNotionApiVersion: SupportedNotionApiVersionType =
  SupportedNotionApiVersion.pipe(Schema.decodeSync)('2026-03-11')

/** The full set of capabilities that a complete gateway implementation should support. */
export const allGatewayCapabilities = [
  'data_source_retrieve',
  'data_source_query',
  'data_source_metadata_update',
  'page_retrieve',
  'page_property_paginate',
  'page_property_update',
  'page_create',
  'schema_update',
  'page_trash',
  'page_restore',
] as const satisfies ReadonlyArray<CapabilityName>

/** Subset of capabilities required for read-only access (retrieve + query, no writes). */
export const readOnlyGatewayCapabilities = [
  'data_source_retrieve',
  'data_source_query',
  'page_retrieve',
] as const satisfies ReadonlyArray<CapabilityName>

/** All operation names that can appear in a `NotionGatewayError`. */
export type GatewayOperation =
  | 'preflightCapabilities'
  | 'retrieveDataSource'
  | 'queryRows'
  | 'retrievePage'
  | 'retrievePageProperty'
  | 'patchPageProperties'
  | 'createPage'
  | 'patchDataSourceSchema'
  | 'patchDataSourceMetadata'
  | 'patchDatabaseMetadata'
  | 'trashPage'
  | 'restorePage'

/** Input shape for constructing a `NotionGatewayError` — all fields except `operation` are optional context. */
export type GatewayErrorInput = {
  readonly operation: GatewayOperation
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
  readonly requestId?: string
  readonly guard?: GuardName
  readonly message: string
  readonly cause?: unknown
}

/** Construct a `NotionGatewayError` from a `GatewayErrorInput`, omitting undefined optional fields. */
export const makeGatewayError = (input: GatewayErrorInput): NotionGatewayError =>
  new NotionGatewayError({
    operation: input.operation,
    ...(input.dataSourceId === undefined ? {} : { dataSourceId: input.dataSourceId }),
    ...(input.pageId === undefined ? {} : { pageId: input.pageId }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.guard === undefined ? {} : { guard: input.guard }),
    message: input.message,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  })

/** Build a `NotionApiContract` stamped with `supportedNotionApiVersion` and the given capabilities (defaults to `allGatewayCapabilities`). */
export const makeNotionApiContract = (input?: {
  readonly clientVersion?: string
  readonly supportedCapabilities?: ReadonlyArray<CapabilityName>
}): NotionApiContractType =>
  NotionApiContract.make({
    _tag: 'NotionApiContract',
    apiVersion: supportedNotionApiVersion,
    clientVersion: ClientVersion.make(input?.clientVersion ?? '0.1.0'),
    supportedCapabilities: [...(input?.supportedCapabilities ?? allGatewayCapabilities)],
  })

/** Fail with a guard error if `configuredApiVersion` is not the supported Notion API version. */
export const ensureSupportedGatewayApiVersion = ({
  operation,
  configuredApiVersion,
  dataSourceId,
  pageId,
}: {
  readonly operation: GatewayOperation
  readonly configuredApiVersion: string
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
}): Effect.Effect<void, NotionGatewayError> => {
  const decision = guardApiVersion(configuredApiVersion)

  return decision._tag === 'allowed'
    ? Effect.void
    : Effect.fail(
        makeGatewayError({
          operation,
          ...(dataSourceId === undefined ? {} : { dataSourceId }),
          ...(pageId === undefined ? {} : { pageId }),
          guard: decision.guard,
          message: decision.message,
        }),
      )
}

/** Compute a `CapabilityPreflightResult` by intersecting the requested capabilities against the contract's supported set. */
export const makeCapabilityPreflightResult = ({
  input,
  apiContract,
}: {
  readonly input: CapabilityPreflightInput
  readonly apiContract: NotionApiContractType
}) => {
  const supportedSet = new Set(apiContract.supportedCapabilities)
  const supportedCapabilities = input.requiredCapabilities.filter((capability) =>
    supportedSet.has(capability),
  )
  const missingCapabilities = input.requiredCapabilities.filter(
    (capability) => supportedSet.has(capability) === false,
  )

  return CapabilityPreflightResult.make({
    _tag: 'CapabilityPreflightResult',
    dataSourceId: input.dataSourceId,
    apiContract,
    supportedCapabilities,
    missingCapabilities,
  })
}

/**
 * Adapter contract passed to `makeNotionDataSourceGateway`.
 *
 * Extends the full gateway shape with an optional `configuredApiVersion`
 * (overrides the one from `apiContract`) and makes `preflightCapabilities`
 * optional so adapters can rely on the default capability-intersection logic.
 */
export type NotionDataSourceGatewayAdapter = Omit<
  NotionDataSourceGatewayShape,
  'apiContract' | 'preflightCapabilities'
> & {
  readonly configuredApiVersion?: string
  readonly apiContract: NotionApiContractType
  readonly preflightCapabilities?: NotionDataSourceGatewayShape['preflightCapabilities']
}

const gatewayRequestSpan = (input: {
  readonly operation: GatewayOperation
  readonly configuredApiVersion: string
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
  readonly propertyId?: PropertyId
  readonly commandId?: string
  readonly commandKind?: string
}) => {
  const entityId = input.pageId ?? input.dataSourceId ?? input.commandId

  return {
    attributes: spanAttributes({
      [spanAttr.spanLabel]: spanLabel(
        input.operation,
        entityId === undefined ? undefined : shortSpanId(entityId),
      ),
      [spanAttr.processRole]: 'library',
      [spanAttr.operation]: input.operation,
      [spanAttr.apiVersion]: input.configuredApiVersion,
      [spanAttr.dataSourceId]: input.dataSourceId,
      [spanAttr.pageId]: input.pageId,
      [spanAttr.propertyId]: input.propertyId,
      [spanAttr.commandId]: input.commandId,
      [spanAttr.commandKind]: input.commandKind,
    }),
  }
}

/**
 * Wrap a `NotionDataSourceGatewayAdapter` into the full `NotionDataSourceGatewayShape`.
 *
 * Adds API-version gating and OTel span instrumentation to every gateway
 * operation. Used by both the live Notion adapter and the fake.
 */
export const makeNotionDataSourceGateway = (
  adapter: NotionDataSourceGatewayAdapter,
): NotionDataSourceGatewayShape => {
  const configuredApiVersion = adapter.configuredApiVersion ?? adapter.apiContract.apiVersion

  return {
    apiContract: adapter.apiContract,
    preflightCapabilities: (input) =>
      ensureSupportedGatewayApiVersion({
        operation: 'preflightCapabilities',
        configuredApiVersion,
        dataSourceId: input.dataSourceId,
      }).pipe(
        Effect.flatMap(() =>
          adapter.preflightCapabilities === undefined
            ? Effect.succeed(
                makeCapabilityPreflightResult({ input, apiContract: adapter.apiContract }),
              )
            : adapter.preflightCapabilities(input),
        ),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'preflightCapabilities',
            configuredApiVersion,
            dataSourceId: input.dataSourceId,
          }),
        ),
      ),
    retrieveDataSource: (id) =>
      ensureSupportedGatewayApiVersion({
        operation: 'retrieveDataSource',
        configuredApiVersion,
        dataSourceId: id,
      }).pipe(
        Effect.flatMap(() => adapter.retrieveDataSource(id)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'retrieveDataSource',
            configuredApiVersion,
            dataSourceId: id,
          }),
        ),
      ),
    queryRows: (input: QueryRowsInput) =>
      Stream.fromEffect(
        ensureSupportedGatewayApiVersion({
          operation: 'queryRows',
          configuredApiVersion,
          dataSourceId: input.dataSourceId,
        }),
      ).pipe(
        Stream.flatMap(() => adapter.queryRows(input)),
        Stream.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'queryRows',
            configuredApiVersion,
            dataSourceId: input.dataSourceId,
          }),
        ),
      ),
    retrievePage: (id) =>
      ensureSupportedGatewayApiVersion({
        operation: 'retrievePage',
        configuredApiVersion,
        pageId: id,
      }).pipe(
        Effect.flatMap(() => adapter.retrievePage(id)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({ operation: 'retrievePage', configuredApiVersion, pageId: id }),
        ),
      ),
    retrievePageProperty: (input: RetrievePagePropertyInput) =>
      Stream.fromEffect(
        ensureSupportedGatewayApiVersion({
          operation: 'retrievePageProperty',
          configuredApiVersion,
          pageId: input.pageId,
        }),
      ).pipe(
        Stream.flatMap(() => adapter.retrievePageProperty(input)),
        Stream.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'retrievePageProperty',
            configuredApiVersion,
            pageId: input.pageId,
            propertyId: input.propertyId,
          }),
        ),
      ),
    patchPageProperties: (command: PatchPagePropertiesCommand) =>
      ensureSupportedGatewayApiVersion({
        operation: 'patchPageProperties',
        configuredApiVersion,
        pageId: command.pageId,
      }).pipe(
        Effect.flatMap(() => adapter.patchPageProperties(command)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'patchPageProperties',
            configuredApiVersion,
            pageId: command.pageId,
            commandId: command.commandId,
            commandKind: commandKind(command._tag),
          }),
        ),
      ),
    createPage: (command: CreatePageCommand) =>
      ensureSupportedGatewayApiVersion({
        operation: 'createPage',
        configuredApiVersion,
        dataSourceId: command.dataSourceId,
      }).pipe(
        Effect.flatMap(() => adapter.createPage(command)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'createPage',
            configuredApiVersion,
            dataSourceId: command.dataSourceId,
            commandId: command.commandId,
            commandKind: commandKind(command._tag),
          }),
        ),
      ),
    patchDataSourceSchema: (command: PatchDataSourceSchemaCommand) =>
      ensureSupportedGatewayApiVersion({
        operation: 'patchDataSourceSchema',
        configuredApiVersion,
        dataSourceId: command.dataSourceId,
      }).pipe(
        Effect.flatMap(() => adapter.patchDataSourceSchema(command)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'patchDataSourceSchema',
            configuredApiVersion,
            dataSourceId: command.dataSourceId,
            commandId: command.commandId,
            commandKind: commandKind(command._tag),
          }),
        ),
      ),
    patchDataSourceMetadata: (command: PatchDataSourceMetadataCommand) =>
      ensureSupportedGatewayApiVersion({
        operation: 'patchDataSourceMetadata',
        configuredApiVersion,
        dataSourceId: command.dataSourceId,
      }).pipe(
        Effect.flatMap(() => adapter.patchDataSourceMetadata(command)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'patchDataSourceMetadata',
            configuredApiVersion,
            dataSourceId: command.dataSourceId,
            commandId: command.commandId,
            commandKind: commandKind(command._tag),
          }),
        ),
      ),
    patchDatabaseMetadata: (command: PatchDatabaseMetadataCommand) =>
      ensureSupportedGatewayApiVersion({
        operation: 'patchDatabaseMetadata',
        configuredApiVersion,
        dataSourceId: command.dataSourceId,
      }).pipe(
        Effect.flatMap(() => adapter.patchDatabaseMetadata(command)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'patchDatabaseMetadata',
            configuredApiVersion,
            dataSourceId: command.dataSourceId,
            commandId: command.commandId,
            commandKind: commandKind(command._tag),
          }),
        ),
      ),
    trashPage: (command: TrashPageCommand) =>
      ensureSupportedGatewayApiVersion({
        operation: 'trashPage',
        configuredApiVersion,
        pageId: command.pageId,
      }).pipe(
        Effect.flatMap(() => adapter.trashPage(command)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'trashPage',
            configuredApiVersion,
            pageId: command.pageId,
            commandId: command.commandId,
            commandKind: commandKind(command._tag),
          }),
        ),
      ),
    restorePage: (command: RestorePageCommand) =>
      ensureSupportedGatewayApiVersion({
        operation: 'restorePage',
        configuredApiVersion,
        pageId: command.pageId,
      }).pipe(
        Effect.flatMap(() => adapter.restorePage(command)),
        Effect.withSpan(
          spanNames.gatewayRequest,
          gatewayRequestSpan({
            operation: 'restorePage',
            configuredApiVersion,
            pageId: command.pageId,
            commandId: command.commandId,
            commandKind: commandKind(command._tag),
          }),
        ),
      ),
  }
}

/** Lift a pre-built `NotionDataSourceGatewayShape` into an Effect Layer. */
export const makeNotionDataSourceGatewayLayer = (
  gateway: NotionDataSourceGatewayShape,
): Layer.Layer<NotionDataSourceGateway> => Layer.succeed(NotionDataSourceGateway, gateway)

/** Construct a branded `NotionRequestId` from a raw string. */
export const notionRequestId = (value: string): NotionRequestId => NotionRequestId.make(value)
