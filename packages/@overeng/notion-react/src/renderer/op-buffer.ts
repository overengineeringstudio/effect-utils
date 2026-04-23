import type { BlockType } from '@overeng/notion-effect-schema'

/**
 * Op emitted by the reconciler. `parent` is the container/parent block id.
 * `props` is the projected Notion-shaped payload for the block type
 * (e.g., `{paragraph: {rich_text: [...]}}` would be produced upstream).
 *
 * For v0 we keep `props` shallow: it carries the flattened rich_text array
 * and block-type-specific non-child fields. Child blocks are expressed via
 * subsequent `append` ops on the parent id.
 */
export type Op =
  | {
      readonly kind: 'append'
      readonly parent: string
      readonly id: string
      readonly type: BlockType
      readonly props: Record<string, unknown>
    }
  | {
      readonly kind: 'insertBefore'
      readonly parent: string
      readonly id: string
      readonly beforeId: string
      readonly type: BlockType
      readonly props: Record<string, unknown>
    }
  | { readonly kind: 'remove'; readonly id: string }
  | {
      readonly kind: 'update'
      readonly id: string
      readonly type: BlockType
      readonly props: Record<string, unknown>
    }

/**
 * In-memory op buffer. Used by the reconciler as the host "container".
 *
 * The real Notion sync driver consumes the buffered ops at the end of a
 * commit and translates them to NotionBlocks calls (append/update/delete).
 */
export class OpBuffer {
  readonly ops: Op[] = []
  readonly rootId: string
  private idCounter = 0

  constructor(rootId: string) {
    this.rootId = rootId
  }

  private nextId(): string {
    this.idCounter += 1
    return `tmp-${this.idCounter}`
  }

  append(parent: string, type: BlockType, props: Record<string, unknown>): string {
    const id = this.nextId()
    this.ops.push({ kind: 'append', parent, id, type, props })
    return id
  }

  insertBefore(
    parent: string,
    type: BlockType,
    props: Record<string, unknown>,
    beforeId: string,
  ): string {
    const id = this.nextId()
    this.ops.push({ kind: 'insertBefore', parent, id, beforeId, type, props })
    return id
  }

  update(id: string, type: BlockType, props: Record<string, unknown>): void {
    this.ops.push({ kind: 'update', id, type, props })
  }

  remove(id: string): void {
    this.ops.push({ kind: 'remove', id })
  }

  reset(): void {
    this.ops.length = 0
  }
}

/**
 * Page-scope op union (issue #618). Reserved for the page-ops work that
 * layers on top of the existing block reconciler: create/update/archive/move
 * a Notion (sub)page independent of the block tree under it.
 *
 * No emitter currently produces these; this is forward-compat type plumbing
 * for phases 2+ of the #618 epic. Once the sync driver starts emitting
 * PageOps the {@link DiffOp} union is already prepared to carry them.
 *
 * Payload fields (`title`, `icon`, `cover`, `inlineChildren`) are typed as
 * `unknown` pending the schema decisions in phase 2 — they will tighten to
 * the concrete `PageProperty` / `PageIcon` / `PageCover` shapes from
 * `@overeng/notion-effect-schema` once those wire through the renderer.
 */
export type PageOp =
  | {
      readonly kind: 'createPage'
      readonly tmpPageId: string
      readonly parent: { readonly pageId: string }
      readonly title?: unknown
      readonly icon?: unknown
      readonly cover?: unknown
      /** Pre-shaped block bodies shipped inline as `children` on pages.create. */
      readonly inlineChildren: readonly unknown[]
      /**
       * Candidate nodes corresponding to `inlineChildren` in submission order.
       * Internal field — used by the sync driver to resolve inline-block tmpIds
       * against the server response after `pages.create` returns. Not part of
       * the public PageOp contract; pre-phase-3b consumers should ignore it.
       */
      readonly inlineCandidates?: readonly unknown[]
    }
  | {
      readonly kind: 'updatePage'
      readonly pageId: string
      readonly title?: unknown
      readonly icon?: unknown
      readonly cover?: unknown
    }
  | { readonly kind: 'archivePage'; readonly pageId: string }
  | {
      readonly kind: 'movePage'
      readonly pageId: string
      readonly parent: { readonly pageId: string }
    }
