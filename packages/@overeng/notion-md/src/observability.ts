import { Effect, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  OtelSpan,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

const pageAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
  }),
)

const parentPageAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    parentPageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.parent_page_id' })),
  }),
)

const dataSourceAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    dataSourceId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.data_source_id' })),
  }),
)

const pathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
)

const pathRecursiveAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
    recursive: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.path.recursive' })),
  }),
)

const pathPlanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
    fromRemote: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.tree.from_remote' })),
  }),
)

const pathSyncAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
    recursive: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.path.recursive' })),
    fromRemote: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.tree.from_remote' })),
  }),
)

const pagePathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
)

/** Status-comparison flags (per local/remote dimension) annotated onto a status span. */
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

const pushSpanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
    force: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.push.force' })),
    allowDeleteUnknownBlocks: Schema.Boolean.pipe(
      OtelAttr.key({ key: 'notion_md.push.allow_delete_unknown_blocks' }),
    ),
  }),
)

/** Outcome of a push: resolved page id plus whether anything was actually pushed. */
export const pushResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    pushed: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.push.pushed' })),
  }),
)

/** Terminal sync outcome (`result` is the reconciliation verdict string). */
export const syncResultAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    result: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.sync.result' })),
  }),
)

const stateFileAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    operation: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.state.operation' })),
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
)

/** Content-object identity carried as a short hash prefix (full hash is high-cardinality). */
export const objectHashAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    hashPrefix: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.object.hash_prefix' })),
  }),
)

const objectRoleAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    role: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.object.role' })),
    basename: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' }))),
    hashPrefix: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'notion_md.object.hash_prefix' })),
    ),
  }),
)

const markdownUpdateAttrs = OtelAttrs.defineSync(
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

const metadataUpdateAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
    hasTitle: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.title' })),
    hasIcon: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.icon' })),
    hasCover: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.cover' })),
    inTrash: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.in_trash' })),
    isLocked: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.page_metadata.is_locked' })),
  }),
)

/** The storage/push decision verdict annotated onto a push span. */
export const pushDecisionAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    decision: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.push.decision' })),
  }),
)

/** Which markdown-update command shape a push resolved to (e.g. replace vs patch). */
export const pushMarkdownCommandAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    markdownCommand: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.push.markdown_command' })),
  }),
)

/** Combined push decision + resolved markdown-command annotated together on one span. */
export const pushDecisionMarkdownCommandAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    decision: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.push.decision' })),
    markdownCommand: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.push.markdown_command' })),
  }),
)

/** Wrap an effect in an OTEL operation span; an attribute-encode failure is a defect, not a recoverable error. */
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

/** Annotate the current span with typed attributes; an attribute-encode failure is a defect, not a recoverable error. */
export const annotateAttrs = <S extends Schema.Schema.AnyNoContext>(
  attributes: OtelAttrs<S>,
  value: Schema.Schema.Type<S>,
): Effect.Effect<void> =>
  OtelSpan.annotate({ attributes, value }).pipe(
    Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)),
  )

/** Span for `status` over a filesystem path (file or recursive tree). */
export const StatusPathSpan = OtelOperation.define({
  name: 'notion-md.status-path',
  attributes: pathRecursiveAttrs,
  label: ({ basename }) => basename,
})

/** Span for planning a tree sync over a path (`fromRemote` picks the plan direction). */
export const PlanPathSpan = OtelOperation.define({
  name: 'notion-md.plan-path',
  attributes: pathPlanAttrs,
  label: ({ basename }) => basename,
})

/** Span for `sync` over a filesystem path (recursive tree or single file). */
export const SyncPathSpan = OtelOperation.define({
  name: 'notion-md.sync-path',
  attributes: pathSyncAttrs,
  label: ({ basename }) => basename,
})

/** Build a state-file span whose name is parameterized by the state operation performed. */
export const stateFileSpan = (operation: string) =>
  OtelOperation.define({
    name: `notion-md.state.${operation}`,
    attributes: stateFileAttrs,
    label: ({ basename }) => basename,
  })

/** Span for reading the `.nmd` sidecar state file. */
export const ReadNmdStateSpan = OtelOperation.define({
  name: 'notion-md.state.read-nmd',
  attributes: stateFileAttrs,
  label: ({ basename }) => basename,
})

/** Span for writing a content object into the state store (labelled by object role). */
export const WriteObjectStateSpan = OtelOperation.define({
  name: 'notion-md.state.write-object',
  attributes: objectRoleAttrs,
  label: ({ role }) => role,
})

/** Span for reading a content object from the state store (labelled by object role). */
export const ReadObjectStateSpan = OtelOperation.define({
  name: 'notion-md.state.read-object',
  attributes: objectRoleAttrs,
  label: ({ role }) => role,
})

/** Span for pulling a single page from Notion into a local file. */
export const PullPageSpan = OtelOperation.define({
  name: 'notion-md.pull-page',
  attributes: pagePathAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Span for establishing the `.nmd` sidecar baseline for a page on first contact. */
export const EstablishSidecarSpan = OtelOperation.define({
  name: 'notion-md.establish-sidecar',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Span for computing status of a single page against its baseline. */
export const StatusPageSpan = OtelOperation.define({
  name: 'notion-md.status-page',
  attributes: pathAttrs,
  label: ({ basename }) => basename,
})

/** Span for pushing a single local page to Notion. */
export const PushPageSpan = OtelOperation.define({
  name: 'notion-md.push-page',
  attributes: pushSpanAttrs,
  label: ({ basename }) => basename,
})

/** Span for the full reconcile (status + pull/push) of a single page. */
export const SyncPageSpan = OtelOperation.define({
  name: 'notion-md.sync-page',
  attributes: pathAttrs,
  label: ({ basename }) => basename,
})

/** Gateway-level span for the Notion API call that pulls a page's content. */
export const GatewayPullPageSpan = OtelOperation.define({
  name: 'notion-md.gateway.pull-page',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Gateway-level span for applying a markdown body update to a page. */
export const GatewayUpdateMarkdownSpan = OtelOperation.define({
  name: 'notion-md.gateway.update-markdown',
  attributes: markdownUpdateAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Gateway-level span for updating a page's database properties. */
export const GatewayUpdatePagePropertiesSpan = OtelOperation.define({
  name: 'notion-md.gateway.update-page-properties',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Gateway-level span for retrieving a data source (database) schema. */
export const GatewayRetrieveDataSourceSpan = OtelOperation.define({
  name: 'notion-md.gateway.retrieve-data-source',
  attributes: dataSourceAttrs,
  label: ({ dataSourceId }) => dataSourceId.slice(0, 8),
})

/** Gateway-level span for updating page metadata (title/icon/cover/trash/lock). */
export const GatewayUpdatePageMetadataSpan = OtelOperation.define({
  name: 'notion-md.gateway.update-page-metadata',
  attributes: metadataUpdateAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Gateway-level span for listing a page's direct child pages. */
export const GatewayListChildPagesSpan = OtelOperation.define({
  name: 'notion-md.gateway.list-child-pages',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Gateway-level span for creating a new child page under a parent. */
export const GatewayCreatePageSpan = OtelOperation.define({
  name: 'notion-md.gateway.create-page',
  attributes: parentPageAttrs,
  label: ({ parentPageId }) => parentPageId.slice(0, 8),
})

/** Gateway-level span for moving a page to a new parent. */
export const GatewayMovePageSpan = OtelOperation.define({
  name: 'notion-md.gateway.move-page',
  attributes: pageAttrs,
  label: ({ pageId }) => pageId.slice(0, 8),
})

/** Gateway-level span for archiving (trashing) a page. */
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
