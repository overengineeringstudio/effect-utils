import { Context, type Effect, type Stream } from 'effect'

import type {
  BodyConflict,
  BodyIntent,
  BodyLocalChangeInput,
  BodyPushCommand,
  BodyPushResult,
  BodyRepairInput,
  CreatePageCommand,
  CreatePageResult,
  ObserveBodyInput,
  PatchDataSourceMetadataCommand,
  PatchDatabaseMetadataCommand,
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
  DatabaseId,
  DataSourceViewSnapshot,
} from './domain.ts'
import type {
  BodySyncError,
  LocalStorageError,
  LocalStoreError,
  NotionGatewayError,
} from './errors.ts'
import type { SyncEvent } from './events.ts'

/** Contract for the Notion API gateway: all remote read and write operations go through this shape, keeping the sync core independent of the HTTP implementation. */
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
  readonly listDataSourceViews?: (input: {
    readonly databaseId: DatabaseId
    readonly dataSourceId: DataSourceId
  }) => Stream.Stream<DataSourceViewSnapshot, NotionGatewayError>
  readonly patchPageProperties: (
    command: PatchPagePropertiesCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
  readonly createPage: (
    command: CreatePageCommand,
  ) => Effect.Effect<CreatePageResult, NotionGatewayError>
  readonly patchDataSourceSchema: (
    command: PatchDataSourceSchemaCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
  readonly patchDataSourceMetadata: (
    command: PatchDataSourceMetadataCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
  readonly patchDatabaseMetadata: (
    command: PatchDatabaseMetadataCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
  readonly trashPage: (
    command: TrashPageCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
  readonly restorePage: (
    command: RestorePageCommand,
  ) => Effect.Effect<NotionRequestId, NotionGatewayError>
}

/** Effect service tag for the Notion API gateway; inject an implementation to connect the sync core to the real Notion HTTP API. */
export class NotionDataSourceGateway extends Context.Tag(
  '@overeng/notion-datasource-sync/NotionDataSourceGateway',
)<NotionDataSourceGateway, NotionDataSourceGatewayShape>() {}

/** Contract for the body-sync adapter: observe, plan local changes against, push, and repair the markdown body of a Notion page. */
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

/** Effect service tag for the page body sync adapter; implementations translate between `BodyPointer` and the actual file/Notion content representation. */
export class PageBodySyncPort extends Context.Tag(
  '@overeng/notion-datasource-sync/PageBodySyncPort',
)<PageBodySyncPort, PageBodySyncPortShape>() {}

/** Contract for local filesystem interactions: scan for artifact observations, claim paths for pages, and materialize body content as files. */
export type LocalWorkspacePortShape = {
  readonly scan: (root: AbsolutePath) => Stream.Stream<LocalArtifactObservation, LocalStorageError>
  readonly claimPath: (claim: PathClaimPlan) => Effect.Effect<PathClaimResult, LocalStorageError>
  readonly materialize: (
    plan: MaterializePlan,
  ) => Effect.Effect<MaterializeResult, LocalStorageError>
}

/** Effect service tag for the local workspace adapter; inject to connect the sync core to the real filesystem implementation. */
export class LocalWorkspacePort extends Context.Tag(
  '@overeng/notion-datasource-sync/LocalWorkspacePort',
)<LocalWorkspacePort, LocalWorkspacePortShape>() {}

/** Contract for the append-only sync event store: `append` persists new events and `replay` streams all recorded events for projection rebuilding. */
export type SyncEventStoreShape = {
  readonly append: (event: SyncEvent) => Effect.Effect<void, LocalStoreError>
  readonly replay: Stream.Stream<SyncEvent, LocalStoreError>
}

/** Effect service tag for the sync event store; the store is the authoritative source of truth for all sync state. */
export class SyncEventStore extends Context.Tag('@overeng/notion-datasource-sync/SyncEventStore')<
  SyncEventStore,
  SyncEventStoreShape
>() {}
