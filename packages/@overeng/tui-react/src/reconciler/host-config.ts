/**
 * React Reconciler Host Config.
 *
 * This defines how React interacts with our TUI rendering system.
 * Implements the required methods for react-reconciler.
 */

import { createContext } from 'react'

import type {
  TuiNode,
  TuiElement,
  TuiTextNode,
  TuiBoxElement,
  TuiTextElement,
  TuiStaticElement,
  BoxNodeProps,
  TextNodeProps,
} from './types.ts'
import { isElement } from './types.ts'
import { createYogaNode, applyBoxProps, freeYogaNode } from './yoga-utils.ts'

// =============================================================================
// Types
// =============================================================================

/** The container that holds the root of the tree */
export interface TuiContainer {
  /** Root element of the tree */
  root: TuiBoxElement | null
  /** Callback to trigger re-render */
  onRender: () => void
}

type Instance = TuiElement
type TextInstance = TuiTextNode

// =============================================================================
// Microtask Tracking
// =============================================================================

/**
 * Pending microtasks scheduled by React that haven't run yet.
 * This allows flush() to synchronously process all pending React work.
 */
const pendingMicrotasks: Array<() => void> = []

/**
 * Flush all pending microtasks synchronously.
 * Call this before rendering to ensure React has finished all its work.
 */
export const flushPendingMicrotasks = (): void => {
  // Process all pending microtasks. As we process them, React might schedule
  // more work, so we loop until the queue is empty.
  while (pendingMicrotasks.length > 0) {
    const fn = pendingMicrotasks.shift()!
    fn()
  }
}

// =============================================================================
// Helper functions
// =============================================================================

const appendChild = ({ parent, child }: { parent: Instance; child: TuiNode }): void => {
  // Remove from old parent if any
  if (child.parent !== null && isElement(child.parent) === true) {
    removeChild({ parent: child.parent, child })
  }

  child.parent = parent
  parent.children.push(child)

  // Update yoga tree
  if (isElement(child) === true) {
    parent.yogaNode.insertChild(child.yogaNode, parent.yogaNode.getChildCount())
  }
}

const removeChild = ({ parent, child }: { parent: Instance; child: TuiNode }): void => {
  const index = parent.children.indexOf(child)
  if (index === -1) return

  parent.children.splice(index, 1)
  child.parent = null

  // Update yoga tree
  if (isElement(child) === true) {
    parent.yogaNode.removeChild(child.yogaNode)
  }
}

// =============================================================================
// Host Config Implementation
// =============================================================================

