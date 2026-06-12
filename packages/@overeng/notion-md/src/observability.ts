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

export const page = (pageId: string) => GatewayPullPageSpan.encodeSync({ pageId })

export const parentPage = (parentPageId: string) =>
  GatewayCreatePageSpan.encodeSync({ parentPageId })

export const path = (filePath: string) => SyncPageSpan.encodeSync({ basename: basename(filePath) })

export const pagePath = (input: { readonly pageId: string; readonly path: string }) =>
  PullPageSpan.encodeSync({
    pageId: input.pageId,
    basename: basename(input.path),
  })
