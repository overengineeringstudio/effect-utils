/**
 * Readback-normalization oracle (spike).
 *
 * Answers one question: does the server-observed block tree of a page match
 * what a JSX element renders to, in the same hash space? Both sides are folded
 * into a canonical `NormalizedReadbackNode` tree and hashed with the package's
 * shared `hashStable` (djb2 over stable-stringify), so
 * `observed.hash === candidate.hash` iff the page content is semantically
 * identical to the render.
 *
 * Why a canonicalization layer is required (and why the raw candidate
 * `CandidateNode.hash` cannot be compared against readback directly): the
 * cache hash is computed over the REQUEST-shape projected props, while the
 * API returns RESPONSE-shape blocks — extra `plain_text` / `href` fields,
 * always-explicit `color` / `is_toggleable` defaults, and rich-text runs that
 * Notion may re-segment (merge adjacent identical frames, drop empty spans).
 * Both sides therefore map into one canonical form:
 *   - rich-text runs get fully explicit annotation frames, empty runs are
 *     dropped, and adjacent runs with identical (link, annotations) coalesce;
 *   - omitted-with-default fields (`color`, `is_toggleable`) become explicit;
 *   - callout icons are compared exactly when the JSX claimed one, and are
 *     provider-owned (masked to `null` on both sides) when the JSX omitted
 *     the `icon` prop — Notion injects a default icon the author never wrote.
 *
 * Spike scope: paragraph, heading_2, bulleted_list_item, callout. Text-only
 * rich text (no mention/equation leaves).
 */
import type { CandidateNode, CandidateTree } from './sync-diff.ts'
import { hashStable } from './sync-diff.ts'

type Json = Record<string, unknown>

/** Fully explicit annotation frame used for canonical comparison. */
export interface ReadbackAnnotations {
  readonly bold: boolean
  readonly italic: boolean
  readonly strikethrough: boolean
  readonly underline: boolean
  readonly code: boolean
  readonly color: string
}

/** One canonical rich-text run: adjacent identical frames are coalesced. */
export interface ReadbackRun {
  readonly text: string
  readonly link: string | null
  readonly annotations: ReadbackAnnotations
}

/** One canonical block node — the unit both hash sides agree on. */
export interface NormalizedReadbackNode {
  readonly type: string
  readonly props: Json
  readonly children: readonly NormalizedReadbackNode[]
}

/**
 * Server-observed block plus its (separately retrieved) children. The block
 * JSON is the public API response shape: `{ type, [type]: body, ... }`.
 */
export interface ObservedBlockTree {
  readonly block: Json
  readonly children: readonly ObservedBlockTree[]
}

const READBACK_SUPPORTED = new Set(['paragraph', 'heading_2', 'bulleted_list_item', 'callout'])

const defaultAnnotations: ReadbackAnnotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
}

/**
 * Canonicalize a `rich_text` array from EITHER side. Request-shape items
 * (candidate props) and response-shape items (readback) both carry
 * `{ type: 'text', text: { content, link }, annotations }`; response items
 * additionally carry `plain_text` / `href`, which are derived and dropped.
 */
