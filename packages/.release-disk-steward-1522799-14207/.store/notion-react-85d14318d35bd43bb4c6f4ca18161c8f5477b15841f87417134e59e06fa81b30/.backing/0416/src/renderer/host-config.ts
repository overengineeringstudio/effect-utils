import type { ReactNode } from 'react'
// eslint-disable-next-line @typescript-eslint/naming-convention
import ReactReconciler from 'react-reconciler'

import type { BlockType } from '@overeng/notion-effect-schema'

import { flattenRichText } from './flatten-rich-text.ts'
import type { OpBuffer } from './op-buffer.ts'

/**
 * Host types the reconciler accepts. `BlockType` covers Notion block tags
 * projected as block ops; `'raw'` is a legacy escape-hatch sentinel. The
 * virtual `'page_root'` wraps the JSX tree when the author renders a `<Page>`
 * — it does NOT correspond to a Notion block: the host-config folds its
 * children into the container's top-level and stashes its metadata on the
 * container for the sync driver (forward-compat for issue #618 phase 3b).
 */
export type HostType = BlockType | 'raw' | 'page_root'

/**
 * Which Notion-side node a rendered instance maps onto. `'block'` is the
 * default; `'page'` marks nodes that address a page boundary rather than a
 * block (e.g. `<ChildPage>`, the sync root). Forward-compat for #618 phase
 * 3b — the block-diff path currently ignores this flag.
 */
export type NodeKind = 'block' | 'page'