/** React reconciler host config that maps React operations to the TUI node tree and Yoga layout engine. */
export const hostConfig = {
  // Configuration
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  // Enable microtask scheduling for passive effects (useEffect, useSyncExternalStore).
  // Without this, React hooks that set up subscriptions during the commit phase won't work,
  // because the reconciler won't schedule the passive effect callbacks.
  supportsMicrotasks: true,
  isPrimaryRenderer: true,
  noTimeout: -1,

  // Instance creation
  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  createInstance(type: string, props: Record<string, unknown>): Instance {
    const yogaNode = createYogaNode()

    switch (type) {
      case 'tui-box': {
        const boxProps = props as BoxNodeProps
        applyBoxProps({ node: yogaNode, props: boxProps })
        return {
          type: 'tui-box',
          parent: null,
          yogaNode,
          props: boxProps,
          children: [],
        } satisfies TuiBoxElement
      }

      case 'tui-text': {
        const textProps = props as TextNodeProps
        return {
          type: 'tui-text',
          parent: null,
          yogaNode,
          props: textProps,
          children: [],
        } satisfies TuiTextElement
      }

      case 'tui-static': {
        return {
          type: 'tui-static',
          parent: null,
          yogaNode,
          props: {},
          children: [],
          committedCount: 0,
        } satisfies TuiStaticElement
      }

      default:
        throw new Error(
          `Unknown element type: "${type}"\n\n` +
            `The TUI reconciler only supports these element types:\n` +
            `  - tui-box (via <Box>)\n` +
            `  - tui-text (via <Text>)\n` +
            `  - tui-static (via <Static>)\n\n` +
            `Common causes:\n` +
            `  - Using HTML elements (div, span, button) instead of TUI components\n` +
            `  - Nested TerminalPreview components (Storybook decorator + story wrapper)\n` +
            `  - Third-party components that render HTML\n\n` +
            `If in Storybook, ensure you're not double-wrapping with TerminalPreview.`,
        )
    }
  },

  createTextInstance(text: string): TextInstance {
    return {
      type: 'tui-text-node',
      parent: null,
      text,
    }
  },

  // Tree operations
  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  appendInitialChild(parent: Instance, child: TuiNode) {
    appendChild({ parent, child })
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  appendChild(parent: Instance, child: TuiNode) {
    appendChild({ parent, child })
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  appendChildToContainer(container: TuiContainer, child: TuiNode) {
    if (isElement(child) === true) {
      container.root = child as TuiBoxElement
    }
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  insertBefore(parent: Instance, child: TuiNode, beforeChild: TuiNode) {
    const index = parent.children.indexOf(beforeChild)
    if (index === -1) {
      appendChild({ parent, child })
      return
    }

    if (child.parent !== null && isElement(child.parent) === true) {
      removeChild({ parent: child.parent, child })
    }

    child.parent = parent
    parent.children.splice(index, 0, child)

    if (isElement(child) === true) {
      parent.yogaNode.insertChild(child.yogaNode, index)
    }
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  insertInContainerBefore(container: TuiContainer, child: TuiNode, _beforeChild: TuiNode) {
    if (isElement(child) === true) {
      container.root = child as TuiBoxElement
    }
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  removeChild(parent: Instance, child: TuiNode) {
    removeChild({ parent, child })
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  removeChildFromContainer(container: TuiContainer, child: TuiNode) {
    if (container.root === child) {
      container.root = null
    }
    if (isElement(child) === true) {
      freeYogaNode(child.yogaNode)
    }
  },

  clearContainer(container: TuiContainer) {
    if (container.root !== null) {
      freeYogaNode(container.root.yogaNode)
      container.root = null
    }
  },

  // Updates
  prepareUpdate() {
    return true
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  commitUpdate(
    instance: Instance,
    type: string,
    oldProps: Record<string, unknown>,
    newProps: Record<string, unknown>,
  ) {
    if (type === 'tui-box') {
      const boxInstance = instance as TuiBoxElement
      boxInstance.props = newProps as BoxNodeProps
      applyBoxProps({ node: boxInstance.yogaNode, props: boxInstance.props })
    } else if (type === 'tui-text') {
      const textInstance = instance as TuiTextElement
      textInstance.props = newProps as TextNodeProps
    }
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  commitTextUpdate(textInstance: TextInstance, _oldText: string, newText: string) {
    textInstance.text = newText
  },

  // Commit phase
  prepareForCommit() {
    return null
  },

  resetAfterCommit(container: TuiContainer) {
    container.onRender()
  },

  // Context
  getRootHostContext() {
    return {}
  },

  getChildHostContext(parentContext: Record<string, unknown>) {
    return parentContext
  },

  // Misc
  getPublicInstance(instance: Instance | TextInstance) {
    return instance
  },

  preparePortalMount() {},

  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  // Required when supportsMicrotasks is true. React uses this to schedule passive effects
  // (useEffect callbacks, useSyncExternalStore subscriptions) after the commit phase.
  // The subscription setup for useSyncExternalStore happens via microtask, which is why
  // both supportsMicrotasks and scheduleMicrotask must be configured for hooks to work.
  //
  // We wrap the default scheduleMicrotask to track pending work, allowing flush() to
  // synchronously process all scheduled microtasks before rendering.
  scheduleMicrotask: (fn: () => void) => {
    pendingMicrotasks.push(fn)
    queueMicrotask(() => {
      // Only run if still in queue (not flushed synchronously)
      const index = pendingMicrotasks.indexOf(fn)
      if (index !== -1) {
        pendingMicrotasks.splice(index, 1)
        fn()
      }
    })
  },

  // Priority constants from React internals
  // DiscreteEventPriority = 2
  // ContinuousEventPriority = 8
  // DefaultEventPriority = 16
  // IdleEventPriority = 536870912

  getCurrentEventPriority() {
    return 16 // DefaultEventPriority
  },

  resolveUpdatePriority() {
    return 16 // DefaultEventPriority
  },

  getCurrentUpdatePriority() {
    return 16 // DefaultEventPriority
  },

  setCurrentUpdatePriority(_priority: number) {
    // No-op for TUI
  },

  getInstanceFromNode() {
    return null
  },

  beforeActiveInstanceBlur() {},
  afterActiveInstanceBlur() {},
  prepareScopeUpdate() {},
  getInstanceFromScope() {
    return null
  },
  detachDeletedInstance(_instance: Instance) {
    // Yoga node cleanup is handled by removeChild/removeChildFromContainer.
    // We intentionally don't free here to avoid double-free issues.
  },

  finalizeInitialChildren() {
    return false
  },

  shouldSetTextContent() {
    return false
  },

  hideInstance() {},
  unhideInstance() {},
  hideTextInstance() {},
  unhideTextInstance() {},
  resetTextContent() {},

  // React 19 / react-reconciler 0.32 required methods
  maySuspendCommit() {
    return false
  },
  preloadInstance() {
    return true
  },
  startSuspendingCommit() {},
  suspendInstance() {},
  waitForCommitToBeReady() {
    return null
  },

  // React 19 / react-reconciler 0.33 required methods
  NotPendingTransition: null as null,
  HostTransitionContext: createContext(null),
  resetFormInstance() {},
  requestPostPaintCallback() {},
  shouldAttemptEagerTransition() {
    return false
  },
  resolveEventTimeStamp() {
    return Date.now()
  },
  resolveEventType() {
    return null // Not event-driven
  },
  resolveEventPriority() {
    return 16 // DefaultEventPriority
  },
  trackSchedulerEvent() {
    // No-op for TUI
  },
}
