/**
 * Readback-normalization oracle.
 *
 * Answers one question: does the server-observed state of a page match what a
 * JSX element renders to, in the same hash space? Both sides are folded into a
 * canonical `NormalizedReadbackNode` tree and hashed with the package's shared
 * `hashStable` (djb2 over stable-stringify), so
 * `observed.hash === candidate.hash` iff the page content is semantically
 * identical to the render.
 *
 * ## Readback hashes are a SEPARATE hash space from `CacheNode.hash`
 *
 * The cache hash (`CandidateNode.hash` / `CacheNode.hash`) is computed over
 * the REQUEST-shape projected props, while the API returns RESPONSE-shape
 * blocks — extra `plain_text` / `href` fields, always-explicit
 * `color` / `is_toggleable` defaults, and rich-text runs that Notion may
 * re-segment (merge adjacent identical frames, drop empty spans). The two
 * spaces share `hashStable` as the underlying hash function but hash
 * DIFFERENT canonical forms: a readback hash never equals a cache hash for
 * the same content, and unifying them would change the cache hash function
 * and invalidate every deployed cache. Never compare a `CacheNode.hash`
 * against a readback hash — compare readback hashes against readback hashes.
 *
 * ## No context-free observed hash
 *
 * Provider-owned masking (below) requires the candidate side: whether a
 * field on the observed block is managed content or server noise depends on
 * whether the JSX claimed it. A standalone `hashObserved(blocks)` therefore
 * cannot exist — the public API takes both sides.
 *
 * ## Canonicalization rules
 *
 * - rich-text runs get fully explicit annotation frames, empty text runs are
 *   dropped, and adjacent text runs with identical (link, annotations)
 *   coalesce; mention / equation leaves normalize their envelopes (derived
 *   `plain_text` / `href` / expanded user objects are dropped);
 * - omitted-with-default fields (`color`, `is_toggleable`, `checked`,
 *   `has_column_header`, `has_row_header`, captions) become explicit;
 * - provider-owned-when-unclaimed fields (callout `icon`, code `language`,
 *   column `width_ratio`, table `table_width`) are compared exactly when the
 *   JSX claimed them and masked to `null` on both sides when it did not —
 *   Notion injects defaults the author never wrote;
 * - uploaded media sources (`file_upload` on the request, `file` with an
 *   expiring signed URL on the response) are masked to an `uploaded`
 *   sentinel — the bytes are not verifiable through block JSON, so uploaded
 *   media compare by position, type, and caption only;
 * - `child_page` blocks are an identity boundary: only the title is compared
 *   and children are NOT recursed into — a sub-page's content is its own
 *   page and gets its own `compareReadback` / `compareReadbackPage` pass.
 *
 * Raw escape-hatch blocks (`<Raw>`, `template`, `link_preview`,
 * `synced_block`, `child_database`, `breadcrumb`, ...) are not supported:
 * their payloads are opaque request-shape passthroughs, so the response-shape
 * delta cannot be normalized generically. Normalization throws on them.
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

/**
 * One canonical rich-text run. Text runs coalesce with adjacent
 * identical-frame text runs; mention and equation leaves never coalesce.
 */
