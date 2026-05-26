import { Context, type Effect, type Stream } from 'effect'

import type {
  BodyConflict,
  BodyIntent,
  BodyLocalChangeInput,
  BodyPushCommand,
  BodyPushResult,
  BodyRepairInput,
  ObserveBodyInput,
  RetrievePagePropertyInput,
  PagePropertyItemPage,
  PatchDataSourceSchemaCommand,
  PatchPagePropertiesCommand,
  QueryRowsInput,
  QueryRowsPage,
  RestorePageCommand,
  TrashPageCommand,
} from './commands.ts'
import type {
  AbsolutePath,
  CapabilityPreflightInput,
  CapabilityPreflightResult,
  DataSourceId,
  DataSourceSnapshot,
  LocalArtifactObservation,
  MaterializePlan,
  MaterializeResult,
  NotionApiContract,
  NotionRequestId,
  PageId,
  PageSnapshot,
  PathClaimPlan,
  PathClaimResult,
  BodyPointer,
} from './domain.ts'
import type {
  BodySyncError,
  LocalStorageError,
  LocalStoreError,
  NotionGatewayError,
} from './errors.ts'
import type { SyncEvent } from './events.ts'

export type NotionDataSourceGatewayShape = {
  readonly apiContract: NotionApiContract
  readonly preflightCapabilities: (
    input: CapabilityPreflightInput,
  ) => Effect.Effect<CapabilityPreflightResult, NotionGatewayError>
  readonly retrieveDataSource: (
    id: DataSourceId,
  ) => Effect.Effect<DataSourceSnapshot, NotionGatewayError>
  readonly queryRows: (input: QueryRowsInput) => Stream.Stream<QueryRowsPage, NotionGatewayError>
  readonly retrievePage: (id: PageId) => Effect.Effect<PageSnapshot, NotionGatewayError>
  readonly retrievePageProperty: (
    input: RetrievePagePropertyInput,
  ) => Stream.Stream<PagePropertyItemPage, NotionGatewayError>
  readonly patchPageProperties: (
    command: PatchPagePropertiesCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
  readonly patchDataSourceSchema: (
    command: PatchDataSourceSchemaCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
  readonly trashPage: (
    command: TrashPageCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
  readonly restorePage: (
    command: RestorePageCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
}

export class NotionDataSourceGateway extends Context.Tag(
  '@overeng/notion-datasource-sync/NotionDataSourceGateway',
)<NotionDataSourceGateway, NotionDataSourceGatewayShape>() {}

export type PageBodySyncPortShape = {
  readonly observe: (input: ObserveBodyInput) => Effect.Effect<BodyPointer, BodySyncError>
  readonly planLocalChange: (
    input: BodyLocalChangeInput,
  ) => Effect.Effect<BodyIntent | BodyConflict, BodySyncError>
  readonly push: (command: BodyPushCommand) => Effect.Effect<BodyPushResult, BodySyncError>
  readonly repair: (
    input: BodyRepairInput,
  ) => Effect.Effect<BodyPointer | BodyConflict, BodySyncError>
}

export class PageBodySyncPort extends Context.Tag(
  '@overeng/notion-datasource-sync/PageBodySyncPort',
)<PageBodySyncPort, PageBodySyncPortShape>() {}

export type LocalWorkspacePortShape = {
  readonly scan: (root: AbsolutePath) => Stream.Stream<LocalArtifactObservation, LocalStorageError>
  readonly claimPath: (claim: PathClaimPlan) => Effect.Effect<PathClaimResult, LocalStorageError>
  readonly materialize: (
    plan: MaterializePlan,
  ) => Effect.Effect<MaterializeResult, LocalStorageError>
}

export class LocalWorkspacePort extends Context.Tag(
  '@overeng/notion-datasource-sync/LocalWorkspacePort',
)<LocalWorkspacePort, LocalWorkspacePortShape>() {}

export type SyncEventStoreShape = {
  readonly append: (event: SyncEvent) => Effect.Effect<void, LocalStoreError>
  readonly replay: Stream.Stream<SyncEvent, LocalStoreError>
}

export class SyncEventStore extends Context.Tag('@overeng/notion-datasource-sync/SyncEventStore')<
  SyncEventStore,
  SyncEventStoreShape
>() {}
