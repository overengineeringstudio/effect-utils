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
  | { readonly kind: 'append'; readonly parent: string; readonly id: string; readonly type: BlockType; readonly props: Record<string, unknown> }
  | { readonly kind: 'insertBefore'; readonly parent: string; readonly id: string; readonly beforeId: string; readonly type: BlockType; readonly props: Record<string, unknown> }
  | { readonly kind: 'remove'; readonly id: string }
  | { readonly kind: 'update'; readonly id: string; readonly type: BlockType; readonly props: Record<string, unknown> }

/**
 * In-memory op buffer. Used by the reconciler as the host "container".
 *
 * The real Notion sync driver consumes the buffered ops at the end of a
 * commit and translates them to NotionBlocks calls (append/update/delete).
 */
export class OpBuffer {
  readonly ops: Op[] = []
  private idCounter = 0

  constructor(readonly rootId: string) {}

  private nextId(): string {
    this.idCounter += 1
    return `tmp-${this.idCounter}`
  }

  append(parent: string, type: BlockType, props: Record<string, unknown>): string {
    const id = this.nextId()
    this.ops.push({ kind: 'append', parent, id, type, props })
    return id
  }

  insertBefore(parent: string, type: BlockType, props: Record<string, unknown>, beforeId: string): string {
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
