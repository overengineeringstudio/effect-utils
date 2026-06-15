import { basename } from 'node:path'

import { Effect, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  OtelSpan,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

export const pageAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
  }),
)

export const parentPageAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    parentPageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.parent_page_id' })),
  }),
)

export const dataSourceAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    dataSourceId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.data_source_id' })),
  }),
)

export const pathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
)

export const pathRecursiveAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
    recursive: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.path.recursive' })),
  }),
)

export const pathPlanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
    fromRemote: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.tree.from_remote' })),
  }),
)

export const pathSyncAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
    recursive: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.path.recursive' })),
    fromRemote: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.tree.from_remote' })),
  }),
)

export const pagePathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
)

export const statusAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    localChanged: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.status.local_changed' })),
    localPageMetadataChanged: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'notion_md.status.local_page_metadata_changed' }),
    ),
    localPropertiesChanged: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'notion_md.status.local_properties_changed' }),
    ),
    remoteChanged: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.status.remote_changed' })),
    remoteBodyChanged: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'notion_md.status.remote_body_changed' }),
    ),
    remotePageMetadataChanged: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'notion_md.status.remote_page_metadata_changed' }),
    ),
    unknownBlockCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion_md.status.unknown_block_count' }),
    ),
  }),
)

export const pushSpanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
    force: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.push.force' })),
    allowDeleteUnknownBlocks: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'notion_md.push.allow_delete_unknown_blocks' }),
    ),
  }),
)

export const pushResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    pushed: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.push.pushed' })),
  }),
)

export const syncResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    result: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.sync.result' })),
  }),
)

export const stateFileAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    operation: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.state.operation' })),
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
)

export const objectHashAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    hashPrefix: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.object.hash_prefix' })),
  }),
)

export const objectRoleAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    role: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.object.role' })),
    basename: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' }))),
    hashPrefix: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'notion_md.object.hash_prefix' })),
    ),
  }),
)

export const markdownUpdateAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    type: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.markdown_update.type' })),
    allowDeletingContent: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'notion_md.markdown_update.allow_deleting_content' }),
    ),
    contentUpdateCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion_md.markdown_update.content_update_count' }),
    ),
  }),
)

export const metadataUpdateAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    hasTitle: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.title' })),
    hasIcon: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.icon' })),
    hasCover: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.cover' })),
    inTrash: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.in_trash' })),
    isLocked: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.is_locked' })),
  }),
)

export const pushDecisionAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    decision: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.push.decision' })),
  }),
)

export const pushMarkdownCommandAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    markdownCommand: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.push.markdown_command' })),
  }),
)

export const pushDecisionMarkdownCommandAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    decision: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.push.decision' })),
    markdownCommand: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.push.markdown_command' })),
  }),
)

/** Span attributes for schema-decoded webhook trigger classification. */
export const webhookTriggerAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    eventType: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.webhook.event_type' })),
    surface: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.webhook.surface' })),
    triggerCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion_md.webhook.trigger_count' }),
    ),
  }),
)

/** Span attributes for a files/media write-boundary classification. */
export const mediaBoundaryAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    operation: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.media_boundary.operation' })),
    fileCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion_md.media_boundary.file_count' }),
    ),
    verdict: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.media_boundary.verdict' })),
    guard: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'notion_md.media_boundary.guard' })),
    ),
  }),
)

/** Span attributes for a destructive body write gate. */
export const destructiveBodyAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    guard: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.destructive_body.guard' })),
    blockCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion_md.destructive_body.block_count' }),
    ),
    verdict: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.destructive_body.verdict' })),
  }),
)

/** Span attributes for a comment write-boundary classification. */
export const commentBoundaryAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    operation: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.comment_boundary.operation' })),
    commentCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion_md.comment_boundary.comment_count' }),
    ),
    verdict: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.comment_boundary.verdict' })),
    guard: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'notion_md.comment_boundary.guard' })),
    ),
  }),
)

export const withOperation =
  <S extends Schema.Schema.AnyNoContext>(
    operation: OtelOperationDefinition<S>,
    attributes: Schema.Schema.Type<S>,
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      operation.with(attributes),
      Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)),
    )

