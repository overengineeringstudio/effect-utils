import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'
import type { ReactNode } from 'react'

import { NotionBlocks, NotionPages, type NotionConfig } from '@overeng/notion-effect-client'
import type { BlockType } from '@overeng/notion-effect-schema'

import { NotionSyncError } from './errors.ts'
import { createNotionRoot } from './host-config.ts'
import type { Op } from './op-buffer.ts'
import { OpBuffer } from './op-buffer.ts'

/**
 * Block types that Notion's `blocks.children.append` endpoint refuses to
 * accept without their descendants inlined in the same request. For these
 * we collapse the op-buffer subtree into a single nested API body instead
 * of issuing one call per block.
 */
/**
 * Notion's per-request children cap. Applies both to
 * `blocks.children.append` (`children.length ≤ 100`) and to any nested
 * `children` array inside a create body — most notably `table.children`
 * when a `table` block is created with rows inlined.
 *
 * Ref: https://developers.notion.com/reference/patch-block-children
 */
export const MAX_CHILDREN_PER_APPEND = 100

export const ATOMIC_CONTAINERS: ReadonlySet<BlockType> = new Set<BlockType>([
  'column_list',
  // `table` has the same staged-append prohibition as `column_list`: Notion
  // rejects a bare `table` append with `body.children[n].table.children
  // should be defined`. Rows must ship inlined in the same request. Row
  // cells are projected via `TableRow.cells` into the `table_row` props by
  // host-config, so `table_row` itself has no child-append ops to fold and
  // stays out of this set.
  'table',
])

/**
 * Reason the warm-path diff was bypassed. Unset on a clean incremental sync.
 *
 * - `cold-cache`: no prior snapshot; full append.
 * - `schema-mismatch`: on-disk schema is not the current
 *   `CACHE_SCHEMA_VERSION`; the renderer still diffs, but downstream
 *   consumers may want to clear the cache explicitly.
 * - `cache-drift`: the live page's top-level children diverged from the
 *   cached tree (another client archived/added blocks out-of-band); the
 *   renderer rebuilds from scratch to reconverge.
 * - `page-id-drift`: the cache was written against a different pageId
 *   than the one passed to `sync`; diffing would target ids on the wrong
 *   page, so we cold-start.
 * - `page-missing`: a page-scoped reconcile targeted a page that no longer
 *   exists (issue #618 phase 2+). No emitter currently produces this.
 * - `page-archived`: a page-scoped reconcile targeted a page that was
 *   archived out-of-band (issue #618 phase 2+). No emitter currently
 *   produces this.
 * - `partial-page-create`: a page-create landed partially (metadata / some
 *   blocks) but the full subtree could not be inlined (issue #618
 *   phase 2+). No emitter currently produces this.
 */
export type SyncFallbackReason =
  | 'cold-cache'
  | 'schema-mismatch'
  | 'cache-drift'
  | 'page-id-drift'
  | 'page-missing'
  | 'page-archived'
  | 'partial-page-create'

/** Per-page-op counts (issue #618). Zero across the board until phase 2 wires page emission. */
export interface PageOpCounts {
  readonly creates: number
  readonly updates: number
  readonly archives: number
  readonly moves: number
  /**
   * Count of {@link DiffOp} `reorderPages` ops applied (phase 4d, #618). Each
   * emitted op drives 2N internal `pages.move` roundtrips; this counter tracks
   * the op itself, not the expanded HTTP calls — `moves` already accounts for
   * cross-parent reparents without intra-parent reorder.
   */
  readonly reorders: number
}

/** Default zero page-op tally. See {@link PageOpCounts}. */
export const emptyPageCounts = (): PageOpCounts => ({
  creates: 0,
  updates: 0,
  archives: 0,
  moves: 0,
  reorders: 0,
})

/** Summary of the ops applied during a render/sync pass. */
export type SyncResult = {
  readonly appends: number
  readonly updates: number
  readonly removes: number
  readonly inserts: number
  /** Page-scope op counts. Always zero pre-phase-2. */
  readonly pages: PageOpCounts
  readonly fallbackReason?: SyncFallbackReason
}

