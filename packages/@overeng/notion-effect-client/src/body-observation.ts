import { Effect, Schema } from 'effect'
import type { HttpClient } from 'effect/http/HttpClient'

import {
  classifyBodyCompleteness,
  type BlockInventory,
  type BlockInventoryEntry,
  type BodyCompleteness,
} from '@overeng/notion-core'
import type { PageMarkdown } from '@overeng/notion-effect-schema'

import { NotionBlocks, type BlockTree } from './blocks.ts'
import {
  fingerprintBodyEvidence,
  makeRemoteBodyObservationEvidence,
  type BodyEvidenceFingerprint,
  type RemoteBodyObservationEvidence,
} from './body-evidence.ts'
import { canonicalizeBlockMarkdown } from './canonical-markdown.ts'
import type { NotionConfig } from './config.ts'
import type { NotionApiError } from './error.ts'
import { NotionMarkdown } from './markdown.ts'
import { NotionPages } from './pages.ts'

/** One observed page body: rendered markdown, block inventory, completeness, and the evidence + fingerprint that pin this observation. */
export interface NotionBodyObservation {
  readonly pageId: string
  readonly markdown: {
    readonly markdown: string
    readonly truncated: boolean
    readonly unknownBlockIds: readonly string[]
  }
  readonly inventory: BlockInventory
  readonly completeness: BodyCompleteness
  readonly evidence: RemoteBodyObservationEvidence
  readonly evidenceFingerprint: BodyEvidenceFingerprint
}

/** Raised when a live body observation cannot find a stable page metadata window. */
export class NotionBodyObservationChangedError extends Schema.TaggedError<NotionBodyObservationChangedError>()(
  'NotionBodyObservationChangedError',
  {
    pageId: Schema.String,
    attempts: Schema.Int,
    beforeLastEditedTime: Schema.String,
    afterLastEditedTime: Schema.String,
    message: Schema.String,
  },
) {}

const NOTION_BODY_OBSERVATION_ATTEMPTS = 3

const inventoryEntries = (tree: BlockTree): readonly BlockInventoryEntry[] => {
  const entries: BlockInventoryEntry[] = []
  const visit = (nodes: BlockTree): void => {
    for (const node of nodes) {
      entries.push({
        id: node.block.id,
        type: node.block.type,
        hasChildren: node.block.has_children,
        inTrash: node.block.in_trash,
      })
      visit(node.children)
    }
  }
  visit(tree)
  return entries
}

/**
 * Check native type coverage independently of endpoint flags. Counts prevent a
 * surviving construct from hiding another flattened construct of the same type.
 * This does not claim full attribute equivalence.
 */