export type Instance = {
  type: HostType
  props: Record<string, unknown>
  id: string | null
  blockKey: string | undefined
  nodeKind: NodeKind
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
 *
 * `pageRoot` captures the most recently rendered `<Page>` instance (if any).
 * The sync driver can read its `props` (title/icon/cover) after a commit to
 * decide whether to emit a root-level `pages.update` — currently unused;
 * wiring lands in issue #618 phase 3b.
 */
export type Container = {
  readonly rootId: string
  readonly buffer: OpBuffer
  readonly topLevel: Instance[]
  pageRoot: Instance | null
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
const blockProps = (type: HostType, props: Record<string, unknown>): Record<string, unknown> => {
  // `blockKey` is a renderer-level identity hint, never part of the
  // projected Notion payload — exclude it from diff hashing.
  const p: Record<string, unknown> = {}
  if (type === 'page_root') {
    // The virtual root wrapper carries page-level metadata (title/icon/cover)
    // but is never emitted as a block op. Projecting here keeps the shape
    // visible to debug/instrumentation paths; the sync driver reads
    // `container.pageRoot.props` for phase 3b page-update emission.
    if (props.title !== undefined) p.title = props.title
    if (props.icon !== undefined) p.icon = props.icon
    if (props.cover !== undefined) p.cover = props.cover
    return p
  }
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
  if (type === 'callout' && props.icon !== undefined) {
    // Notion accepts `{ type: 'emoji', emoji }` or `{ type: 'external',
    // external: { url } }`. The component takes a bare string (emoji) or
    // `{ external: url }` for ergonomics and we project accordingly.
    const icon = props.icon
    if (typeof icon === 'string') {
      p.icon = { type: 'emoji', emoji: icon }
    } else if (
      typeof icon === 'object' &&
      icon !== null &&
      typeof (icon as { external?: unknown }).external === 'string'
    ) {
      p.icon = { type: 'external', external: { url: (icon as { external: string }).external } }
    }
  }
  if (type === 'callout' && typeof props.color === 'string') p.color = props.color
  if (
    type === 'heading_1' ||
    type === 'heading_2' ||
    type === 'heading_3' ||
    type === 'heading_4'
  ) {
    if (typeof props.toggleable === 'boolean') p.is_toggleable = props.toggleable
    if (typeof props.color === 'string') p.color = props.color
  }
  // File-like media blocks (image/video/audio/file/pdf) carry one of two
  // source envelopes per Notion's schema:
  //   external: { url }                       — link to public URL
  //   file_upload: { id }                     — internal uploaded ref
  // Plus an optional `caption: rich_text[]`. `bookmark` and `embed` instead
  // take a bare `url` field.
  if (
    type === 'image' ||
    type === 'video' ||
    type === 'audio' ||
    type === 'file' ||
    type === 'pdf'
  ) {
    if (typeof props.fileUploadId === 'string') {
      p.type = 'file_upload'
      p.file_upload = { id: props.fileUploadId }
    } else if (typeof props.url === 'string') {
      p.type = 'external'
      p.external = { url: props.url }
    }
    if (props.caption !== undefined) {
      p.caption = flattenRichText(props.caption as ReactNode)
    }
  }
  if (type === 'bookmark' && typeof props.url === 'string') p.url = props.url
  if (type === 'embed' && typeof props.url === 'string') p.url = props.url
  if (type === 'equation' && typeof props.expression === 'string') p.expression = props.expression
  if (type === 'link_to_page' && typeof props.pageId === 'string') p.page_id = props.pageId
  if (type === 'child_page') {
    // child_page is a page boundary (nodeKind: 'page'). The legacy block-diff
    // path still treats it as a block-type update and routes the update
    // through `pages.update` via `issueBlockUpdate`. We project `title`
    // verbatim when it's a plain string (preserves the existing contract
    // tested by host-config.unit.test) and pass non-string titles / icon /
    // cover through untouched — `issueBlockUpdate` is responsible for
    // translating them into the `pages.update` body shape.
    if (typeof props.title === 'string') p.title = props.title
    else if (Array.isArray(props.title)) p.title = props.title
    if (props.icon !== undefined) p.icon = props.icon
    if (props.cover !== undefined) p.cover = props.cover
  }
  if (type === 'table') {
    if (typeof props.tableWidth === 'number') p.table_width = props.tableWidth
    if (typeof props.hasColumnHeader === 'boolean') p.has_column_header = props.hasColumnHeader
    if (typeof props.hasRowHeader === 'boolean') p.has_row_header = props.hasRowHeader
  }
  if (type === 'column' && typeof props.widthRatio === 'number') {
    p.width_ratio = props.widthRatio
  }
  if (type === 'table_row' && Array.isArray(props.cells)) {
    // Notion table_row body is `cells: rich_text[][]` — each cell is its own
    // rich_text array. Flatten each cell independently; strings / tagged
    // inlines are supported per flattenRichText.
    p.cells = (props.cells as ReactNode[]).map((cell) => flattenRichText(cell))
  }
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

/**
 * Adopt a child (or its transparent `page_root` descendants) as a top-level
 * entry on `container`. Used by `appendChildToContainer` / `appendChild`
 * when crossing into the container or transiting a `page_root` boundary.
 */
const adoptAsTopLevel = (container: Container, child: Instance): void => {
  if (child.type === 'page_root') {
    // `page_root` never emits a block op; its children graduate to top-level.
    container.pageRoot = child
    for (const nested of child.children) {
      if ('kind' in nested) continue
      nested.parent = null
      adoptAsTopLevel(container, nested)
    }
    return
  }
  const id = container.buffer.append(
    container.rootId,
    child.type as BlockType,
    blockProps(child.type, child.props),
  )
  child.id = id
  container.topLevel.push(child)
  commitChildren(child, container)
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
    type: HostType,
    props: Record<string, unknown>,
    rootContainer: Container,
  ): Instance => ({
    type,
    props,
    id: null,
    blockKey: typeof props.blockKey === 'string' ? props.blockKey : undefined,
    nodeKind: type === 'page_root' || type === 'child_page' ? 'page' : 'block',
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
    adoptAsTopLevel(container, child)
  },

  appendChild: (parent: Instance, child: Instance | TextInstance) => {
    if (parent.type === 'page_root' && !('kind' in child)) {
      // Transparent root wrapper: children graduate to the container's
      // top-level so they emit real block ops instead of queuing as
      // uncommitted descendants of the never-committed `page_root`.
      adoptAsTopLevel(parent.rootContainer, child)
      return
    }
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
    if (parent.type === 'page_root') {
      // `page_root` has no server id: delegate to the container-level insert
      // so the child lands as a top-level block relative to `beforeChild`.
      if (beforeChild.id == null) return
      const container = parent.rootContainer
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
      return
    }
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
    if (parent.type === 'page_root') {
      // Children graduated to the container's top-level via `adoptAsTopLevel`,
      // so delete them from the container's book-keeping, not the page_root.
      const container = parent.rootContainer
      if (child.id != null) container.buffer.remove(child.id)
      const idx = container.topLevel.indexOf(child)
      if (idx >= 0) container.topLevel.splice(idx, 1)
      return
    }
    if (child.id != null) parent.rootContainer.buffer.remove(child.id)
    parent.children = parent.children.filter((c) => c !== child)
  },

  removeChildFromContainer: (container: Container, child: Instance) => {
    if ('kind' in (child as unknown as { kind?: string })) return
    if (child.type === 'page_root') {
      // The transparent wrapper has no server id and its descendants were
      // adopted as top-level; remove each of them instead.
      if (container.pageRoot === child) container.pageRoot = null
      for (const nested of child.children) {
        if ('kind' in nested) continue
        if (nested.id != null) container.buffer.remove(nested.id)
        const idx = container.topLevel.indexOf(nested)
        if (idx >= 0) container.topLevel.splice(idx, 1)
      }
      return
    }
    if (child.id != null) container.buffer.remove(child.id)
    const idx = container.topLevel.indexOf(child)
    if (idx >= 0) container.topLevel.splice(idx, 1)
  },

  commitUpdate: (
    instance: Instance,
    type: HostType,
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
  ) => {
    instance.props = newProps
    // `page_root` has no server id and never emits a block op. Metadata
    // changes on the root wrapper surface via `container.pageRoot.props`;
    // the sync driver wires root-level `pages.update` emission in phase 3b
    // (#618) — deferred here to keep 3a scoped.
    if (type === 'page_root') return
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
  const container: Container = { rootId, buffer, topLevel: [], pageRoot: null }
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
