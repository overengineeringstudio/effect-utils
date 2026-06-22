import { Schema } from 'effect'

import {
  ContentDescriptor,
  descriptorForCanonicalJson,
  descriptorForUtf8,
  hashCanonicalJson,
  type ContentDigest,
} from '@overeng/content-address'

import { NOTION_API_VERSION } from './config.ts'

const BodyCompletenessEvidence = Schema.Literal('complete', 'lossy').annotations({
  identifier: 'NotionBodyEvidence.BodyCompleteness',
})
type BodyCompletenessEvidence = typeof BodyCompletenessEvidence.Type

/** `sha256:<hex>` branded fingerprint of a body observation's identity evidence (excludes `observedAt`, so re-observing unchanged content yields the same value). */
export const BodyEvidenceFingerprint = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand('NotionBodyEvidence.BodyEvidenceFingerprint'),
  Schema.annotations({ identifier: 'NotionBodyEvidence.BodyEvidenceFingerprint' }),
)
export type BodyEvidenceFingerprint = typeof BodyEvidenceFingerprint.Type

/** Content-addressed evidence for one remote page body observation: endpoint markdown, block tree, rendered body, and inventory as content descriptors plus the stability window. */
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

const RemoteBodyObservationIdentityEvidence = Schema.TaggedStruct('RemoteBodyObservationEvidence', {
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

type BodyEvidenceBlockTree = ReadonlyArray<{
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

const treeEntries = ({
  tree,
  depth = 0,
}: {
  tree: BodyEvidenceBlockTree
  depth?: number
}): ReadonlyArray<typeof BlockTreeEntryEvidence.Type> =>
  tree.flatMap((node) => [
    {
      depth,
      id: node.block.id,
      type: node.block.type,
      hasChildren: node.block.has_children,
      inTrash: node.block.in_trash,
    },
    ...treeEntries({ tree: node.children, depth: depth + 1 }),
  ])

/** Computes the identity fingerprint of an evidence record by hashing its canonical JSON with the volatile `observedAt` stripped. */
export const fingerprintBodyEvidence = (
  evidence: RemoteBodyObservationEvidence,
): BodyEvidenceFingerprint => {
  const { observedAt: _observedAt, ...identityEvidence } = evidence
  return decodeFingerprint(
    hashCanonicalJson({ schema: RemoteBodyObservationIdentityEvidence, value: identityEvidence }),
  )
}

/** Builds a `RemoteBodyObservationEvidence` from raw observation inputs, deriving content descriptors and defaulting `notionApiVersion` to the client's pinned version. */
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
      value: { entries: treeEntries({ tree: opts.blockTree }) },
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

/** Extracts the content digest from a content descriptor, e.g. to compare evidence descriptors without their codec/media-type metadata. */
export const descriptorDigest = (descriptor: ContentDescriptor): ContentDigest =>
  descriptor.digest