export type ReadbackRun =
  | {
      readonly kind: 'text'
      readonly text: string
      readonly link: string | null
      readonly annotations: ReadbackAnnotations
    }
  | {
      readonly kind: 'mention'
      readonly mention: Json
      readonly annotations: ReadbackAnnotations
    }
  | {
      readonly kind: 'equation'
      readonly expression: string
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
 * Produced by `observeBlockTree` (readback-observe.ts) or any equivalent
 * `blocks.children` walk.
 */
export interface ObservedBlockTree {
  readonly block: Json
  readonly children: readonly ObservedBlockTree[]
}

const defaultAnnotations: ReadbackAnnotations = {
  bold: false,
  italic: false,
  strikethrough: false,
  underline: false,
  code: false,
  color: 'default',
}

/** Case/dash-insensitive canonical form for Notion ids (page/block UUIDs). */
const normalizeUuid = (id: string): string => id.toLowerCase().replaceAll('-', '')

/**
 * Canonicalize a mention envelope from either side. Notion expands referenced
 * objects on the response (`user` mentions come back with name/avatar, `date`
 * mentions with explicit `null` fields), while the request carries minimal
 * refs — reduce both to the mention type plus a minimal reference: `{ id }`
 * when the inner object carries one, otherwise the inner object with
 * `null`-valued keys dropped.
 */
const normalizeMention = (mention: unknown, path: string): Json => {
  if (typeof mention !== 'object' || mention === null) {
    throw new Error(`${path}: malformed mention envelope`)
  }
  const env = mention as Json
  const type = env.type
  if (typeof type !== 'string') throw new Error(`${path}: mention lacks a type`)
  const inner = env[type]
  if (typeof inner !== 'object' || inner === null) return { type }
  const rec = inner as Json
  if (typeof rec.id === 'string') return { type, [type]: { id: normalizeUuid(rec.id) } }
  const compact: Json = {}
  for (const [k, v] of Object.entries(rec)) {
    if (v !== null && v !== undefined) compact[k] = v
  }
  return { type, [type]: compact }
}

/**
 * Canonicalize a `rich_text` array from EITHER side. Request-shape items
 * (candidate props) and response-shape items (readback) share
 * `{ type, [type]: body, annotations }`; response items additionally carry
 * `plain_text` / `href`, which are derived and dropped.
 */
const normalizeRichText = (value: unknown, path: string): readonly ReadbackRun[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${path}: rich_text must be an array`)
  const out: ReadbackRun[] = []
  for (const [index, raw] of value.entries()) {
    const item = raw as {
      readonly type?: unknown
      readonly text?: {
        readonly content?: unknown
        readonly link?: { readonly url?: unknown } | null
      }
      readonly mention?: unknown
      readonly equation?: { readonly expression?: unknown }
      readonly annotations?: Partial<ReadbackAnnotations>
    }
    const annotations: ReadbackAnnotations = { ...defaultAnnotations, ...item.annotations }
    if (item.type === 'mention') {
      out.push({
        kind: 'mention',
        mention: normalizeMention(item.mention, `${path}/rich_text[${index}]`),
        annotations,
      })
      continue
    }
    if (item.type === 'equation') {
      if (typeof item.equation?.expression !== 'string') {
        throw new Error(`${path}/rich_text[${index}]: malformed equation leaf`)
      }
      out.push({ kind: 'equation', expression: item.equation.expression, annotations })
      continue
    }
    if (item.type !== 'text' || typeof item.text?.content !== 'string') {
      throw new Error(`${path}/rich_text[${index}]: unsupported rich text leaf`)
    }
    // Zero-length runs carry no semantics: the reconciler can emit them at
    // inline-component boundaries and Notion omits them on readback.
    if (item.text.content === '') continue
    const link = item.text.link == null ? null : item.text.link.url
    if (link !== null && typeof link !== 'string') {
      throw new Error(`${path}/rich_text[${index}]: malformed link`)
    }
    const previous = out.at(-1)
    if (
      previous !== undefined &&
      previous.kind === 'text' &&
      previous.link === link &&
      JSON.stringify(previous.annotations) === JSON.stringify(annotations)
    ) {
      out[out.length - 1] = { ...previous, text: `${previous.text}${item.text.content}` }
    } else {
      out.push({ kind: 'text', text: item.text.content, link, annotations })
    }
  }
  return out
}

/** Canonical icon envelope: the request/response shapes both sides can carry. */
const normalizeIconEnvelope = (icon: unknown, path: string): Json | null => {
  if (icon == null) return null
  const env = icon as Json
  if (env.type === 'emoji' && typeof env.emoji === 'string') {
    return { type: 'emoji', emoji: env.emoji }
  }
  if (env.type === 'external' && typeof (env.external as Json | undefined)?.url === 'string') {
    return { type: 'external', external: { url: (env.external as Json).url } }
  }
  if (
    env.type === 'custom_emoji' &&
    typeof (env.custom_emoji as Json | undefined)?.id === 'string'
  ) {
    return { type: 'custom_emoji', custom_emoji: { id: (env.custom_emoji as Json).id } }
  }
  if (env.type === 'icon' && typeof (env.icon as Json | undefined)?.name === 'string') {
    // Notion's built-in-SVG rewrite envelope (A07): an `external` request URL
    // under notion.so/icons resolves to `{type:'icon', icon:{name, color}}`.
    const inner = env.icon as Json
    const out: Json = { type: 'icon', name: inner.name }
    if (typeof inner.color === 'string') out.color = inner.color
    return out
  }
  throw new Error(`${path}: unsupported icon envelope`)
}

/**
 * Canonical media source. Uploaded assets are masked to an `uploaded`
 * sentinel: the request references a `file_upload` id (never echoed by the
 * API) and the response serves a `file` envelope with an expiring signed URL
 * — neither is stable, so uploaded content is not verifiable through block
 * JSON. External sources compare by URL.
 */
const normalizeMediaSource = (body: Json, path: string): Json => {
  if (body.type === 'external' || (body.type === undefined && body.external !== undefined)) {
    const url = (body.external as Json | undefined)?.url
    if (typeof url !== 'string') throw new Error(`${path}: malformed external media envelope`)
    return { kind: 'external', url }
  }
  if (body.type === 'file_upload' || body.type === 'file') {
    return { kind: 'uploaded' }
  }
  throw new Error(`${path}: unsupported media source '${String(body.type)}'`)
}

/**
 * Plain-text projection of a page title for `child_page` identity: the block
 * API only surfaces a sub-page's title as a bare string, so the candidate's
 * title spans reduce to their concatenated text content for this comparison.
 */
const titlePlainText = (title: unknown): string => {
  if (typeof title === 'string') return title
  if (!Array.isArray(title)) return ''
  return title
    .map((span) => {
      const text = (span as { text?: { content?: unknown } }).text
      return typeof text?.content === 'string' ? text.content : ''
    })
    .join('')
}

const HEADINGS = new Set(['heading_1', 'heading_2', 'heading_3', 'heading_4'])
const MEDIA = new Set(['image', 'video', 'audio', 'file', 'pdf'])

/**
 * Fold one block body (request- or response-shape — they share the fields the
 * canonical form keeps) into canonical props for its type. Fields whose
 * ownership depends on whether the JSX claimed them come out as `null` when
 * absent; `maskProviderOwned` equalizes them using the candidate side.
 */
const normalizeBody = (type: string, body: Json, path: string): Json => {
  const richText = (): readonly ReadbackRun[] => normalizeRichText(body.rich_text, path)
  const caption = (): readonly ReadbackRun[] => normalizeRichText(body.caption, path)
  const color = typeof body.color === 'string' ? body.color : 'default'
  if (type === 'paragraph' || type === 'quote') {
    return { rich_text: richText(), color }
  }
  if (type === 'bulleted_list_item' || type === 'numbered_list_item' || type === 'toggle') {
    return { rich_text: richText(), color }
  }
  if (HEADINGS.has(type)) {
    return { rich_text: richText(), color, is_toggleable: body.is_toggleable === true }
  }
  if (type === 'to_do') {
    return { rich_text: richText(), color, checked: body.checked === true }
  }
  if (type === 'callout') {
    return { rich_text: richText(), color, icon: normalizeIconEnvelope(body.icon, path) }
  }
  if (type === 'code') {
    return {
      rich_text: richText(),
      caption: caption(),
      language: typeof body.language === 'string' ? body.language : null,
    }
  }
  if (type === 'divider' || type === 'column_list') {
    return {}
  }
  if (type === 'table_of_contents') {
    return { color }
  }
  if (type === 'equation') {
    if (typeof body.expression !== 'string') throw new Error(`${path}: equation lacks expression`)
    return { expression: body.expression }
  }
  if (type === 'bookmark' || type === 'embed') {
    if (typeof body.url !== 'string') throw new Error(`${path}: ${type} lacks url`)
    return { url: body.url, caption: caption() }
  }
  if (MEDIA.has(type)) {
    return { source: normalizeMediaSource(body, path), caption: caption() }
  }
  if (type === 'table') {
    return {
      table_width: typeof body.table_width === 'number' ? body.table_width : null,
      has_column_header: body.has_column_header === true,
      has_row_header: body.has_row_header === true,
    }
  }
  if (type === 'table_row') {
    const cells = body.cells
    if (!Array.isArray(cells)) throw new Error(`${path}: table_row lacks cells`)
    return {
      cells: cells.map((cell, i) => normalizeRichText(cell, `${path}/cells[${i}]`)),
    }
  }
  if (type === 'column') {
    return { width_ratio: typeof body.width_ratio === 'number' ? body.width_ratio : null }
  }
  if (type === 'link_to_page') {
    const pageId = body.page_id
    if (typeof pageId !== 'string') throw new Error(`${path}: link_to_page lacks page_id`)
    return { page_id: normalizeUuid(pageId) }
  }
  if (type === 'child_page') {
    // Identity boundary — see module docs. The block API surfaces only the
    // title; icon/cover/content verify through their own page-level pass.
    return { title: titlePlainText(body.title) }
  }
  throw new Error(`${path}: readback normalization not implemented for ${type}`)
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
      // child_page children live in another page — never compared here.
      children: type === 'child_page' ? [] : normalizeObserved(children, nodePath),
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
      children: node.type === 'child_page' ? [] : normalizeCandidate(node.children, nodePath),
    }
  })

/**
 * Fields Notion supplies a default for when the author made no claim. When
 * the candidate's canonical value is `null` (prop omitted in JSX), the
 * observed value is provider-owned noise — masked back to `null` so it cannot
 * fail the comparison. Explicit JSX claims stay exact managed content.
 */
const PROVIDER_OWNED_WHEN_UNCLAIMED: Readonly<Record<string, readonly string[]>> = {
  callout: ['icon'],
  code: ['language'],
  column: ['width_ratio'],
  table: ['table_width'],
}

/** Blank provider-owned fields on the observed side using candidate context. */
const maskProviderOwned = (
  candidate: readonly NormalizedReadbackNode[],
  observed: readonly NormalizedReadbackNode[],
): readonly NormalizedReadbackNode[] =>
  observed.map((node, index) => {
    const authored = candidate[index]
    const children = maskProviderOwned(authored?.children ?? [], node.children)
    const maskable = PROVIDER_OWNED_WHEN_UNCLAIMED[node.type]
    if (maskable === undefined || authored?.type !== node.type) return { ...node, children }
    let props = node.props
    for (const field of maskable) {
      if (authored.props[field] === null && props[field] !== null) {
        props = { ...props, [field]: null }
      }
    }
    return { ...node, props, children }
  })

/** Hash a canonical tree. Shares `hashStable` with the cache hashes but is a
 * DIFFERENT hash space — see module docs. */
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
 * managed block content matches the render — the readback half of a
 * publication verification, complementing `plan()`'s cache-side fixpoint.
 *
 * Root-page metadata (title/icon/cover from `<Page>`) is out of scope here —
 * pair with {@link compareReadbackPage} for the full page.
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
  return {
    candidateHash,
    observedHash,
    equal: candidateHash === observedHash,
    candidate: cand,
    observed: obs,
  }
}

/**
 * Candidate-side page metadata claims, mirroring `CandidateRootPage` and the
 * page fields of a page-kind `CandidateNode` (both are structurally
 * assignable). Field semantics follow the cache-side sentinel contract:
 *
 * - `undefined` (prop omitted) = no claim — the field is masked out of the
 *   comparison entirely;
 * - `null` on icon/cover = "clear on server" — the observed field must be
 *   unset for the comparison to hold;
 * - a set value compares exactly (modulo A07 normalization).
 */
export interface ReadbackPageCandidate {
  readonly title?: readonly Json[] | undefined
  readonly icon?: Json | null | undefined
  readonly cover?: Json | null | undefined
}

export interface ReadbackPageComparison {
  readonly candidateHash: string
  readonly observedHash: string
  readonly equal: boolean
  readonly candidate: Json
  readonly observed: Json
}

/** Sentinel for fields the JSX made no claim about (masked on both sides). */
const UNCLAIMED = '(unclaimed)'

const BUILTIN_ICON_URL_PREFIX = 'https://www.notion.so/icons/'

/**
 * Compare authored page metadata (title/icon/cover) against a
 * `pages.retrieve` response. Complements {@link compareReadback}: block
 * readback covers a page's children, this covers the page envelope itself —
 * for the sync root (candidate side: `CandidateTree.rootPage`) and for
 * sub-pages (candidate side: the page-kind `CandidateNode`'s
 * title/icon/cover, observed side: the sub-page's own `pages.retrieve`).
 *
 * A07 wrinkle: an external icon URL under notion.so/icons resolves
 * server-side to an undocumented `{type:'icon', icon:{name,color}}` envelope
 * whose name↔URL mapping is not public. That pairing is masked to a shared
 * `builtin-unverified` sentinel — presence is verified, the exact glyph is
 * not. Uploaded covers (`file_upload` request / `file` signed-URL response)
 * mask to `uploaded` like media block sources.
 */
export const compareReadbackPage = ({
  candidate,
  observed,
}: {
  readonly candidate: ReadbackPageCandidate
  readonly observed: Json
}): ReadbackPageComparison => {
  const cand: Json = {}
  const obs: Json = {}

  if (candidate.title === undefined) {
    cand.title = UNCLAIMED
    obs.title = UNCLAIMED
  } else {
    cand.title = normalizeRichText(candidate.title, 'page/title')
    const properties = observed.properties as Json | undefined
    const titleProp = properties?.title as { title?: unknown } | undefined
    obs.title = normalizeRichText(titleProp?.title ?? [], 'page/title(observed)')
  }

  if (candidate.icon === undefined) {
    cand.icon = UNCLAIMED
    obs.icon = UNCLAIMED
  } else {
    let candIcon =
      candidate.icon === null ? null : normalizeIconEnvelope(candidate.icon, 'page/icon')
    let obsIcon = normalizeIconEnvelope(observed.icon, 'page/icon(observed)')
    const candUrl =
      candIcon !== null && candIcon.type === 'external'
        ? ((candIcon.external as Json).url as string)
        : undefined
    if (candUrl?.startsWith(BUILTIN_ICON_URL_PREFIX) === true && obsIcon?.type === 'icon') {
      candIcon = { type: 'builtin-unverified' }
      obsIcon = { type: 'builtin-unverified' }
    }
    cand.icon = candIcon
    obs.icon = obsIcon
  }

  if (candidate.cover === undefined) {
    cand.cover = UNCLAIMED
    obs.cover = UNCLAIMED
  } else {
    cand.cover =
      candidate.cover === null ? null : normalizeMediaSource(candidate.cover, 'page/cover')
    obs.cover =
      observed.cover == null
        ? null
        : normalizeMediaSource(observed.cover as Json, 'page/cover(observed)')
  }

  const candidateHash = hashStable(cand)
  const observedHash = hashStable(obs)
  return {
    candidateHash,
    observedHash,
    equal: candidateHash === observedHash,
    candidate: cand,
    observed: obs,
  }
}
