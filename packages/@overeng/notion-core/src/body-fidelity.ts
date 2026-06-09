export type BodyLossyReason =
  | 'endpoint_truncated'
  | 'unknown_blocks'
  | 'unsupported_blocks'
  | 'rendered_markdown_unavailable'
  | 'rendered_markdown_has_unobserved_suffix'

export type BodyCompleteness =
  | {
      readonly _tag: 'complete'
    }
  | {
      readonly _tag: 'lossy'
      readonly reasons: readonly BodyLossyReason[]
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

  if (opts.markdown.truncated === true) reasons.push('endpoint_truncated')
  if (opts.markdown.unknownBlockIds.length > 0) reasons.push('unknown_blocks')
  if (opts.inventory.entries.some((entry) => unsupportedBlockTypes.has(entry.type)) === true) {
    reasons.push('unsupported_blocks')
  }
  if (
    hasUnobservedRenderedSuffix({
      observedMarkdown: opts.markdown.markdown,
      renderedMarkdown: opts.inventory.renderedMarkdown,
    }) === true
  ) {
    reasons.push('rendered_markdown_has_unobserved_suffix')
  }

  return reasons.length === 0 ? { _tag: 'complete' } : { _tag: 'lossy', reasons: unique(reasons) }
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