const tally = (ops: readonly Op[]): Omit<SyncResult, 'fallbackReason' | 'pages'> => {
  let appends = 0
  let updates = 0
  let removes = 0
  let inserts = 0
  for (const op of ops) {
    switch (op.kind) {
      case 'append':
        appends += 1
        break
      case 'insertBefore':
        inserts += 1
        break
      case 'update':
        updates += 1
        break
      case 'remove':
        removes += 1
        break
    }
  }
  return { appends, updates, removes, inserts }
}

/**
 * Collect the op-buffer produced by a one-shot React render of `element`.
 *
 * Exposed for tests and for the cache-backed `sync` driver.
 */
export const collectOps = (element: ReactNode, rootId: string): OpBuffer => {
  const buffer = new OpBuffer(rootId)
  const root = createNotionRoot(buffer, rootId)
  root.render(element)
  return buffer
}

/** Body payload for a block `append` op. */
const appendBody = (
  op: Extract<Op, { kind: 'append' | 'insertBefore' }>,
): Record<string, unknown> => ({
  object: 'block',
  type: op.type,
  [op.type]: op.props,
})

type AppendLikeOp = Extract<Op, { kind: 'append' | 'insertBefore' }>

/**
 * Group append/insertBefore ops by their parent (temp) id so an atomic
 * container can reconstruct its descendant subtree without scanning the
 * full op list for every node.
 */
export const indexChildren = (ops: readonly Op[]): ReadonlyMap<string, readonly AppendLikeOp[]> => {
  const out = new Map<string, AppendLikeOp[]>()
  for (const op of ops) {
    if (op.kind !== 'append' && op.kind !== 'insertBefore') continue
    const list = out.get(op.parent) ?? []
    list.push(op)
    out.set(op.parent, list)
  }
  return out
}

/**
 * Build a nested `{object, type, <type>: {...props, children?}}` body for an
 * atomic container. Descendant ops are spliced under the container's props
 * via the `children` array, recursively.
 *
 * Top-level direct children are capped at `MAX_CHILDREN_PER_APPEND` (Notion
 * rejects bodies with any `children` array longer than 100). Overflow at the
 * top level is deferred to follow-up `appendBlockChildren` calls issued by
 * `renderToNotion` against the container's server id once it's resolved.
 * Overflow at deeper levels throws — that shape would silently drop content.
 */
export const nestedBody = (
  op: AppendLikeOp,
  childrenIndex: ReadonlyMap<string, readonly AppendLikeOp[]>,
): Record<string, unknown> => buildNestedBody(op, childrenIndex, true, 0)

const buildNestedBody = (
  op: AppendLikeOp,
  childrenIndex: ReadonlyMap<string, readonly AppendLikeOp[]>,
  isTopLevel: boolean,
  depth: number,
): Record<string, unknown> => {
  const kids = childrenIndex.get(op.id) ?? []
  const payload: Record<string, unknown> = { ...op.props }
  if (kids.length > 0) {
    if (!isTopLevel && kids.length > MAX_CHILDREN_PER_APPEND) {
      throw new Error(
        `notion-react: atomic container nested level (depth ${depth}, type ${op.type}) has ${kids.length} direct children, exceeds Notion's ${MAX_CHILDREN_PER_APPEND}-per-level cap. Nested-level chunking is not implemented.`,
      )
    }
    const inlineCount = isTopLevel ? Math.min(kids.length, MAX_CHILDREN_PER_APPEND) : kids.length
    payload.children = kids
      .slice(0, inlineCount)
      .map((k) => buildNestedBody(k, childrenIndex, false, depth + 1))
  }
  return { object: 'block', type: op.type, [op.type]: payload }
}

/**
 * Collect ids of descendants inlined under an atomic container. Mirrors the
 * top-level cap in `nestedBody`: the first `MAX_CHILDREN_PER_APPEND`
 * top-level kids and all of their transitive descendants are absorbed;
 * overflow top-level kids stay as free-standing `append` ops.
 */
