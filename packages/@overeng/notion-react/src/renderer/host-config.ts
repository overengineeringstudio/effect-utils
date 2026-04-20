import type { ReactNode } from 'react'
// eslint-disable-next-line @typescript-eslint/naming-convention
import ReactReconciler from 'react-reconciler'

import type { BlockType } from '@overeng/notion-effect-schema'

import { flattenRichText } from './flatten-rich-text.ts'
import type { OpBuffer } from './op-buffer.ts'

export type Instance = {
  type: BlockType | 'raw'
  props: Record<string, unknown>
  id: string | null
  blockKey: string | undefined
  parent: Instance | null
  children: (Instance | TextInstance)[]
  rootContainer: Container
}

type TextInstance = {
  readonly kind: 'text'
  text: string
  parent: Instance | null
}

/**
 * Container driven by the reconciler. `topLevel` tracks root-level children in
 * commit order so we can reconstruct the rendered tree shape after a commit.
 */
export type Container = {
  readonly rootId: string
  readonly buffer: OpBuffer
  readonly topLevel: Instance[]
}

/**
 * Blocks whose JSX children contribute a `rich_text[]` projection to the
 * parent's payload. Inline text/annotation/link/mention/equation children are
 * flattened into `rich_text`; any JSX host elements nested under the same
 * parent (e.g. a `<Paragraph>` under a `<BulletedListItem>`) are reconciled
 * as block-child fibers instead of being folded into rich_text.
 *
 * `toggle` is excluded: its header text comes from the `title` prop, so its
 * JSX children are purely nested blocks.
 */
const TEXT_LEAF = new Set<BlockType>([
  'paragraph',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'quote',
  'callout',
  'code',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'table_row',
])

/**
 * Structural equality for projected block-prop payloads. We need this (instead
 * of reference equality) because `blockProps` re-builds arrays/objects on every
 * render, so two semantically identical paragraphs would always appear to
 * differ under `===`.
 */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a == null || b == null) return a === b
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ak = Object.keys(ao)
    const bk = Object.keys(bo)
    if (ak.length !== bk.length) return false
    for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false
    return true
  }
  return false
}

/**
 * Project JSX props onto the Notion block-payload shape for the given type.
 *
 * For v0 this is intentionally narrow: it produces a stable, diffable
 * object but does NOT match the full Notion API schema for every block.
 * The sync driver is responsible for the final API body translation.
 */
const blockProps = (
  type: BlockType | 'raw',
  props: Record<string, unknown>,
): Record<string, unknown> => {
  // `blockKey` is a renderer-level identity hint, never part of the
  // projected Notion payload — exclude it from diff hashing.
  const p: Record<string, unknown> = {}
  if (type === 'raw') {
    // Legacy sentinel — the canonical escape-hatch path is `<Raw type="...">`,
    // which lands here with the actual block type, not 'raw'. Retained so the
    // instance-type union stays exhaustive.
    return typeof props.content === 'object' && props.content !== null
      ? { ...(props.content as Record<string, unknown>) }
      : {}
  }
  if (TEXT_LEAF.has(type)) {
    p.rich_text = flattenRichText(props.children as ReactNode)
  }
  if (type === 'to_do' && typeof props.checked === 'boolean') p.checked = props.checked
  if (type === 'toggle') {
    // Notion requires `rich_text` for toggle; the component exposes a `title`
    // string prop for ergonomics. Empty string still yields `[]` which Notion
    // accepts as a valid (empty) rich_text array.
    p.rich_text = flattenRichText(typeof props.title === 'string' ? props.title : '')
  }
  if (type === 'code' && typeof props.language === 'string') p.language = props.language
  if (type === 'callout' && typeof props.icon === 'string') {
    // Notion wants `icon: { type: 'emoji', emoji }` — the component accepts
    // a bare emoji string for ergonomics.
    p.icon = { type: 'emoji', emoji: props.icon }
  }
  if (type === 'callout' && typeof props.color === 'string') p.color = props.color
  if (
    (type === 'heading_1' || type === 'heading_2' || type === 'heading_3') &&
    typeof props.toggleable === 'boolean'
  ) {
    p.is_toggleable = props.toggleable
  }
  // File-like media blocks (image/video/audio/file/pdf) want the URL wrapped
  // in an `{ type: 'external', external: { url } }` envelope. `bookmark` and
  // `embed` expect the bare `url` field — different shape per Notion's schema.
  if (
    (type === 'image' ||
      type === 'video' ||
      type === 'audio' ||
      type === 'file' ||
      type === 'pdf') &&
    typeof props.url === 'string'
  ) {
    p.type = 'external'
    p.external = { url: props.url }
  }
  if (type === 'bookmark' && typeof props.url === 'string') p.url = props.url
  if (type === 'embed' && typeof props.url === 'string') p.url = props.url
  if (type === 'equation' && typeof props.expression === 'string') p.expression = props.expression
  if (type === 'link_to_page' && typeof props.pageId === 'string') p.page_id = props.pageId
  if (type === 'child_page' && typeof props.title === 'string') p.title = props.title
  // Escape hatch: `<Raw type="..." content={{...}}>` (and its passthrough
  // wrappers like SyncedBlock / Template / LinkPreview / ChildDatabase /
  // Breadcrumb) forward a pre-shaped payload via `content`. If no type-
  // specific handler contributed a projection, emit the content verbatim so
  // Notion receives the expected `{[type]: {...content}}` body.
  if (Object.keys(p).length === 0 && typeof props.content === 'object' && props.content !== null) {
    return { ...(props.content as Record<string, unknown>) }
  }
  return p
}

