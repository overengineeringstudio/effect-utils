export type BodyLossyReason =
  | 'endpoint_truncated'
  | 'unknown_blocks'
  | 'unsupported_blocks'
  | 'not_round_trip_safe_blocks'
  | 'rendered_markdown_unavailable'
  | 'rendered_markdown_has_unobserved_suffix'

export type BodyCompleteness =
  | {
      readonly _tag: 'complete'
    }
  | {
      readonly _tag: 'lossy'
      readonly reasons: readonly BodyLossyReason[]
      /**
       * The distinct block types that triggered a block-level lossy reason
       * (`unsupported_blocks` / `not_round_trip_safe_blocks`), sorted and
       * deduplicated. Empty/absent when the verdict is purely Markdown-level
       * (truncation, suffix, …). Surfaced so the refusal gate can name the
       * offending block class in its message and so a tree node can tolerate
       * its own `child_page` blocks without losing the other reasons. Optional
       * so older inline verdicts (e.g. `rendered_markdown_unavailable`) need not
       * restate it.
       */
      readonly lossyBlockTypes?: readonly string[]
    }

export interface MarkdownBodySnapshot {
  readonly markdown: string
  readonly truncated: boolean
  readonly unknownBlockIds: readonly string[]
}

export interface BlockInventoryEntry {
  readonly id: string
  readonly type: string
  readonly hasChildren: boolean
  readonly inTrash: boolean
}

export interface BlockInventory {
  readonly entries: readonly BlockInventoryEntry[]
  /**
   * Markdown rendered from the block tree through an independent renderer.
   * This is diagnostic evidence, not the canonical body by itself.
   */
  readonly renderedMarkdown?: string
}

export interface BodyFidelityObservation {
  readonly markdown: MarkdownBodySnapshot
  readonly inventory: BlockInventory
  readonly completeness: BodyCompleteness
}

const unsupportedBlockTypes = new Set(['unsupported'])

/**
 * Notion block types whose body-Markdown rendering does **not** reparse to the
 * same block on push (R38, decisions 0016/0017). They render to Markdown that
 * Notion's parser re-creates as a plain paragraph (or drops), so a
 * `replace_content` over them silently destroys the original block — the live
 * data-loss defect in #785. A page containing any of these is refused at the
 * pull on every surface (`cat`/`put`/`edit`/file `sync`).
 *
 * Criterion is a curated type set rather than a live reparse check on purpose:
 * `@overeng/notion-core` is pure and carries no Markdown parser, and for these
 * blocks the endpoint Markdown and the independently rendered Markdown already
 * *agree* (both emit `[TOC]`, `[embedded db]()`, …), so the existing
 * `hasUnobservedRenderedSuffix` heuristic cannot catch them. The set is the
 * principled encoding of "known not round-trip-safe in the body" the platform
 * permits (impl-delta Group C; R38 explicitly sanctions a known-lossy type set
 * where a reparse check isn't practical).
 *
 * `child_page` is included here as a *body* block (R30: a child-page block in
 * the body is refused). It has a dual role: a child page that is a tree node
 * (its own `.nmd` file) is legitimately managed by the file tree engine, so the
 * refusal gate tolerates `child_page` for tree nodes via
 * `tolerateTreeChildPages` while still refusing it for single-page surfaces and
 * still refusing any *other* lossy block on the same page.
 *
 * Hosted/external media (`image`/`video`/`audio`/`file`/`pdf`) is deliberately
 * absent: media is representable and stays editable; only its URL is volatile
 * (decision 0007, Group B).
 */
const notRoundTripSafeBlockTypes = new Set([
  'child_database',
  'table_of_contents',
  'synced_block',
  'child_page',
  'breadcrumb',
  'bookmark',
  'embed',
  'link_preview',
  'link_to_page',
])

const TREE_TOLERATED_BLOCK_TYPE = 'child_page'

const normalizeLines = (value: string): string => value.replace(/\r\n?/gu, '\n').trimEnd()

const normalizeComparableMarkdown = (value: string): string =>
  normalizeLines(value)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()

const hasUnobservedRenderedSuffix = (opts: {
  readonly observedMarkdown: string
  readonly renderedMarkdown: string | undefined
}): boolean => {
  if (opts.renderedMarkdown === undefined) return false
  const observed = normalizeComparableMarkdown(opts.observedMarkdown)
  const rendered = normalizeComparableMarkdown(opts.renderedMarkdown)

  if (rendered === '' || observed === rendered) return false
  if (observed === '') return true
  if (rendered.startsWith(observed) === false) return false

  const suffix = rendered.slice(observed.length).trim()
  return suffix.length > 0
}

const unique = <A>(values: readonly A[]): readonly A[] => [...new Set(values)]

