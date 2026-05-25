import { Effect, Layer, Schema, Stream } from 'effect'

import type {
  RetrievePagePropertyInput,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  QueryRowsInput,
  RestorePageCommand,
  TrashPageCommand,
} from './commands.ts'
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
} from './domain.ts'
import { NotionGatewayError } from './errors.ts'
import { guardApiVersion, type GuardName } from './guards.ts'
import {
  commandKind,
  shortSpanId,
  spanAttr,
  spanAttributes,
  spanLabel,
  spanNames,
} from './observability.ts'
import { NotionDataSourceGateway, type NotionDataSourceGatewayShape } from './ports.ts'

export const supportedNotionApiVersion: SupportedNotionApiVersionType =
  SupportedNotionApiVersion.pipe(Schema.decodeSync)('2026-03-11')

export const allGatewayCapabilities = [
  'data_source_retrieve',
  'data_source_query',
  'page_retrieve',
  'page_property_paginate',
  'page_property_update',
  'schema_update',
  'page_trash',
  'page_restore',
] as const satisfies ReadonlyArray<CapabilityName>

export const readOnlyGatewayCapabilities = [
  'data_source_retrieve',
  'data_source_query',
  'page_retrieve',
] as const satisfies ReadonlyArray<CapabilityName>

export type GatewayOperation =
  | 'preflightCapabilities'
  | 'retrieveDataSource'
  | 'queryRows'
  | 'retrievePage'
  | 'retrievePageProperty'
  | 'patchPageProperties'
  | 'patchDataSourceSchema'
  | 'trashPage'
  | 'restorePage'

export type GatewayErrorInput = {
  readonly operation: GatewayOperation
  readonly dataSourceId?: DataSourceId
  readonly pageId?: PageId
  readonly requestId?: string
  readonly guard?: GuardName
  readonly message: string
  readonly cause?: unknown
}

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

export const makeNotionDataSourceGatewayLayer = (
  gateway: NotionDataSourceGatewayShape,
): Layer.Layer<NotionDataSourceGateway> => Layer.succeed(NotionDataSourceGateway, gateway)

export const notionRequestId = (value: string): NotionRequestId => NotionRequestId.make(value)
