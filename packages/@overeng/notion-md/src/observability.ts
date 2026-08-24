/**
 * Runtime observability surface for notion-md. Every `notion_md.*` span/attribute is DERIVED from
 * the registered seam contract (`./notion-md.contract.ts`, namespace `notion_md`) — the single
 * SSOT for BOTH the Weaver registry projection AND these runtime encoders (SC-R13/R14). This file
 * holds only the runtime wrappers (attribute shaping, root-span selection) plus the DYNAMIC-NAME
 * bridges that have no stable single-signal registry projection (SC-DQ5).
 */
import { Effect, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  OtelSpan,
  type OtelAttrEncodeError,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import {
  BatchWatchOperation,
  CatOperation,
  CommentBoundaryOperation,
  DestructiveBodyOperation,
  EditOperation,
  EstablishSidecarOperation,
  GatewayArchivePageOperation,
  GatewayCreatePageOperation,
  GatewayListChildPagesOperation,
  GatewayMovePageOperation,
  GatewayPullPageOperation,
  GatewayRetrieveDataSourceOperation,
  GatewayUpdateMarkdownOperation,
  GatewayUpdatePageMetadataOperation,
  GatewayUpdatePagePropertiesOperation,
  MediaBoundaryOperation,
  NotionMdBatch,
  NotionMdBatchRecursive,
  NotionMdBatchTargetCount,
  NotionMdCommand,
  NotionMdPathBasename,
  NotionMdStateOperation,
  ObjectGcOperation,
  PlanPathOperation,
  PullPageOperation,
  PushPageOperation,
  PutOperation,
  ReadNmdStateOperation,
  ReadObjectStateOperation,
  ReconcileFileOperation,
  StatusFileOperation,
  StatusPageOperation,
  StatusPathOperation,
  SyncPageOperation,
  SyncPathOperation,
  SyncTreeOperation,
  TrackPageOperation,
  WatchOperation,
  WatchSyncPassOperation,
  WebhookDecodeOperation,
  WebhookTriggerOperation,
  WriteObjectStateOperation,
} from './notion-md.contract.ts'

// ---- DERIVED runtime span surfaces (re-pointed at the seam contract's `.operation` products) ----
/** Span for `status` over a filesystem path (file or recursive tree). */
export const StatusPathSpan = StatusPathOperation.operation
/** Span for planning a tree sync over a path (`fromRemote` picks the plan direction). */
export const PlanPathSpan = PlanPathOperation.operation
/** Span for `sync` over a filesystem path (recursive tree or single file). */
export const SyncPathSpan = SyncPathOperation.operation
/** Span for syncing an entire tree under a root. */
export const SyncTreeSpan = SyncTreeOperation.operation
/** Span for reading the `.nmd` sidecar state file. */
export const ReadNmdStateSpan = ReadNmdStateOperation.operation
/** Span for writing a content object into the state store (labelled by object role). */
export const WriteObjectStateSpan = WriteObjectStateOperation.operation
/** Span for reading a content object from the state store (labelled by object role). */
export const ReadObjectStateSpan = ReadObjectStateOperation.operation
/** Span for pulling a single page from Notion into a local file. */
export const PullPageSpan = PullPageOperation.operation
/** Span for establishing the `.nmd` sidecar baseline for a page on first contact. */
export const EstablishSidecarSpan = EstablishSidecarOperation.operation
/** Span for computing status of a single page against its baseline. */
export const StatusPageSpan = StatusPageOperation.operation
/** Span for pushing a single local page to Notion. */
export const PushPageSpan = PushPageOperation.operation
/** Span for the full reconcile (status + pull/push) of a single page. */
export const SyncPageSpan = SyncPageOperation.operation
/** Gateway-level span for the Notion API call that pulls a page's content. */
export const GatewayPullPageSpan = GatewayPullPageOperation.operation
/** Gateway-level span for applying a markdown body update to a page. */
export const GatewayUpdateMarkdownSpan = GatewayUpdateMarkdownOperation.operation
/** Gateway-level span for updating a page's database properties. */
export const GatewayUpdatePagePropertiesSpan = GatewayUpdatePagePropertiesOperation.operation
/** Gateway-level span for retrieving a data source (database) schema. */
export const GatewayRetrieveDataSourceSpan = GatewayRetrieveDataSourceOperation.operation
/** Gateway-level span for updating page metadata (title/icon/cover/trash/lock). */
export const GatewayUpdatePageMetadataSpan = GatewayUpdatePageMetadataOperation.operation
/** Gateway-level span for listing a page's direct child pages. */
export const GatewayListChildPagesSpan = GatewayListChildPagesOperation.operation
/** Gateway-level span for creating a new child page under a parent. */
export const GatewayCreatePageSpan = GatewayCreatePageOperation.operation
/** Gateway-level span for moving a page to a new parent. */
export const GatewayMovePageSpan = GatewayMovePageOperation.operation
/** Gateway-level span for archiving (trashing) a page. */
export const GatewayArchivePageSpan = GatewayArchivePageOperation.operation
/** Root span for `notion-md cat` — read-only editor projection of a Notion page. */
export const CatSpan = CatOperation.operation
/** Root span for `notion-md put` — guarded title+body write to a Notion page. */
export const PutSpan = PutOperation.operation
/** Root span for `notion-md edit` — ephemeral file-engine editor session. */
export const EditSpan = EditOperation.operation
/** Operation span emitted when the files/media write boundary classifies a write. */
export const MediaBoundarySpan = MediaBoundaryOperation.operation
/** Operation span emitted when the comment write boundary classifies a write. */
export const CommentBoundarySpan = CommentBoundaryOperation.operation
/** Operation span emitted when a destructive body write gate blocks or allows. */
export const DestructiveBodySpan = DestructiveBodyOperation.operation
/** Operation span emitted when object GC runs (plan-only or live prune). */
export const ObjectGcSpan = ObjectGcOperation.operation
/** Operation span emitted when a webhook signal is mapped to watch triggers. */
export const WebhookTriggerSpan = WebhookTriggerOperation.operation
/** Span for a batch watch over multiple paths. */
export const BatchWatchSpan = BatchWatchOperation.operation
/** Span for a watch session over a single path. */
export const WatchSpan = WatchOperation.operation
/** Root span for one watch-driven sync pass. */
export const WatchSyncPassSpan = WatchSyncPassOperation.operation
/** Span for tracking/establishing a page's local file from a remote pull (carries `notion_md.track.source`). */
export const TrackPageSpan = TrackPageOperation.operation
/** Label-only span for status of a single `.nmd` file (labelled by basename). */
export const StatusFileSpan = StatusFileOperation.operation
/** Label-only span for reconcile of a single `.nmd` file (labelled by basename). */
export const ReconcileFileSpan = ReconcileFileOperation.operation
/** Label-only span for decoding a raw Notion webhook payload (fixed label `decode`). */
export const WebhookDecodeSpan = WebhookDecodeOperation.operation

// ---- DERIVED annotate-only encoders (re-exported unchanged from the seam contract) ----
export {
  editResultAttrs,
  objectGcResultAttrs,
  objectHashAttrs,
  pushDecisionAttrs,
  pushDecisionMarkdownCommandAttrs,
  pushMarkdownCommandAttrs,
  pushResultAttrs,
  putResultAttrs,
  statusAttrs,
  syncResultAttrs,
  watchSyncErrorAttrs,
  watchSyncResultAttrs,
} from './notion-md.contract.ts'

// ---- runtime wrappers ----

/** Wrap an effect in an OTEL operation span; an attribute-encode failure is a defect, not a recoverable error. */
export const withOperation =
  <S extends Schema.Codec<any>>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      operation.with(attributes),
      Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)),
    )