export const classifyBodyCompleteness = (opts: {
  readonly markdown: MarkdownBodySnapshot
  readonly inventory: BlockInventory
}): BodyCompleteness => {
  const reasons: BodyLossyReason[] = []
  const lossyBlockTypes: string[] = []

  if (opts.markdown.truncated === true) reasons.push('endpoint_truncated')
  if (opts.markdown.unknownBlockIds.length > 0) reasons.push('unknown_blocks')

  const blockTypes = unique(opts.inventory.entries.map((entry) => entry.type))
  const unsupportedTypes = blockTypes.filter((type) => unsupportedBlockTypes.has(type))
  const notRoundTripSafeTypes = blockTypes.filter((type) => notRoundTripSafeBlockTypes.has(type))

  if (unsupportedTypes.length > 0) {
    reasons.push('unsupported_blocks')
    lossyBlockTypes.push(...unsupportedTypes)
  }
  if (notRoundTripSafeTypes.length > 0) {
    reasons.push('not_round_trip_safe_blocks')
    lossyBlockTypes.push(...notRoundTripSafeTypes)
  }
  if (
    hasUnobservedRenderedSuffix({
      observedMarkdown: opts.markdown.markdown,
      renderedMarkdown: opts.inventory.renderedMarkdown,
    }) === true
  ) {
    reasons.push('rendered_markdown_has_unobserved_suffix')
  }

  return reasons.length === 0
    ? { _tag: 'complete' }
    : {
        _tag: 'lossy',
        reasons: unique(reasons),
        lossyBlockTypes: unique(lossyBlockTypes).toSorted(),
      }
}

/**
 * Re-evaluate a completeness verdict for a **tree node** (a child page that is
 * its own `.nmd` file): the node's own `child_page` blocks are managed by the
 * file tree engine (re-emitted as `<page>` anchors and stripped before
 * comparison, R12/R30), so they must not refuse the parent. Every *other* lossy
 * reason — including a real `table_of_contents`/`synced_block`/… on the same
 * page, truncation, unknown blocks, or a suffix mismatch — is preserved, so
 * this never reopens #785 on the tree path.
 *
 * Tolerating means: drop `child_page` from `lossyBlockTypes`, and drop the
 * `not_round_trip_safe_blocks` reason only if that was the *sole* not-round-
 * trip-safe block. A verdict that stays lossy keeps its remaining reasons.
 */
export const tolerateTreeChildPages = (completeness: BodyCompleteness): BodyCompleteness => {
  if (completeness._tag === 'complete') return completeness

  const remainingTypes = (completeness.lossyBlockTypes ?? []).filter(
    (type) => type !== TREE_TOLERATED_BLOCK_TYPE,
  )

  // If `child_page` was the only block-level lossy type, the
  // `not_round_trip_safe_blocks` reason no longer applies (it could only have
  // been raised by a not-round-trip-safe type; `unsupported` keeps its own
  // reason). Keep it whenever another not-round-trip-safe type remains.
  const droppedNotRoundTripSafe =
    completeness.reasons.includes('not_round_trip_safe_blocks') === true &&
    remainingTypes.some((type) => notRoundTripSafeBlockTypes.has(type)) === false

  const reasons = droppedNotRoundTripSafe
    ? completeness.reasons.filter((reason) => reason !== 'not_round_trip_safe_blocks')
    : completeness.reasons

  return reasons.length === 0
    ? { _tag: 'complete' }
    : { _tag: 'lossy', reasons, lossyBlockTypes: remainingTypes }
}

/**
 * Human-facing refusal message for a lossy verdict (R30/R38). Names the
 * offending block class(es) when known and points the user to the Notion UI —
 * shared so every surface (`cat`/`put`/`edit`/file `sync`/tree) refuses with the
 * same wording. `context` distinguishes the call site (clean base, push, …)
 * without changing the user-facing meaning.
 */
export const describeBodyLossyRefusal = (opts: {
  readonly pageId: string
  readonly completeness: Extract<BodyCompleteness, { readonly _tag: 'lossy' }>
  readonly context: string
}): string => {
  const lossyBlockTypes = opts.completeness.lossyBlockTypes ?? []
  const blocks =
    lossyBlockTypes.length > 0
      ? ` containing not-losslessly-representable block(s): ${lossyBlockTypes.join(', ')}`
      : ''
  return (
    `Remote Markdown body for page ${opts.pageId} is lossy (${opts.completeness.reasons.join(', ')})${blocks}; ` +
    `${opts.context}. Edit such blocks in the Notion UI.`
  )
}

export const stableBodyFidelityStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value) === true) return `[${value.map(stableBodyFidelityStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableBodyFidelityStringify(record[key])}`)
    .join(',')}}`
}