const normalizeRichText = (value: unknown, path: string): readonly ReadbackRun[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path}: rich_text must be an array`)
  const out: ReadbackRun[] = []
  for (const [index, raw] of value.entries()) {
    const item = raw as {
      readonly type?: unknown
      readonly text?: { readonly content?: unknown; readonly link?: { readonly url?: unknown } | null }
      readonly annotations?: Partial<ReadbackAnnotations>
    }
    if (item.type !== 'text' || typeof item.text?.content !== 'string') {
      throw new Error(`${path}/rich_text[${index}]: unsupported non-text rich text`)
    }
    // Zero-length runs carry no semantics: the reconciler can emit them at
    // inline-component boundaries and Notion omits them on readback.
    if (item.text.content === '') continue
    const link = item.text.link == null ? null : item.text.link.url
    if (link !== null && typeof link !== 'string') {
      throw new Error(`${path}/rich_text[${index}]: malformed link`)
    }
    const annotations: ReadbackAnnotations = { ...defaultAnnotations, ...item.annotations }
    const previous = out.at(-1)
    if (
      previous !== undefined &&
      previous.link === link &&
      JSON.stringify(previous.annotations) === JSON.stringify(annotations)
    ) {
      out[out.length - 1] = { ...previous, text: `${previous.text}${item.text.content}` }
    } else {
      out.push({ text: item.text.content, link, annotations })
    }
  }
  return out
}

/** Canonical callout icon: the two request/response envelopes the spike supports. */
const normalizeCalloutIcon = (icon: unknown, path: string): Json | null => {
  if (icon == null) return null
  const env = icon as Json
  if (env.type === 'emoji' && typeof env.emoji === 'string') {
    return { type: 'emoji', emoji: env.emoji }
  }
  if (env.type === 'external' && typeof (env.external as Json | undefined)?.url === 'string') {
    return { type: 'external', external: { url: (env.external as Json).url } }
  }
  throw new Error(`${path}: unsupported callout icon`)
}

/**
 * Fold one block body (request- or response-shape — they share the fields the
 * canonical form keeps) into canonical props for its type.
 */
const normalizeBody = (type: string, body: Json, path: string): Json => {
  if (!READBACK_SUPPORTED.has(type)) {
    throw new Error(`${path}: readback normalization not implemented for ${type}`)
  }
  const richText = normalizeRichText(body.rich_text, path)
  const color = typeof body.color === 'string' ? body.color : 'default'
  if (type === 'heading_2') {
    return { rich_text: richText, color, is_toggleable: body.is_toggleable === true }
  }
  if (type === 'callout') {
    return { rich_text: richText, color, icon: normalizeCalloutIcon(body.icon, path) }
  }
  return { rich_text: richText, color }
}

/** Normalize a server-observed block tree into canonical nodes. */
export const normalizeObserved = (
  observed: readonly ObservedBlockTree[],
  path = 'page',
): readonly NormalizedReadbackNode[] =>
  observed.map(({ block, children }, index) => {
    const type = block.type
    if (typeof type !== 'string') throw new Error(`${path}[${index}]: block lacks a type`)
    const body = block[type]
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new Error(`${path}[${index}]: missing ${type} payload`)
    }
    const nodePath = `${path}/${type}[${index}]`
    return {
      type,
      props: normalizeBody(type, body as Json, nodePath),
      children: normalizeObserved(children, nodePath),
    }
  })

/** Normalize a rendered candidate tree into the same canonical nodes. */
export const normalizeCandidate = (
  nodes: readonly CandidateNode[],
  path = 'page',
): readonly NormalizedReadbackNode[] =>
  nodes.map((node, index) => {
    const nodePath = `${path}/${node.type}[${index}]`
    return {
      type: node.type,
      props: normalizeBody(node.type, node.props, nodePath),
      children: normalizeCandidate(node.children, nodePath),
    }
  })

/**
 * Blank provider-owned fields on the observed side. Today that is exactly one
 * field: a callout icon the JSX never claimed (candidate `icon` prop omitted
 * → canonical `icon: null`) is supplied by Notion with a default the author
 * does not manage — mask it back to `null` so it cannot fail the comparison.
 * Explicit JSX icons stay exact managed content.
 */
const maskProviderOwned = (
  candidate: readonly NormalizedReadbackNode[],
  observed: readonly NormalizedReadbackNode[],
): readonly NormalizedReadbackNode[] =>
  observed.map((node, index) => {
    const authored = candidate[index]
    const children = maskProviderOwned(authored?.children ?? [], node.children)
    const providerOwnedIcon =
      node.type === 'callout' && authored?.type === 'callout' && authored.props.icon === null
    return providerOwnedIcon
      ? { ...node, props: { ...node.props, icon: null }, children }
      : { ...node, children }
  })

/** Hash a canonical tree — shares `hashStable` with the candidate/cache hashes. */
export const readbackHash = (nodes: readonly NormalizedReadbackNode[]): string => hashStable(nodes)

export interface ReadbackComparison {
  readonly candidateHash: string
  readonly observedHash: string
  readonly equal: boolean
  readonly candidate: readonly NormalizedReadbackNode[]
  readonly observed: readonly NormalizedReadbackNode[]
}

/**
 * Compare a rendered candidate against a server observation of the same page.
 * `equal` (equivalently `candidateHash === observedHash`) certifies the page's
 * managed content matches the render — the readback half of a publication
 * verification, complementing `plan()`'s cache-side fixpoint.
 */
export const compareReadback = ({
  candidate,
  observed,
}: {
  readonly candidate: CandidateTree
  readonly observed: readonly ObservedBlockTree[]
}): ReadbackComparison => {
  const cand = normalizeCandidate(candidate.children)
  const obs = maskProviderOwned(cand, normalizeObserved(observed))
  const candidateHash = readbackHash(cand)
  const observedHash = readbackHash(obs)
  return { candidateHash, observedHash, equal: candidateHash === observedHash, candidate: cand, observed: obs }
}
