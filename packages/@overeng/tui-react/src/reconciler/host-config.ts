/**
 * React Reconciler Host Config.
 *
 * This defines how React interacts with our TUI rendering system.
 * Implements the required methods for react-reconciler.
 */

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
// Helper functions
// =============================================================================

const appendChild = ({ parent, child }: { parent: Instance; child: TuiNode }): void => {
  // Remove from old parent if any
  if (child.parent && isElement(child.parent)) {
    removeChild({ parent: child.parent, child })
  }

  child.parent = parent
  parent.children.push(child)

  // Update yoga tree
  if (isElement(child)) {
    parent.yogaNode.insertChild(child.yogaNode, parent.yogaNode.getChildCount())
  }
}

const removeChild = ({ parent, child }: { parent: Instance; child: TuiNode }): void => {
  const index = parent.children.indexOf(child)
  if (index === -1) return

  parent.children.splice(index, 1)
  child.parent = null

  // Update yoga tree
  if (isElement(child)) {
    parent.yogaNode.removeChild(child.yogaNode)
  }
}

// =============================================================================
// Host Config Implementation
// =============================================================================

export const hostConfig = {
  // Configuration
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
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
    if (isElement(child)) {
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

    if (child.parent && isElement(child.parent)) {
      removeChild({ parent: child.parent, child })
    }

    child.parent = parent
    parent.children.splice(index, 0, child)

    if (isElement(child)) {
      parent.yogaNode.insertChild(child.yogaNode, index)
    }
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  insertInContainerBefore(container: TuiContainer, child: TuiNode, _beforeChild: TuiNode) {
    if (isElement(child)) {
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
    if (isElement(child)) {
      freeYogaNode(child.yogaNode)
    }
  },

  clearContainer(_container: TuiContainer) {
    // Note: clearContainer is called before appendChildToContainer in the commit phase.
    // We don't want to clear the root here since appendChildToContainer will set the new root.
    // Cleanup is handled by removeChildFromContainer instead.
  },

  // Updates
  prepareUpdate() {
    return true
  },

  // oxlint-disable-next-line overeng/named-args -- React reconciler API
  commitUpdate(
    instance: Instance,
    _updatePayload: unknown,
    type: string,
    _oldProps: unknown,
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
  detachDeletedInstance() {},

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
}