const absorbedDescendantIds = (
  rootId: string,
  childrenIndex: ReadonlyMap<string, readonly AppendLikeOp[]>,
): ReadonlySet<string> => {
  const seen = new Set<string>()
  const walkAll = (parent: string): void => {
    for (const kid of childrenIndex.get(parent) ?? []) {
      if (seen.has(kid.id)) continue
      seen.add(kid.id)
      walkAll(kid.id)
    }
  }
  const topKids = childrenIndex.get(rootId) ?? []
  for (const k of topKids.slice(0, MAX_CHILDREN_PER_APPEND)) {
    seen.add(k.id)
    walkAll(k.id)
  }
  return seen
}

/**
 * Translate a `PageTitle` ergonomic value to the Notion-wire span array.
 * Strings become a single-span array; arrays pass through verbatim (each
 * span is assumed pre-shaped per `PageTitleSpan`). Empty strings yield `[]`.
 */
const pageTitleSpans = (title: unknown): readonly Record<string, unknown>[] | undefined => {
  if (typeof title === 'string') {
    if (title.length === 0) return []
    return [{ type: 'text', text: { content: title } }]
  }
  if (Array.isArray(title)) return title as readonly Record<string, unknown>[]
  return undefined
}

/**
 * Issue a block update against Notion, transparently routing `child_page`
 * title/icon/cover changes through `pages.update` (since the Notion API
 * rejects `PATCH /blocks/{id}` bodies of `{ child_page: {...} }` with
 * `validation_error`). Other block types go through `blocks.update` as before.
 *
 * The `child_page` props supported here are `title` (string or
 * `PageTitleSpan[]`), `icon`, and `cover`. If none of them are present the
 * call is skipped entirely — page-level archive/move/create are phase 3b work
 * and flow through dedicated emitters rather than `issueBlockUpdate`.
 */
export const issueBlockUpdate = (
  blockId: string,
  type: BlockType,
  props: Record<string, unknown>,
): Effect.Effect<unknown, unknown, NotionConfig | HttpClient.HttpClient> => {
  if (type === 'child_page') {
    const spans = pageTitleSpans(props.title)
    const hasTitle = spans !== undefined
    const hasIcon = props.icon !== undefined
    const hasCover = props.cover !== undefined
    if (!hasTitle && !hasIcon && !hasCover) {
      // Nothing to update at the page level; skip the call rather than
      // round-tripping an empty PATCH that Notion would also reject.
      return Effect.void
    }
    // The client's `UpdatePageOptions.icon`/`cover` unions are narrower than
    // the component's `PageIcon`/`PageCover` (no `custom_emoji` on icon,
    // no `file_upload` on cover). We forward verbatim; mismatches surface as
    // a Notion validation_error rather than being silently dropped.
    return NotionPages.update({
      pageId: blockId,
      ...(hasTitle ? { properties: { title: { title: spans } } } : {}),
      ...(hasIcon ? { icon: props.icon as never } : {}),
      ...(hasCover ? { cover: props.cover as never } : {}),
    })
  }
  return NotionBlocks.update({ blockId, [type]: props })
}

/**
 * Render `element` to Notion in append-only mode. Assumes the target page
 * has no pre-existing children this renderer owns; suitable for first-time
 * creation. For incremental updates against a prior state, use `sync`.
 *
 * Temporary block ids issued by the OpBuffer are mapped to real Notion ids
 * returned by `NotionBlocks.append` so nested inserts resolve correctly.
 */
