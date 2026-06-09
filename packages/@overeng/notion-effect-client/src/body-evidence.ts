import { Schema } from 'effect'

import {
  canonicalJsonCodec,
  canonicalJsonMediaType,
  ContentDescriptor,
  descriptorForCanonicalJson,
  descriptorForUtf8,
  hashCanonicalJson,
  type ContentDigest,
} from '@overeng/content-address'

import { NOTION_API_VERSION } from './config.ts'

export const BodyCompletenessEvidence = Schema.Literal('complete', 'lossy').annotations({
  identifier: 'NotionBodyEvidence.BodyCompleteness',
})
export type BodyCompletenessEvidence = typeof BodyCompletenessEvidence.Type

export const BodyEvidenceFingerprint = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand('NotionBodyEvidence.BodyEvidenceFingerprint'),
  Schema.annotations({ identifier: 'NotionBodyEvidence.BodyEvidenceFingerprint' }),
)
export type BodyEvidenceFingerprint = typeof BodyEvidenceFingerprint.Type

export const RemoteBodyObservationEvidence = Schema.TaggedStruct('RemoteBodyObservationEvidence', {
  schemaVersion: Schema.Literal(1),
  notionApiVersion: Schema.NonEmptyTrimmedString,
  pageId: Schema.NonEmptyTrimmedString,
  observedAt: Schema.DateTimeUtc,
  observationWindow: Schema.Struct({
    beforeLastEditedTime: Schema.DateTimeUtc,
    afterLastEditedTime: Schema.DateTimeUtc,
  }),
  endpointMarkdown: ContentDescriptor,
  blockTree: ContentDescriptor,
  renderedBody: ContentDescriptor,
  blockInventory: ContentDescriptor,
  completeness: BodyCompletenessEvidence,
}).annotations({ identifier: 'NotionBodyEvidence.RemoteBodyObservationEvidence' })
export type RemoteBodyObservationEvidence = typeof RemoteBodyObservationEvidence.Type

const RemoteBodyObservationIdentityEvidence = Schema.Struct({
  _tag: Schema.Literal('RemoteBodyObservationEvidence'),
  schemaVersion: Schema.Literal(1),
  notionApiVersion: Schema.NonEmptyTrimmedString,
  pageId: Schema.NonEmptyTrimmedString,
  observationWindow: Schema.Struct({
    beforeLastEditedTime: Schema.DateTimeUtc,
    afterLastEditedTime: Schema.DateTimeUtc,
  }),
  endpointMarkdown: ContentDescriptor,
  blockTree: ContentDescriptor,
  renderedBody: ContentDescriptor,
  blockInventory: ContentDescriptor,
  completeness: BodyCompletenessEvidence,
}).annotations({ identifier: 'NotionBodyEvidence.RemoteBodyObservationIdentityEvidence' })

const BlockInventoryEntryEvidence = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  hasChildren: Schema.Boolean,
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionBodyEvidence.BlockInventoryEntry' })

const BlockTreeEntryEvidence = Schema.Struct({
  depth: Schema.NonNegativeInt,
  id: Schema.String,
  type: Schema.String,
  hasChildren: Schema.Boolean,
  inTrash: Schema.Boolean,
}).annotations({ identifier: 'NotionBodyEvidence.BlockTreeEntry' })

const BlockInventoryEvidence = Schema.Struct({
  entries: Schema.Array(BlockInventoryEntryEvidence),
  renderedMarkdown: Schema.String,
}).annotations({ identifier: 'NotionBodyEvidence.BlockInventory' })

const BlockTreeEvidence = Schema.Struct({
  entries: Schema.Array(BlockTreeEntryEvidence),
}).annotations({ identifier: 'NotionBodyEvidence.BlockTree' })

export type BodyEvidenceBlockTree = ReadonlyArray<{
  readonly block: {
    readonly id: string
    readonly type: string
    readonly has_children: boolean
    readonly in_trash: boolean
  }
  readonly children: BodyEvidenceBlockTree
}>

const decodeEvidence = Schema.decodeUnknownSync(RemoteBodyObservationEvidence)
const decodeFingerprint = Schema.decodeUnknownSync(BodyEvidenceFingerprint)

const treeEntries = (
  tree: BodyEvidenceBlockTree,
  depth = 0,
): ReadonlyArray<typeof BlockTreeEntryEvidence.Type> =>
  tree.flatMap((node) => [
    {
      depth,
      id: node.block.id,
      type: node.block.type,
      hasChildren: node.block.has_children,
      inTrash: node.block.in_trash,
    },
    ...treeEntries(node.children, depth + 1),
  ])

export const fingerprintBodyEvidence = (
  evidence: RemoteBodyObservationEvidence,
): BodyEvidenceFingerprint => {
  const { observedAt: _observedAt, ...identityEvidence } = evidence
  return decodeFingerprint(
    hashCanonicalJson(RemoteBodyObservationIdentityEvidence, identityEvidence),
  )
}

export const makeRemoteBodyObservationEvidence = (opts: {
  readonly pageId: string
  readonly observedAt: string
  readonly beforeLastEditedTime: string
  readonly afterLastEditedTime: string
  readonly endpointMarkdown: string
  readonly blockTree: BodyEvidenceBlockTree
  readonly renderedMarkdown: string
  readonly inventoryEntries: ReadonlyArray<typeof BlockInventoryEntryEvidence.Type>
  readonly completeness: BodyCompletenessEvidence
  readonly notionApiVersion?: string
}): RemoteBodyObservationEvidence => {
  const blockInventory = {
    entries: opts.inventoryEntries,
    renderedMarkdown: opts.renderedMarkdown,
  }
  return decodeEvidence({
    _tag: 'RemoteBodyObservationEvidence',
    schemaVersion: 1,
    notionApiVersion: opts.notionApiVersion ?? NOTION_API_VERSION,
    pageId: opts.pageId,
    observedAt: opts.observedAt,
    observationWindow: {
      beforeLastEditedTime: opts.beforeLastEditedTime,
      afterLastEditedTime: opts.afterLastEditedTime,
    },
    endpointMarkdown: descriptorForUtf8({
      value: opts.endpointMarkdown,
      mediaType: 'text/markdown; charset=utf-8',
      codec: 'notion-enhanced-markdown',
      schemaVersion: 1,
    }),
    blockTree: descriptorForCanonicalJson({
      schema: BlockTreeEvidence,
      value: { entries: treeEntries(opts.blockTree) },
      schemaVersion: 1,
    }),
    renderedBody: descriptorForUtf8({
      value: opts.renderedMarkdown,
      mediaType: 'text/markdown; charset=utf-8',
      codec: 'notion-enhanced-markdown',
      schemaVersion: 1,
    }),
    blockInventory: descriptorForCanonicalJson({
      schema: BlockInventoryEvidence,
      value: blockInventory,
      schemaVersion: 1,
    }),
    completeness: opts.completeness,
  })
}

export const descriptorDigest = (descriptor: typeof ContentDescriptor.Type): ContentDigest =>
  descriptor.digest

export const bodyEvidenceDescriptorDefaults = {
  mediaType: canonicalJsonMediaType,
  codec: canonicalJsonCodec,
} as const