const classifyRenderedTypes = (opts: {
  readonly tree: BlockTree
  readonly renderedMarkdown: string
  readonly completeness: BodyCompleteness
}): BodyCompleteness => {
  const requirements = new Map<string, { count: number; types: Set<string> }>()
  const unsupportedTypes = new Set<string>()
  const requireTag = (tag: string, type: string): void => {
    const requirement = requirements.get(tag)
    if (requirement === undefined) requirements.set(tag, { count: 1, types: new Set([type]) })
    else {
      requirement.count += 1
      requirement.types.add(type)
    }
  }
  const visitRichText = (value: unknown, type: string): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value) === true) {
      for (const item of value) visitRichText(item, type)
      return
    }
    if ('type' in value && value.type === 'mention' && 'mention' in value) {
      const mention = value.mention
      if (mention !== null && typeof mention === 'object' && 'type' in mention) {
        if (
          mention.type === 'page' || mention.type === 'database' ||
          mention.type === 'date' || mention.type === 'user'
        ) {
          requireTag(`mention-${mention.type}`, type)
        } else {
          unsupportedTypes.add(type)
        }
      }
    }
    for (const child of Object.values(value)) visitRichText(child, type)
  }
  const visit = (tree: BlockTree): void => {
    for (const node of tree) {
      const type = node.block.type
      if (NotionMarkdown.supportsBlockType(type) === false) unsupportedTypes.add(type)
      if (type === 'callout' && 'callout' in node.block) {
        const callout = node.block.callout
        if (callout !== null && typeof callout === 'object' && 'icon' in callout) {
          const icon = callout.icon
          if (icon !== null && typeof icon === 'object' && 'type' in icon && icon.type !== 'emoji') {
            unsupportedTypes.add(type)
          }
        }
      }
      if (
        type === 'callout' || type === 'table' || type === 'video' ||
        type === 'audio' || type === 'file' || type === 'pdf'
      ) requireTag(type, type)
      if (type === 'table_row') requireTag('tr', type)
      if (type === 'toggle') requireTag('details', type)
      visitRichText(node.block, type)
      visit(node.children)
    }
  }
  visit(opts.tree)
  // Code examples cannot supply evidence that a real construct survived.
  const body = opts.renderedMarkdown
    .replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gmu, '')
    .replace(/(`+)[^\n]*?\1/gu, '')
  const counts = new Map<string, number>()
  for (const match of body.matchAll(
    /<(callout|table|tr|details|video|audio|file|pdf|mention-page|mention-database|mention-date|mention-user)(?=[\s/>])/gu,
  )) {
    const tag = match[1]!
    counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  const missingTypes = new Set<string>()
  for (const [tag, requirement] of requirements) {
    if ((counts.get(tag) ?? 0) < requirement.count) {
      for (const type of requirement.types) missingTypes.add(type)
    }
  }
  if (missingTypes.size === 0 && unsupportedTypes.size === 0) return opts.completeness
  return {
    _tag: 'lossy',
    reasons: [
      ...new Set([
        ...(opts.completeness._tag === 'lossy' ? opts.completeness.reasons : []),
        ...(missingTypes.size === 0 ? [] : ['rendered_markdown_missing_types' as const]),
        ...(unsupportedTypes.size === 0 ? [] : ['unsupported_blocks' as const]),
      ]),
    ],
    lossyBlockTypes: [
      ...new Set([
        ...(opts.completeness._tag === 'lossy' ? opts.completeness.lossyBlockTypes ?? [] : []),
        ...missingTypes,
        ...unsupportedTypes,
      ]),
    ].toSorted(),
  }
}

/** Builds an observation from already-fetched markdown + block-tree snapshots; canonicalizes the rendered body once so evidence, classifier, and fingerprint see identical bytes (decision 0019). */
export const observeFromSnapshots = Effect.fn('NotionBody.observeFromSnapshots')(function* (opts: {
  readonly pageId: string
  readonly markdown: PageMarkdown
  readonly tree: BlockTree
  readonly observedAt?: string
  readonly beforeLastEditedTime?: string
  readonly afterLastEditedTime?: string
}) {
  /*
   * Canonicalize the rendered body once, at the source, before it flows into
   * the inventory, the fidelity classifier, and the evidence fingerprint — so
   * the evidence, the classifier, pull, hash, and push all see the same
   * canonical bytes (decision 0019, "agree by construction"). The renderer
   * emits parseable-not-canonical Markdown (it joins sibling blocks with `\n\n`);
   * this is the single place that turns that into the one canonical form.
   */
  const renderedMarkdown = canonicalizeBlockMarkdown(
    yield* NotionMarkdown.treeToMarkdown({ tree: opts.tree }),
  )
  const markdown = {
    markdown: opts.markdown.markdown,
    truncated: opts.markdown.truncated,
    unknownBlockIds: opts.markdown.unknown_block_ids,
  }
  const inventory = {
    entries: inventoryEntries(opts.tree),
    renderedMarkdown,
  }
  const completeness = classifyRenderedTypes({
    tree: opts.tree,
    renderedMarkdown,
    completeness: classifyBodyCompleteness({ markdown, inventory }),
  })
  const observedAt = opts.observedAt ?? new Date().toISOString()
  const evidence = makeRemoteBodyObservationEvidence({
    pageId: opts.pageId,
    observedAt,
    beforeLastEditedTime: opts.beforeLastEditedTime ?? observedAt,
    afterLastEditedTime: opts.afterLastEditedTime ?? observedAt,
    endpointMarkdown: markdown.markdown,
    blockTree: opts.tree,
    renderedMarkdown,
    inventoryEntries: inventory.entries,
    completeness: completeness._tag,
  })
  return {
    pageId: opts.pageId,
    markdown,
    inventory,
    completeness,
    evidence,
    evidenceFingerprint: fingerprintBodyEvidence(evidence),
  }
})

const observe = Effect.fn('NotionBody.observe')(function* (opts: { readonly pageId: string }) {
  return yield* observeStable({ pageId: opts.pageId, attempt: 0 })
})

const observeStable = (opts: {
  readonly pageId: string
  readonly attempt: number
}): Effect.Effect<
  NotionBodyObservation,
  NotionApiError | NotionBodyObservationChangedError,
  NotionConfig | HttpClient
> =>
  Effect.gen(function* () {
    const before = yield* NotionPages.retrieve({ pageId: opts.pageId })
    const markdown = yield* NotionPages.getMarkdown({ pageId: opts.pageId })
    const tree = yield* NotionBlocks.retrieveAsTree({ blockId: opts.pageId })
    const after = yield* NotionPages.retrieve({ pageId: opts.pageId })

    if (before.last_edited_time === after.last_edited_time) {
      return yield* observeFromSnapshots({
        pageId: opts.pageId,
        markdown,
        tree,
        observedAt: new Date().toISOString(),
        beforeLastEditedTime: before.last_edited_time,
        afterLastEditedTime: after.last_edited_time,
      })
    }

    if (opts.attempt + 1 < NOTION_BODY_OBSERVATION_ATTEMPTS) {
      return yield* observeStable({ pageId: opts.pageId, attempt: opts.attempt + 1 })
    }

    return yield* new NotionBodyObservationChangedError({
      pageId: opts.pageId,
      attempts: NOTION_BODY_OBSERVATION_ATTEMPTS,
      beforeLastEditedTime: before.last_edited_time,
      afterLastEditedTime: after.last_edited_time,
      message: `Notion page body changed while observing page ${opts.pageId}; all ${NOTION_BODY_OBSERVATION_ATTEMPTS} observation attempts were unstable.`,
    })
  })

/** Live body-observation entry point: `observe` re-fetches a page until its metadata window is stable; `observeFromSnapshots` works from pre-fetched snapshots. */
export const NotionBody = {
  observe,
  observeFromSnapshots,
  classifyRenderedTypes,
} as const