export const annotateAttrs = <S extends Schema.Schema.AnyNoContext>(
  attributes: OtelAttrs<S>,
  value: Schema.Schema.Type<S>,
): Effect.Effect<void> =>
  OtelSpan.annotate({ attributes, value }).pipe(
    Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)),
  )

export const StatusPathSpan = OtelOperation.define({
  name: 'notion-md.status-path',
  attributes: pathRecursiveAttrs,
  label: ({ basename }) => basename,
})

export const PlanPathSpan = OtelOperation.define({
  name: 'notion-md.plan-path',
  attributes: pathPlanAttrs,
  label: ({ basename }) => basename,
})

export const SyncPathSpan = OtelOperation.define({
  name: 'notion-md.sync-path',
  attributes: pathSyncAttrs,
  label: ({ basename }) => basename,
})

export const stateFileSpan = (operation: string) =>
  OtelOperation.define({
    name: `notion-md.state.${operation}`,
    attributes: stateFileAttrs,
    label: ({ basename }) => basename,
  })

export const ReadNmdStateSpan = OtelOperation.define({
  name: 'notion-md.state.read-nmd',
  attributes: stateFileAttrs,
  label: ({ basename }) => basename,
})

export const WriteObjectStateSpan = OtelOperation.define({
  name: 'notion-md.state.write-object',
  attributes: objectRoleAttrs,
  label: ({ role }) => role,
})

export const ReadObjectStateSpan = OtelOperation.define({
  name: 'notion-md.state.read-object',
  attributes: objectRoleAttrs,
  label: ({ role }) => role,
})