const commitChildren = (inst: Instance, container: Container): void => {
  if (inst.id == null) return
  for (const child of inst.children) {
    if ('kind' in child) continue
    if (child.id != null) continue
    const id = container.buffer.append(
      inst.id,
      child.type as BlockType,
      blockProps(child.type, child.props),
    )
    child.id = id
    commitChildren(child, container)
  }
}

// react-reconciler's types are notoriously stale for React 19; we use `any` to
// bypass the mismatch and rely on runtime correctness (see pixeltrail derisk).
/* eslint-disable @typescript-eslint/no-explicit-any */
const hostConfig: any = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  isPrimaryRenderer: true,
  noTimeout: -1,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  getCurrentEventPriority: () => 0,
  resolveUpdatePriority: () => 0,
  getCurrentUpdatePriority: () => 0,
  setCurrentUpdatePriority: () => {},
  getInstanceFromNode: () => null,
  beforeActiveInstanceBlur: () => {},
  afterActiveInstanceBlur: () => {},
  prepareScopeUpdate: () => {},
  getInstanceFromScope: () => null,
  detachDeletedInstance: () => {},
  clearContainer: () => {},
  maySuspendCommit: () => false,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
  NotPendingTransition: null,
  HostTransitionContext: {
    $$typeof: Symbol.for('react.context'),
    _currentValue: null,
    _currentValue2: null,
    Provider: null,
    Consumer: null,
  },
  requestPostPaintCallback: () => {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,

  getRootHostContext: () => ({}),
  getChildHostContext: () => ({}),
  prepareForCommit: () => null,
  resetAfterCommit: () => {},
  getPublicInstance: (i: Instance) => i,

  // Always create fibers for children. Rich-text projection reads `props.children`
  // directly (see `blockProps`), so inline text/annotation elements are flattened
  // from the JSX tree. Host-element children (nested blocks under list-ish /
  // text-leaf parents) then reconcile as proper child fibers rather than being
  // absorbed into the parent's rich_text.
  shouldSetTextContent: () => false,

  createInstance: (
    type: BlockType | 'raw',
    props: Record<string, unknown>,
    rootContainer: Container,
  ): Instance => ({
    type,
    props,
    id: null,
    blockKey: typeof props.blockKey === 'string' ? props.blockKey : undefined,
    parent: null,
    children: [],
    rootContainer,
  }),

  createTextInstance: (text: string): TextInstance => ({ kind: 'text', text, parent: null }),

  appendInitialChild: (parent: Instance, child: Instance | TextInstance) => {
    parent.children.push(child)
    child.parent = parent
  },

  finalizeInitialChildren: () => false,

  appendChildToContainer: (container: Container, child: Instance) => {
    const id = container.buffer.append(
      container.rootId,
      child.type as BlockType,
      blockProps(child.type, child.props),
    )
    child.id = id
    container.topLevel.push(child)
    commitChildren(child, container)
  },

  appendChild: (parent: Instance, child: Instance | TextInstance) => {
    if (parent.id == null) {
      parent.children.push(child)
      child.parent = parent
      return
    }
    if ('kind' in child) {
      parent.children.push(child)
      child.parent = parent
      return
    }
    const id = parent.rootContainer.buffer.append(
      parent.id,
      child.type as BlockType,
      blockProps(child.type, child.props),
    )
    child.id = id
    child.parent = parent
    parent.children.push(child)
    commitChildren(child, parent.rootContainer)
  },

  insertBefore: (
    parent: Instance,
    child: Instance | TextInstance,
    beforeChild: Instance | TextInstance,
  ) => {
    if ('kind' in child || 'kind' in beforeChild) return
    if (parent.id == null || beforeChild.id == null) return
    const id = parent.rootContainer.buffer.insertBefore(
      parent.id,
      child.type as BlockType,
      blockProps(child.type, child.props),
      beforeChild.id,
    )
    child.id = id
    child.parent = parent
    const idx = parent.children.indexOf(beforeChild)
    parent.children.splice(idx, 0, child)
    commitChildren(child, parent.rootContainer)
  },

  insertInContainerBefore: (container: Container, child: Instance, beforeChild: Instance) => {
    if ('kind' in (beforeChild as unknown as { kind?: string }) || beforeChild.id == null) return
    const id = container.buffer.insertBefore(
      container.rootId,
      child.type as BlockType,
      blockProps(child.type, child.props),
      beforeChild.id,
    )
    child.id = id
    const idx = container.topLevel.indexOf(beforeChild)
    if (idx >= 0) container.topLevel.splice(idx, 0, child)
    else container.topLevel.push(child)
    commitChildren(child, container)
  },

  removeChild: (parent: Instance, child: Instance | TextInstance) => {
    if ('kind' in child) return
    if (child.id != null) parent.rootContainer.buffer.remove(child.id)
    parent.children = parent.children.filter((c) => c !== child)
  },

  removeChildFromContainer: (container: Container, child: Instance) => {
    if ('kind' in (child as unknown as { kind?: string })) return
    if (child.id != null) container.buffer.remove(child.id)
    const idx = container.topLevel.indexOf(child)
    if (idx >= 0) container.topLevel.splice(idx, 1)
  },

  commitUpdate: (
    instance: Instance,
    type: BlockType | 'raw',
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
  ) => {
    instance.props = newProps
    const oldB = blockProps(type, oldProps)
    const newB = blockProps(type, newProps)
    if (!deepEqual(oldB, newB) && instance.id != null) {
      instance.rootContainer.buffer.update(instance.id, type as BlockType, newB)
    }
  },

  commitTextUpdate: (textInstance: TextInstance, _oldText: string, newText: string) => {
    textInstance.text = newText
  },

  resetTextContent: () => {},
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NotionReconciler = (ReactReconciler as unknown as (config: any) => any)(hostConfig)

/**
 * Create a reconciler root bound to an `OpBuffer`. Call `render(element)` to
 * drive a synchronous commit; ops are appended to the buffer.
 */
export const createNotionRoot = (buffer: OpBuffer, rootId: string) => {
  const container: Container = { rootId, buffer, topLevel: [] }
  const root = NotionReconciler.createContainer(
    container,
    1,
    null,
    false,
    null,
    '',
    (e: unknown) => console.error('uncaught', e),
    (e: unknown) => console.error('caught', e),
    (e: unknown) => console.error('recoverable', e),
    null,
  )
  return {
    container,
    render: (element: ReactNode) => {
      NotionReconciler.updateContainerSync(element, root, null, () => {})
      NotionReconciler.flushSyncWork()
    },
  }
}

/**
 * Walk the committed instance tree under `container`. Text children are
 * skipped — they've already been projected into the parent's `rich_text`.
 */
export const walkInstances = (container: Container): readonly Instance[] => container.topLevel

/** Access a block instance's nested block children (non-text). */
export const blockChildren = (inst: Instance): readonly Instance[] =>
  inst.children.filter((c): c is Instance => !('kind' in c))

/** Access the Notion block-payload projection for a given instance. */
export const projectProps = (inst: Instance): Record<string, unknown> =>
  blockProps(inst.type, inst.props)
