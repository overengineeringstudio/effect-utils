import { basename } from 'node:path'

import { Schema } from 'effect'

import { OtelAttr, OtelAttrs, OtelSpan } from '@overeng/otel-contract'

export const pageAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.page_id' })),
  }),
)

export const parentPageAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    parentPageId: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.parent_page_id' })),
  }),
)

export const pathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    basename: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' })),
  }),
)

export const pathRecursiveAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    recursive: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.path.recursive' })),
  }),
)

export const pathPlanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    fromRemote: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.tree.from_remote' })),
  }),
)

export const pathSyncAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    recursive: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.path.recursive' })),
    fromRemote: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion_md.tree.from_remote' })),
  }),
)

export const pagePathAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
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
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
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
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
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
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    role: Schema.String.pipe(OtelAttr.key({ key: 'notion_md.object.role' })),
    basename: Schema.optional(Schema.String.pipe(OtelAttr.key({ key: 'notion_md.path.basename' }))),
    hashPrefix: Schema.optional(
      Schema.String.pipe(OtelAttr.key({ key: 'notion_md.object.hash_prefix' })),
    ),
  }),
)

export const markdownUpdateAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
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
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
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

export const StatusPathSpan = OtelSpan.define({
  name: 'notion-md.status-path',
  attributes: pathRecursiveAttrs,
})

export const PlanPathSpan = OtelSpan.define({
  name: 'notion-md.plan-path',
  attributes: pathPlanAttrs,
})

export const SyncPathSpan = OtelSpan.define({
  name: 'notion-md.sync-path',
  attributes: pathSyncAttrs,
})

export const stateFileSpan = (operation: string) =>
  OtelSpan.define({
    name: `notion-md.state.${operation}`,
    attributes: stateFileAttrs,
  })

export const ReadNmdStateSpan = OtelSpan.define({
  name: 'notion-md.state.read-nmd',
  attributes: stateFileAttrs,
})

export const WriteObjectStateSpan = OtelSpan.define({
  name: 'notion-md.state.write-object',
  attributes: objectRoleAttrs,
})

export const ReadObjectStateSpan = OtelSpan.define({
  name: 'notion-md.state.read-object',
  attributes: objectRoleAttrs,
})

export const PullPageSpan = OtelSpan.define({
  name: 'notion-md.pull-page',
  attributes: pagePathAttrs,
})

export const EstablishSidecarSpan = OtelSpan.define({
  name: 'notion-md.establish-sidecar',
  attributes: pageAttrs,
})

export const StatusPageSpan = OtelSpan.define({
  name: 'notion-md.status-page',
  attributes: pathAttrs,
})

export const PushPageSpan = OtelSpan.define({
  name: 'notion-md.push-page',
  attributes: pushSpanAttrs,
})

export const SyncPageSpan = OtelSpan.define({
  name: 'notion-md.sync-page',
  attributes: pathAttrs,
})

export const GatewayPullPageSpan = OtelSpan.define({
  name: 'notion-md.gateway.pull-page',
  attributes: pageAttrs,
})

export const GatewayUpdateMarkdownSpan = OtelSpan.define({
  name: 'notion-md.gateway.update-markdown',
  attributes: markdownUpdateAttrs,
})

export const GatewayUpdatePagePropertiesSpan = OtelSpan.define({
  name: 'notion-md.gateway.update-page-properties',
  attributes: pageAttrs,
})

export const GatewayUpdatePageMetadataSpan = OtelSpan.define({
  name: 'notion-md.gateway.update-page-metadata',
  attributes: metadataUpdateAttrs,
})

export const GatewayListChildPagesSpan = OtelSpan.define({
  name: 'notion-md.gateway.list-child-pages',
  attributes: pageAttrs,
})

export const GatewayCreatePageSpan = OtelSpan.define({
  name: 'notion-md.gateway.create-page',
  attributes: parentPageAttrs,
})

export const GatewayMovePageSpan = OtelSpan.define({
  name: 'notion-md.gateway.move-page',
  attributes: pageAttrs,
})

export const GatewayArchivePageSpan = OtelSpan.define({
  name: 'notion-md.gateway.archive-page',
  attributes: pageAttrs,
})

export const page = (pageId: string) =>
  pageAttrs.unsafeEncode({ label: pageId.slice(0, 8), pageId })

export const parentPage = (parentPageId: string) =>
  parentPageAttrs.unsafeEncode({ label: parentPageId.slice(0, 8), parentPageId })

export const path = (filePath: string) =>
  pathAttrs.unsafeEncode({ label: basename(filePath), basename: basename(filePath) })

export const pagePath = (input: { readonly pageId: string; readonly path: string }) =>
  pagePathAttrs.unsafeEncode({
    label: input.pageId.slice(0, 8),
    pageId: input.pageId,
    basename: basename(input.path),
  })