export const PullPageSpan = OtelOperation.define({
  name: 'notion-md.pull-page',
  attributes: pagePathAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

export const EstablishSidecarSpan = OtelOperation.define({
  name: 'notion-md.establish-sidecar',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

export const StatusPageSpan = OtelOperation.define({
  name: 'notion-md.status-page',
  attributes: pathAttrs,
  label: ({ basename }) => basename,
})

export const PushPageSpan = OtelOperation.define({
  name: 'notion-md.push-page',
  attributes: pushSpanAttrs,
  label: ({ basename }) => basename,
})

export const SyncPageSpan = OtelOperation.define({
  name: 'notion-md.sync-page',
  attributes: pathAttrs,
  label: ({ basename }) => basename,
})

export const GatewayPullPageSpan = OtelOperation.define({
  name: 'notion-md.gateway.pull-page',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

export const GatewayUpdateMarkdownSpan = OtelOperation.define({
  name: 'notion-md.gateway.update-markdown',
  attributes: markdownUpdateAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

export const GatewayUpdatePagePropertiesSpan = OtelOperation.define({
  name: 'notion-md.gateway.update-page-properties',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

export const GatewayRetrieveDataSourceSpan = OtelOperation.define({
  name: 'notion-md.gateway.retrieve-data-source',
  attributes: dataSourceAttrs,
  label: ({ dataSourceId }) => dataSourceId.slice(0, 8),
})

export const GatewayUpdatePageMetadataSpan = OtelOperation.define({
  name: 'notion-md.gateway.update-page-metadata',
  attributes: metadataUpdateAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

export const GatewayListChildPagesSpan = OtelOperation.define({
  name: 'notion-md.gateway.list-child-pages',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

export const GatewayCreatePageSpan = OtelOperation.define({
  name: 'notion-md.gateway.create-page',
  attributes: parentPageAttrs,
  label: ({ parentPageId }) => parentPageId.slice(0, 8),
})

export const GatewayMovePageSpan = OtelOperation.define({
  name: 'notion-md.gateway.move-page',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

export const GatewayArchivePageSpan = OtelOperation.define({
  name: 'notion-md.gateway.archive-page',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

const editorModeSchema = Schema.Literal('default', 'frontmatter')

/** Span for `notion-md cat` — read-only editor projection of a Notion page. */
export const CatSpan = OtelOperation.define({
  name: 'notion-md.cat',
  root: true,
  schema: Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    mode: editorModeSchema.pipe(OtelAttr.key({ key: 'notion_md.editor.mode' })),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Span for `notion-md put` — guarded title+body write to a Notion page. */
export const PutSpan = OtelOperation.define({
  name: 'notion-md.put',
  root: true,
  schema: Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    force: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.put.force' })),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Result annotations for a completed `notion-md put`. */
export const putResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    bodyWritten: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.put.body_written' })),
    titleWritten: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.put.title_written' })),
  }),
)

/** Span for `notion-md edit` — ephemeral file-engine editor session (wraps engine spans). */
export const EditSpan = OtelOperation.define({
  name: 'notion-md.edit',
  root: true,
  schema: Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    mode: editorModeSchema.pipe(OtelAttr.key({ key: 'notion_md.editor.mode' })),
  }),
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Outcome annotation for a completed `notion-md edit` session. */
export const editResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    outcome: Schema.Literal('pushed', 'noop', 'aborted', 'conflict', 'read-only').pipe(
      OtelAttr.key({ key: 'notion_md.edit.outcome' }),
    ),
  }),
)

/** Operation span emitted when the files/media write boundary classifies a write. */
export const MediaBoundarySpan = OtelOperation.define({
  name: 'notion-md.media-boundary',
  attributes: mediaBoundaryAttrs,
  label: ({ operation, verdict }) => `${operation}:${verdict}`,
})

/** Operation span emitted when the comment write boundary classifies a write. */
export const CommentBoundarySpan = OtelOperation.define({
  name: 'notion-md.comment-boundary',
  attributes: commentBoundaryAttrs,
  label: ({ operation, verdict }) => `${operation}:${verdict}`,
})

/** Operation span emitted when a destructive body write gate blocks or allows. */
export const DestructiveBodySpan = OtelOperation.define({
  name: 'notion-md.destructive-body',
  attributes: destructiveBodyAttrs,
  label: ({ guard, verdict }) => `${guard}:${verdict}`,
})

/** Span attributes for an object-GC pass (dry-run or live prune). */
export const objectGcAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    /** Whether this was a plan-only (dry-run) pass — known before GC runs. */
    dryRun: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.object_gc.dry_run' })),
    /**
     * Number of reachable objects — annotated after GC completes.
     * @see {@link annotateAttrs} called with {@link objectGcResultAttrs}
     */
    reachableCount: Schema.optional(
      Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'notion_md.object_gc.reachable_count' })),
    ),
    /**
     * Number of removed (or would-be-removed) objects — annotated after GC completes.
     * @see {@link annotateAttrs} called with {@link objectGcResultAttrs}
     */
    removedCount: Schema.optional(
      Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'notion_md.object_gc.removed_count' })),
    ),
  }),
)

/** Post-GC result attributes annotated onto the {@link ObjectGcSpan}. */
export const objectGcResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    reachableCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion_md.object_gc.reachable_count' }),
    ),
    removedCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion_md.object_gc.removed_count' }),
    ),
  }),
)

/** Operation span emitted when object GC runs (plan-only or live prune). */
export const ObjectGcSpan = OtelOperation.define({
  name: 'notion-md.object-gc',
  attributes: objectGcAttrs,
  label: ({ dryRun }) => (dryRun ? 'plan' : 'prune'),
})

/** Operation span emitted when a webhook signal is mapped to watch triggers. */
export const WebhookTriggerSpan = OtelOperation.define({
  name: 'notion-md.webhook.trigger',
  attributes: webhookTriggerAttrs,
  label: ({ surface, eventType }) => `${surface}:${eventType}`,
})

export const page = (pageId: string) => GatewayPullPageSpan.encodeSync({ pageId })

export const parentPage = (parentPageId: string) =>
  GatewayCreatePageSpan.encodeSync({ parentPageId })

export const path = (filePath: string) => SyncPageSpan.encodeSync({ basename: basename(filePath) })

export const pagePath = (input: { readonly pageId: string; readonly path: string }) =>
  PullPageSpan.encodeSync({
    pageId: input.pageId,
    basename: basename(input.path),
  })
