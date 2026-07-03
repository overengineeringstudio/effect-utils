/**
 * Property-based encoder-equivalence proof for the `notion_md.*` telemetry migration (SC-R14).
 *
 * The migration re-points notion-md's runtime spans/annotations at DERIVED encoders from the
 * registered seam contract (`./notion-md.contract.ts`). This test proves "no runtime behavior
 * lost": for every operation AND every annotate-only bundle, the DERIVED product surface
 * (`.operation.encodeSync` / `OtelAttrs.encodeSync`) produces byte-identical attribute maps to an
 * INDEPENDENT, hand-authored baseline (inline `OtelAttr.*` + `OtelOperation.define` /
 * `OtelAttrs.defineSync`, mirroring notion-md's pre-migration `observability.ts`) — over `Schema`
 * arbitraries exercising optional-present / optional-absent branches and derived span labels.
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the contract), so the comparison is real and not vacuous.
 *
 * Arbitrary constraints: string attrs use `Schema.NonEmptyTrimmedString` (a derived span label read
 * from an attribute must not be empty/whitespace → throws on both sides); numeric attrs use
 * `Schema.NonNegativeInt` (matches source; raw `Schema.Number` would generate `NaN`/`±Infinity`,
 * rejected by both encoders → noise).
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import {
  BatchWatchOperation,
  CatOperation,
  CommentBoundaryOperation,
  DestructiveBodyOperation,
  EditOperation,
  editResultAttrs,
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
  objectGcResultAttrs,
  objectHashAttrs,
  ObjectGcOperation,
  PlanPathOperation,
  PullPageOperation,
  pushDecisionAttrs,
  pushDecisionMarkdownCommandAttrs,
  pushMarkdownCommandAttrs,
  pushResultAttrs,
  PushPageOperation,
  PutOperation,
  putResultAttrs,
  ReadNmdStateOperation,
  ReadObjectStateOperation,
  ReconcileFileOperation,
  statusAttrs,
  StatusFileOperation,
  StatusPageOperation,
  StatusPathOperation,
  syncResultAttrs,
  SyncPageOperation,
  SyncPathOperation,
  SyncTreeOperation,
  TrackPageOperation,
  WatchOperation,
  watchSyncErrorAttrs,
  watchSyncResultAttrs,
  WatchSyncPassOperation,
  WebhookDecodeOperation,
  WebhookTriggerOperation,
  WriteObjectStateOperation,
} from './notion-md.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString
const Flag = Schema.Boolean
const Count = Schema.NonNegativeInt
const EditorMode = Schema.Literal('default', 'frontmatter')
const EditOutcome = Schema.Literal('pushed', 'noop', 'aborted', 'conflict', 'read-only')
const WatchReason = Schema.Literal('file', 'initial', 'poll')

const TrackSource = Schema.Literal('local', 'remote', 'shared')

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))
const b = (key: string) => Schema.Boolean.pipe(OtelAttr.key({ key }))
const n = (key: string) => Schema.NonNegativeInt.pipe(OtelAttr.key({ key }))
const label = () => Schema.NonEmptyString.pipe(OtelAttr.spanLabel())
const lit = <const V extends readonly [string, ...string[]]>(key: string, ...v: V) =>
  Schema.Literal(...v).pipe(OtelAttr.key({ key }))

// ---- independent hand-authored operation baselines (mirror pre-migration observability.ts) ----

const statusPathBaseline = OtelOperation.define({
  name: 'notion-md.status-path',
  schema: Schema.Struct({
    basename: s('notion_md.path.basename'),
    recursive: b('notion_md.path.recursive'),
  }),
  label: ({ basename }) => basename,
})
const planPathBaseline = OtelOperation.define({
  name: 'notion-md.plan-path',
  schema: Schema.Struct({
    basename: s('notion_md.path.basename'),
    fromRemote: b('notion_md.tree.from_remote'),
  }),
  label: ({ basename }) => basename,
})
const syncPathBaseline = OtelOperation.define({
  name: 'notion-md.sync-path',
  schema: Schema.Struct({
    basename: s('notion_md.path.basename'),
    recursive: b('notion_md.path.recursive'),
    fromRemote: b('notion_md.tree.from_remote'),
  }),
  label: ({ basename }) => basename,
})
const syncTreeBaseline = OtelOperation.define({
  name: 'notion-md.sync-tree',
  schema: Schema.Struct({
    basename: s('notion_md.path.basename'),
    plan: b('notion_md.tree.plan'),
    fromRemote: b('notion_md.tree.from_remote'),
  }),
  label: ({ basename }) => basename,
})
const readNmdStateBaseline = OtelOperation.define({
  name: 'notion-md.state.read-nmd',
  schema: Schema.Struct({
    operation: s('notion_md.state.operation'),
    basename: s('notion_md.path.basename'),
  }),
  label: ({ basename }) => basename,
})
const objectRoleBaseline = (name: string) =>
  OtelOperation.define({
    name,
    schema: Schema.Struct({
      role: s('notion_md.object.role'),
      basename: Schema.optional(s('notion_md.path.basename')),
      hashPrefix: Schema.optional(s('notion_md.object.hash_prefix')),
    }),
    label: ({ role }) => role,
  })
const pullPageBaseline = OtelOperation.define({
  name: 'notion-md.pull-page',
  schema: Schema.Struct({
    pageId: s('notion_md.page_id'),
    basename: s('notion_md.path.basename'),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})
const establishSidecarBaseline = OtelOperation.define({
  name: 'notion-md.establish-sidecar',
  schema: Schema.Struct({ pageId: s('notion_md.page_id') }),
  label: ({ pageId }) => pageId.slice(0, 8),
})
const statusPageBaseline = OtelOperation.define({
  name: 'notion-md.status-page',
  schema: Schema.Struct({ basename: s('notion_md.path.basename') }),
  label: ({ basename }) => basename,
})
const pushPageBaseline = OtelOperation.define({
  name: 'notion-md.push-page',
  schema: Schema.Struct({
    basename: s('notion_md.path.basename'),
    force: b('notion_md.push.force'),
    allowDeleteUnknownBlocks: b('notion_md.push.allow_delete_unknown_blocks'),
  }),
  label: ({ basename }) => basename,
})
const syncPageBaseline = OtelOperation.define({
  name: 'notion-md.sync-page',
  schema: Schema.Struct({ basename: s('notion_md.path.basename') }),
  label: ({ basename }) => basename,
})
const pageIdBaseline = (name: string) =>
  OtelOperation.define({
    name,
    schema: Schema.Struct({ pageId: s('notion_md.page_id') }),
    label: ({ pageId }) => pageId.slice(0, 8),
  })
const gatewayUpdateMarkdownBaseline = OtelOperation.define({
  name: 'notion-md.gateway.update-markdown',
  schema: Schema.Struct({
    pageId: s('notion_md.page_id'),
    type: s('notion_md.markdown_update.type'),
    allowDeletingContent: b('notion_md.markdown_update.allow_deleting_content'),
    contentUpdateCount: n('notion_md.markdown_update.content_update_count'),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})
const gatewayRetrieveDataSourceBaseline = OtelOperation.define({
  name: 'notion-md.gateway.retrieve-data-source',
  schema: Schema.Struct({ dataSourceId: s('notion_md.data_source_id') }),
  label: ({ dataSourceId }) => dataSourceId.slice(0, 8),
})
const gatewayUpdatePageMetadataBaseline = OtelOperation.define({
  name: 'notion-md.gateway.update-page-metadata',
  schema: Schema.Struct({
    pageId: s('notion_md.page_id'),
    hasTitle: b('notion_md.page_metadata.title'),
    hasIcon: b('notion_md.page_metadata.icon'),
    hasCover: b('notion_md.page_metadata.cover'),
    inTrash: b('notion_md.page_metadata.in_trash'),
    isLocked: b('notion_md.page_metadata.is_locked'),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})
const gatewayCreatePageBaseline = OtelOperation.define({
  name: 'notion-md.gateway.create-page',
  schema: Schema.Struct({ parentPageId: s('notion_md.parent_page_id') }),
  label: ({ parentPageId }) => parentPageId.slice(0, 8),
})
const catBaseline = OtelOperation.define({
  name: 'notion-md.cat',
  root: true,
  schema: Schema.Struct({
    pageId: s('notion_md.page_id'),
    mode: lit('notion_md.editor.mode', 'default', 'frontmatter'),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})
const putBaseline = OtelOperation.define({
  name: 'notion-md.put',
  root: true,
  schema: Schema.Struct({
    pageId: s('notion_md.page_id'),
    force: b('notion_md.put.force'),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})
const editBaseline = OtelOperation.define({
  name: 'notion-md.edit',
  root: true,
  schema: Schema.Struct({
    pageId: s('notion_md.page_id'),
    mode: lit('notion_md.editor.mode', 'default', 'frontmatter'),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})
const mediaBoundaryBaseline = OtelOperation.define({
  name: 'notion-md.media-boundary',
  schema: Schema.Struct({
    operation: s('notion_md.media_boundary.operation'),
    fileCount: n('notion_md.media_boundary.file_count'),
    verdict: s('notion_md.media_boundary.verdict'),
    guard: Schema.optional(s('notion_md.media_boundary.guard')),
  }),
  label: ({ operation, verdict }) => `${operation}:${verdict}`,
})
const commentBoundaryBaseline = OtelOperation.define({
  name: 'notion-md.comment-boundary',
  schema: Schema.Struct({
    operation: s('notion_md.comment_boundary.operation'),
    commentCount: n('notion_md.comment_boundary.comment_count'),
    verdict: s('notion_md.comment_boundary.verdict'),
    guard: Schema.optional(s('notion_md.comment_boundary.guard')),
  }),
  label: ({ operation, verdict }) => `${operation}:${verdict}`,
})
const destructiveBodyBaseline = OtelOperation.define({
  name: 'notion-md.destructive-body',
  schema: Schema.Struct({
    guard: s('notion_md.destructive_body.guard'),
    blockCount: n('notion_md.destructive_body.block_count'),
    verdict: s('notion_md.destructive_body.verdict'),
  }),
  label: ({ guard, verdict }) => `${guard}:${verdict}`,
})
const objectGcBaseline = OtelOperation.define({
  name: 'notion-md.object-gc',
  schema: Schema.Struct({
    dryRun: b('notion_md.object_gc.dry_run'),
    reachableCount: Schema.optional(n('notion_md.object_gc.reachable_count')),
    removedCount: Schema.optional(n('notion_md.object_gc.removed_count')),
  }),
  label: ({ dryRun }) => (dryRun === true ? 'plan' : 'prune'),
})
const webhookTriggerBaseline = OtelOperation.define({
  name: 'notion-md.webhook.trigger',
  schema: Schema.Struct({
    eventType: s('notion_md.webhook.event_type'),
    surface: s('notion_md.webhook.surface'),
    triggerCount: n('notion_md.webhook.trigger_count'),
  }),
  label: ({ surface, eventType }) => `${surface}:${eventType}`,
})
const batchWatchBaseline = OtelOperation.define({
  name: 'notion-md.batch-watch',
  schema: Schema.Struct({
    command: s('notion_md.command'),
    watch: b('notion_md.watch'),
    batch: b('notion_md.batch'),
    pathCount: n('notion_md.batch.path_count'),
  }),
  label: ({ pathCount }) => `${pathCount} file(s)`,
})
const watchBaseline = OtelOperation.define({
  name: 'notion-md.watch',
  schema: Schema.Struct({
    command: s('notion_md.command'),
    watch: b('notion_md.watch'),
    basename: s('notion_md.path.basename'),
  }),
  label: ({ basename }) => basename,
})
const watchSyncPassBaseline = OtelOperation.define({
  name: 'notion-md.watch.sync-pass',
  root: true,
  schema: Schema.Struct({
    command: s('notion_md.command'),
    watch: b('notion_md.watch'),
    reason: lit('notion_md.watch.reason', 'file', 'initial', 'poll'),
    basename: s('notion_md.path.basename'),
  }),
  label: ({ basename, reason }) => `${basename}:${reason}`,
})
// Static-name spans whose label is a runtime-only field (re-pointed from raw `Effect.withSpan`).
const trackPageBaseline = OtelOperation.define({
  name: 'notion-md.track-page',
  schema: Schema.Struct({
    label: label(),
    source: lit('notion_md.track.source', 'local', 'remote', 'shared'),
  }),
  label: ({ label }) => label,
})
// Label-only spans (only `span.label`); mirror the runtime encoder derived from the seam op.
const labelOnlyBaseline = (name: string) =>
  OtelOperation.define({
    name,
    schema: Schema.Struct({ label: label() }),
    label: ({ label }) => label,
  })

// ---- per-operation cases (name / baseline / derived / input arbitrary) ----
const opCases = [
  {
    name: 'status-path',
    baseline: statusPathBaseline,
    derived: StatusPathOperation.operation,
    input: Schema.Struct({ basename: Str, recursive: Flag }),
  },
  {
    name: 'plan-path',
    baseline: planPathBaseline,
    derived: PlanPathOperation.operation,
    input: Schema.Struct({ basename: Str, fromRemote: Flag }),
  },
  {
    name: 'sync-path',
    baseline: syncPathBaseline,
    derived: SyncPathOperation.operation,
    input: Schema.Struct({ basename: Str, recursive: Flag, fromRemote: Flag }),
  },
  {
    name: 'sync-tree',
    baseline: syncTreeBaseline,
    derived: SyncTreeOperation.operation,
    input: Schema.Struct({ basename: Str, plan: Flag, fromRemote: Flag }),
  },
  {
    name: 'state.read-nmd',
    baseline: readNmdStateBaseline,
    derived: ReadNmdStateOperation.operation,
    input: Schema.Struct({ operation: Str, basename: Str }),
  },
  {
    name: 'state.write-object',
    baseline: objectRoleBaseline('notion-md.state.write-object'),
    derived: WriteObjectStateOperation.operation,
    input: Schema.Struct({
      role: Str,
      basename: Schema.optional(Str),
      hashPrefix: Schema.optional(Str),
    }),
  },
  {
    name: 'state.read-object',
    baseline: objectRoleBaseline('notion-md.state.read-object'),
    derived: ReadObjectStateOperation.operation,
    input: Schema.Struct({
      role: Str,
      basename: Schema.optional(Str),
      hashPrefix: Schema.optional(Str),
    }),
  },
  {
    name: 'pull-page',
    baseline: pullPageBaseline,
    derived: PullPageOperation.operation,
    input: Schema.Struct({ pageId: Str, basename: Str }),
  },
  {
    name: 'establish-sidecar',
    baseline: establishSidecarBaseline,
    derived: EstablishSidecarOperation.operation,
    input: Schema.Struct({ pageId: Str }),
  },
  {
    name: 'status-page',
    baseline: statusPageBaseline,
    derived: StatusPageOperation.operation,
    input: Schema.Struct({ basename: Str }),
  },
  {
    name: 'push-page',
    baseline: pushPageBaseline,
    derived: PushPageOperation.operation,
    input: Schema.Struct({ basename: Str, force: Flag, allowDeleteUnknownBlocks: Flag }),
  },
  {
    name: 'sync-page',
    baseline: syncPageBaseline,
    derived: SyncPageOperation.operation,
    input: Schema.Struct({ basename: Str }),
  },
  {
    name: 'gateway.pull-page',
    baseline: pageIdBaseline('notion-md.gateway.pull-page'),
    derived: GatewayPullPageOperation.operation,
    input: Schema.Struct({ pageId: Str }),
  },
  {
    name: 'gateway.update-markdown',
    baseline: gatewayUpdateMarkdownBaseline,
    derived: GatewayUpdateMarkdownOperation.operation,
    input: Schema.Struct({
      pageId: Str,
      type: Str,
      allowDeletingContent: Flag,
      contentUpdateCount: Count,
    }),
  },
  {
    name: 'gateway.update-page-properties',
    baseline: pageIdBaseline('notion-md.gateway.update-page-properties'),
    derived: GatewayUpdatePagePropertiesOperation.operation,
    input: Schema.Struct({ pageId: Str }),
  },
  {
    name: 'gateway.retrieve-data-source',
    baseline: gatewayRetrieveDataSourceBaseline,
    derived: GatewayRetrieveDataSourceOperation.operation,
    input: Schema.Struct({ dataSourceId: Str }),
  },
  {
    name: 'gateway.update-page-metadata',
    baseline: gatewayUpdatePageMetadataBaseline,
    derived: GatewayUpdatePageMetadataOperation.operation,
    input: Schema.Struct({
      pageId: Str,
      hasTitle: Flag,
      hasIcon: Flag,
      hasCover: Flag,
      inTrash: Flag,
      isLocked: Flag,
    }),
  },
  {
    name: 'gateway.list-child-pages',
    baseline: pageIdBaseline('notion-md.gateway.list-child-pages'),
    derived: GatewayListChildPagesOperation.operation,
    input: Schema.Struct({ pageId: Str }),
  },
  {
    name: 'gateway.create-page',
    baseline: gatewayCreatePageBaseline,
    derived: GatewayCreatePageOperation.operation,
    input: Schema.Struct({ parentPageId: Str }),
  },
  {
    name: 'gateway.move-page',
    baseline: pageIdBaseline('notion-md.gateway.move-page'),
    derived: GatewayMovePageOperation.operation,
    input: Schema.Struct({ pageId: Str }),
  },
  {
    name: 'gateway.archive-page',
    baseline: pageIdBaseline('notion-md.gateway.archive-page'),
    derived: GatewayArchivePageOperation.operation,
    input: Schema.Struct({ pageId: Str }),
  },
  {
    name: 'cat',
    baseline: catBaseline,
    derived: CatOperation.operation,
    input: Schema.Struct({ pageId: Str, mode: EditorMode }),
  },
  {
    name: 'put',
    baseline: putBaseline,
    derived: PutOperation.operation,
    input: Schema.Struct({ pageId: Str, force: Flag }),
  },
  {
    name: 'edit',
    baseline: editBaseline,
    derived: EditOperation.operation,
    input: Schema.Struct({ pageId: Str, mode: EditorMode }),
  },
  {
    name: 'media-boundary',
    baseline: mediaBoundaryBaseline,
    derived: MediaBoundaryOperation.operation,
    input: Schema.Struct({
      operation: Str,
      fileCount: Count,
      verdict: Str,
      guard: Schema.optional(Str),
    }),
  },
  {
    name: 'comment-boundary',
    baseline: commentBoundaryBaseline,
    derived: CommentBoundaryOperation.operation,
    input: Schema.Struct({
      operation: Str,
      commentCount: Count,
      verdict: Str,
      guard: Schema.optional(Str),
    }),
  },
  {
    name: 'destructive-body',
    baseline: destructiveBodyBaseline,
    derived: DestructiveBodyOperation.operation,
    input: Schema.Struct({ guard: Str, blockCount: Count, verdict: Str }),
  },
  {
    name: 'object-gc',
    baseline: objectGcBaseline,
    derived: ObjectGcOperation.operation,
    input: Schema.Struct({
      dryRun: Flag,
      reachableCount: Schema.optional(Count),
      removedCount: Schema.optional(Count),
    }),
  },
  {
    name: 'webhook.trigger',
    baseline: webhookTriggerBaseline,
    derived: WebhookTriggerOperation.operation,
    input: Schema.Struct({ eventType: Str, surface: Str, triggerCount: Count }),
  },
  {
    name: 'batch-watch',
    baseline: batchWatchBaseline,
    derived: BatchWatchOperation.operation,
    input: Schema.Struct({ command: Str, watch: Flag, batch: Flag, pathCount: Count }),
  },
  {
    name: 'watch',
    baseline: watchBaseline,
    derived: WatchOperation.operation,
    input: Schema.Struct({ command: Str, watch: Flag, basename: Str }),
  },
  {
    name: 'watch.sync-pass',
    baseline: watchSyncPassBaseline,
    derived: WatchSyncPassOperation.operation,
    input: Schema.Struct({ command: Str, watch: Flag, reason: WatchReason, basename: Str }),
  },
  {
    name: 'track-page',
    baseline: trackPageBaseline,
    derived: TrackPageOperation.operation,
    input: Schema.Struct({ label: Str, source: TrackSource }),
  },
  {
    name: 'status-file',
    baseline: labelOnlyBaseline('notion-md.status-file'),
    derived: StatusFileOperation.operation,
    input: Schema.Struct({ label: Str }),
  },
  {
    name: 'reconcile-file',
    baseline: labelOnlyBaseline('notion-md.reconcile-file'),
    derived: ReconcileFileOperation.operation,
    input: Schema.Struct({ label: Str }),
  },
  {
    name: 'webhook.decode',
    baseline: labelOnlyBaseline('notion-md.webhook.decode'),
    derived: WebhookDecodeOperation.operation,
    input: Schema.Struct({ label: Str }),
  },
] as const

// ---- independent hand-authored annotate-bundle baselines ----
const statusBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: s('notion_md.page_id'),
    localChanged: b('notion_md.status.local_changed'),
    localPageMetadataChanged: b('notion_md.status.local_page_metadata_changed'),
    localPropertiesChanged: b('notion_md.status.local_properties_changed'),
    remoteChanged: b('notion_md.status.remote_changed'),
    remoteBodyChanged: b('notion_md.status.remote_body_changed'),
    remotePageMetadataChanged: b('notion_md.status.remote_page_metadata_changed'),
    unknownBlockCount: n('notion_md.status.unknown_block_count'),
  }),
)
const pushResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({ pageId: s('notion_md.page_id'), pushed: b('notion_md.push.pushed') }),
)
const syncResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({ pageId: s('notion_md.page_id'), result: s('notion_md.sync.result') }),
)
const objectHashBaseline = OtelAttrs.defineSync(
  Schema.Struct({ hashPrefix: s('notion_md.object.hash_prefix') }),
)
const pushDecisionBaseline = OtelAttrs.defineSync(
  Schema.Struct({ decision: s('notion_md.push.decision') }),
)
const pushMarkdownCommandBaseline = OtelAttrs.defineSync(
  Schema.Struct({ markdownCommand: s('notion_md.push.markdown_command') }),
)
const pushDecisionMarkdownCommandBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    decision: s('notion_md.push.decision'),
    markdownCommand: s('notion_md.push.markdown_command'),
  }),
)
const putResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    bodyWritten: b('notion_md.put.body_written'),
    titleWritten: b('notion_md.put.title_written'),
  }),
)
const editResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    outcome: lit('notion_md.edit.outcome', 'pushed', 'noop', 'aborted', 'conflict', 'read-only'),
  }),
)
const objectGcResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    reachableCount: n('notion_md.object_gc.reachable_count'),
    removedCount: n('notion_md.object_gc.removed_count'),
  }),
)
const watchSyncResultBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    result: s('notion_md.sync.result'),
    reason: lit('notion_md.watch.reason', 'file', 'initial', 'poll'),
  }),
)
const watchSyncErrorBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    error: b('notion_md.sync.error'),
    errorTag: s('notion_md.sync.error_tag'),
  }),
)

const bundleCases = [
  {
    name: 'statusAttrs',
    baseline: statusBaseline,
    derived: statusAttrs,
    input: Schema.Struct({
      pageId: Str,
      localChanged: Flag,
      localPageMetadataChanged: Flag,
      localPropertiesChanged: Flag,
      remoteChanged: Flag,
      remoteBodyChanged: Flag,
      remotePageMetadataChanged: Flag,
      unknownBlockCount: Count,
    }),
  },
  {
    name: 'pushResultAttrs',
    baseline: pushResultBaseline,
    derived: pushResultAttrs,
    input: Schema.Struct({ pageId: Str, pushed: Flag }),
  },
  {
    name: 'syncResultAttrs',
    baseline: syncResultBaseline,
    derived: syncResultAttrs,
    input: Schema.Struct({ pageId: Str, result: Str }),
  },
  {
    name: 'objectHashAttrs',
    baseline: objectHashBaseline,
    derived: objectHashAttrs,
    input: Schema.Struct({ hashPrefix: Str }),
  },
  {
    name: 'pushDecisionAttrs',
    baseline: pushDecisionBaseline,
    derived: pushDecisionAttrs,
    input: Schema.Struct({ decision: Str }),
  },
  {
    name: 'pushMarkdownCommandAttrs',
    baseline: pushMarkdownCommandBaseline,
    derived: pushMarkdownCommandAttrs,
    input: Schema.Struct({ markdownCommand: Str }),
  },
  {
    name: 'pushDecisionMarkdownCommandAttrs',
    baseline: pushDecisionMarkdownCommandBaseline,
    derived: pushDecisionMarkdownCommandAttrs,
    input: Schema.Struct({ decision: Str, markdownCommand: Str }),
  },
  {
    name: 'putResultAttrs',
    baseline: putResultBaseline,
    derived: putResultAttrs,
    input: Schema.Struct({ bodyWritten: Flag, titleWritten: Flag }),
  },
  {
    name: 'editResultAttrs',
    baseline: editResultBaseline,
    derived: editResultAttrs,
    input: Schema.Struct({ outcome: EditOutcome }),
  },
  {
    name: 'objectGcResultAttrs',
    baseline: objectGcResultBaseline,
    derived: objectGcResultAttrs,
    input: Schema.Struct({ reachableCount: Count, removedCount: Count }),
  },
  {
    name: 'watchSyncResultAttrs',
    baseline: watchSyncResultBaseline,
    derived: watchSyncResultAttrs,
    input: Schema.Struct({ result: Str, reason: WatchReason }),
  },
  {
    name: 'watchSyncErrorAttrs',
    baseline: watchSyncErrorBaseline,
    derived: watchSyncErrorAttrs,
    input: Schema.Struct({ error: Flag, errorTag: Str }),
  },
] as const

describe('notion_md.* derived operation encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of opCases) {
    it.prop(
      `${c.name}: derived .operation.encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = (c.baseline as OtelOperationDefinition<never>).encodeSync(value as never)
        const derived = (c.derived as OtelOperationDefinition<never>).encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
        expect(typeof derived['span.label']).toBe('string')
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on span name + attribute keys`, () => {
      expect(c.derived.metadata.name).toBe(c.baseline.metadata.name)
      expect([...c.derived.metadata.attributeKeys].toSorted()).toStrictEqual(
        [...c.baseline.metadata.attributeKeys].toSorted(),
      )
    })
  }
})

describe('notion_md.* derived annotate encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of bundleCases) {
    it.prop(
      `${c.name}: derived .encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = c.baseline.encodeSync(value as never)
        const derived = c.derived.encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on attribute keys`, () => {
      expect([...c.derived.keys].toSorted()).toStrictEqual([...c.baseline.keys].toSorted())
    })
  }
})