export const renderToNotion = (
  element: ReactNode,
  opts: { readonly pageId: string },
): Effect.Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const buffer = collectOps(element, opts.pageId)
    const idMap = new Map<string, string>()
    const resolve = (id: string): string => idMap.get(id) ?? id
    const childrenIndex = indexChildren(buffer.ops)
    // Temp ids of descendants under an atomic container we've already emitted;
    // their individual append ops are skipped since they shipped inline.
    const absorbed = new Set<string>()

    /**
     * Ship overflow rows (those beyond the atomic container's inline cap) as
     * follow-up `appendBlockChildren` calls against the container's server
     * id. Each call carries up to `MAX_CHILDREN_PER_APPEND` children and
     * records server ids back into `idMap`.
     */
    const flushOverflow = (
      containerTmpId: string,
    ): Effect.Effect<void, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
      Effect.gen(function* () {
        const topKids = childrenIndex.get(containerTmpId) ?? []
        const overflow = topKids.slice(MAX_CHILDREN_PER_APPEND)
        if (overflow.length === 0) return
        const parentServerId = resolve(containerTmpId)
        for (let i = 0; i < overflow.length; i += MAX_CHILDREN_PER_APPEND) {
          const batch = overflow.slice(i, i + MAX_CHILDREN_PER_APPEND)
          const res = yield* NotionBlocks.append({
            blockId: parentServerId,
            children: batch.map((k) =>
              ATOMIC_CONTAINERS.has(k.type) ? nestedBody(k, childrenIndex) : appendBody(k),
            ),
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-append-failed', cause }),
            ),
          )
          const results = res.results as readonly { id?: string }[]
          for (let j = 0; j < batch.length; j++) {
            const serverId = results[j]?.id
            if (serverId !== undefined) {
              idMap.set(batch[j]!.id, serverId)
              // The overflow row's own descendants (if any) are handled by
              // its own absorbed-set registration below, so when the main
              // loop reaches them they'll already be marked absorbed.
              for (const d of absorbedDescendantIds(batch[j]!.id, childrenIndex)) {
                absorbed.add(d)
              }
            }
          }
          // Mark the overflow row itself as absorbed so the outer loop
          // skips re-issuing a plain append for it.
          for (const k of batch) absorbed.add(k.id)
        }
      })

    for (const op of buffer.ops) {
      if ('id' in op && absorbed.has(op.id)) continue
      switch (op.kind) {
        case 'append': {
          const atomic = ATOMIC_CONTAINERS.has(op.type)
          const body = atomic ? nestedBody(op, childrenIndex) : appendBody(op)
          const res = yield* NotionBlocks.append({
            blockId: resolve(op.parent),
            children: [body],
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-append-failed', cause }),
            ),
          )
          const first = res.results[0] as { id?: string } | undefined
          if (first?.id !== undefined) idMap.set(op.id, first.id)
          if (atomic) {
            for (const d of absorbedDescendantIds(op.id, childrenIndex)) absorbed.add(d)
            // Flush overflow after the container's server id is known.
            yield* flushOverflow(op.id)
          }
          break
        }
        case 'insertBefore': {
          const atomic = ATOMIC_CONTAINERS.has(op.type)
          const body = atomic ? nestedBody(op, childrenIndex) : appendBody(op)
          const res = yield* NotionBlocks.append({
            blockId: resolve(op.parent),
            children: [body],
            position: { type: 'after_block', after_block: { id: resolve(op.beforeId) } },
          }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-insert-failed', cause }),
            ),
          )
          const first = res.results[0] as { id?: string } | undefined
          if (first?.id !== undefined) idMap.set(op.id, first.id)
          if (atomic) {
            for (const d of absorbedDescendantIds(op.id, childrenIndex)) absorbed.add(d)
            yield* flushOverflow(op.id)
          }
          break
        }
        case 'update': {
          yield* issueBlockUpdate(resolve(op.id), op.type, op.props).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-update-failed', cause }),
            ),
          )
          break
        }
        case 'remove': {
          yield* NotionBlocks.delete({ blockId: resolve(op.id) }).pipe(
            Effect.mapError(
              (cause) => new NotionSyncError({ reason: 'notion-delete-failed', cause }),
            ),
          )
          break
        }
      }
    }

    return { ...tally(buffer.ops), pages: emptyPageCounts() }
  })
