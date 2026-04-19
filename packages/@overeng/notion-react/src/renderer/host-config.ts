import type { ReactNode } from 'react'
// eslint-disable-next-line @typescript-eslint/naming-convention
import ReactReconciler from 'react-reconciler'

import type { BlockType } from '@overeng/notion-effect-schema'

import { flattenRichText } from './flatten-rich-text.ts'
import { OpBuffer } from './op-buffer.ts'

type Instance = {
  type: BlockType | 'raw'
  props: Record<string, unknown>
  id: string | null
  parent: Instance | null
  children: (Instance | TextInstance)[]
  rootContainer: Container
}

type TextInstance = {
  readonly kind: 'text'
  text: string
  parent: Instance | null
}

/** Container driven by the reconciler. */
export type Container = {
  readonly rootId: string
  readonly buffer: OpBuffer
}

/**
 * Block types whose body is a `rich_text[]` array derived from JSX children.
 * Children of these blocks are flattened via `flattenRichText` rather than
 * reconciled as fiber trees.
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
  'toggle',
  'table_row',
])

const shallowEqual = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
  const ak = Object.keys(a)
  const bk = Object.keys(b)
  if (ak.length !== bk.length) return false
  for (const k of ak) if (a[k] !== b[k]) return false
  return true
}

/**
 * Project JSX props onto the Notion block-payload shape for the given type.
 *
 * For v0 this is intentionally narrow: it produces a stable, diffable
 * object but does NOT match the full Notion API schema for every block.
 * The sync driver is responsible for the final API body translation.
 */
const blockProps = (type: BlockType | 'raw', props: Record<string, unknown>): Record<string, unknown> => {
  if (type === 'raw') {
    return { content: props.content }
  }
  const p: Record<string, unknown> = {}
  if (TEXT_LEAF.has(type)) {
    p.rich_text = flattenRichText(props.children as ReactNode)
  }
  if (type === 'to_do' && typeof props.checked === 'boolean') p.checked = props.checked
  if (type === 'toggle' && typeof props.title === 'string') p.title = props.title
  if (type === 'code' && typeof props.language === 'string') p.language = props.language
  if (type === 'callout' && typeof props.icon === 'string') p.icon = props.icon
  if (type === 'callout' && typeof props.color === 'string') p.color = props.color
  if ((type === 'heading_1' || type === 'heading_2' || type === 'heading_3') && typeof props.toggleable === 'boolean') {
    p.is_toggleable = props.toggleable
  }
  if (type === 'image' && typeof props.url === 'string') p.url = props.url
  if (type === 'video' && typeof props.url === 'string') p.url = props.url
  if (type === 'audio' && typeof props.url === 'string') p.url = props.url
  if (type === 'file' && typeof props.url === 'string') p.url = props.url
  if (type === 'pdf' && typeof props.url === 'string') p.url = props.url
  if (type === 'bookmark' && typeof props.url === 'string') p.url = props.url
  if (type === 'embed' && typeof props.url === 'string') p.url = props.url
  if (type === 'equation' && typeof props.expression === 'string') p.expression = props.expression
  if (type === 'link_to_page' && typeof props.pageId === 'string') p.page_id = props.pageId
  if (type === 'child_page' && typeof props.title === 'string') p.title = props.title
  return p
}

const commitChildren = (inst: Instance, container: Container): void => {
  if (inst.id == null) return
  for (const child of inst.children) {
    if ('kind' in child) continue
    if (child.id != null) continue
    const id = container.buffer.append(inst.id, child.type as BlockType, blockProps(child.type, child.props))
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

  // Rich-text leaves project `children` to a rich_text[] via blockProps, so
  // React must NOT recurse into fibers for their children.
  shouldSetTextContent: (type: BlockType | 'raw', _props: Record<string, unknown>) =>
    type !== 'raw' && TEXT_LEAF.has(type as BlockType),

  createInstance: (
    type: BlockType | 'raw',
    props: Record<string, unknown>,
    rootContainer: Container,
  ): Instance => ({ type, props, id: null, parent: null, children: [], rootContainer }),

  createTextInstance: (text: string): TextInstance => ({ kind: 'text', text, parent: null }),

  appendInitialChild: (parent: Instance, child: Instance | TextInstance) => {
    parent.children.push(child)
    child.parent = parent
  },

  finalizeInitialChildren: () => false,

  appendChildToContainer: (container: Container, child: Instance) => {
    const id = container.buffer.append(container.rootId, child.type as BlockType, blockProps(child.type, child.props))
    child.id = id
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
    const id = parent.rootContainer.buffer.append(parent.id, child.type as BlockType, blockProps(child.type, child.props))
    child.id = id
    child.parent = parent
    parent.children.push(child)
    commitChildren(child, parent.rootContainer)
  },

  insertBefore: (parent: Instance, child: Instance | TextInstance, beforeChild: Instance | TextInstance) => {
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
    if (!shallowEqual(oldB, newB) && instance.id != null) {
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
  const container: Container = { rootId, buffer }
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