/** Like {@link withOperation} but forces a ROOT span (for top-level `cat` / `put` / `edit` / watch-pass). */
export const withRootOperation =
  <S extends Schema.Codec<any>>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      operation.withRoot(attributes),
      Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)),
    )

/** Annotate the current span with typed attributes; an attribute-encode failure is a defect, not a recoverable error. */
export const annotateAttrs = <S extends Schema.Codec<any>>({
  attributes,
  value,
}: {
  attributes: OtelAttrs<S>
  value: Schema.Schema.Type<S>
}): Effect.Effect<void> =>
  OtelSpan.annotate({ attributes, value }).pipe(
    Effect.catchTag('OtelAttrEncodeError', (error: OtelAttrEncodeError) => Effect.die(error)),
  )

// ---- DYNAMIC-NAME BRIDGES (SC-DQ5) -----------------------------------------------------------
// These spans have runtime-varying names, so they have NO stable single-signal registry
// projection and stay LEGACY inline `OtelOperation.define` here (mirroring genie's `cli.mode`).
// Their attribute keys are all in the `notion_md` catalog (open-refs on migrated static signals,
// or `docOnlyAttributes` for the `batch.*` keys exclusive to `batchRunSpan`).

const stateFileAttrs = OtelAttrs.defineSync(
  Schema.Struct({ operation: NotionMdStateOperation, basename: NotionMdPathBasename }),
)

/** Build a state-file span whose name is parameterized by the state operation performed. */
export const stateFileSpan = (operation: string) =>
  OtelOperation.define({
    name: `notion-md.state.${operation}`,
    attributes: stateFileAttrs,
    label: ({ basename }) => basename,
  })

const batchRunSpanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    command: NotionMdCommand,
    batch: NotionMdBatch,
    targetCount: NotionMdBatchTargetCount,
    recursive: NotionMdBatchRecursive,
  }),
)

/** Build a batch-run span whose name is parameterized by the batch operation performed. */
export const batchRunSpan = (operation: string) =>
  OtelOperation.define({
    name: `notion-md.${operation}-many`,
    attributes: batchRunSpanAttrs,
    label: ({ targetCount }) => `${targetCount} target(s)`,
  })

const cliCommandSpanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: OtelAttr.drop(Schema.NonEmptyString),
    command: NotionMdCommand,
  }),
)

/** Build the root `notion-md.cli.<command>` span; the name varies by CLI command. */
export const cliCommandSpan = (command: string) =>
  OtelOperation.define({
    name: `notion-md.cli.${command}`,
    root: true,
    attributes: cliCommandSpanAttrs,
    label: ({ label }) => label,
  })
