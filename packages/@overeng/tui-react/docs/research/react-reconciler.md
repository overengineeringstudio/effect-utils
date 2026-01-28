# react-reconciler Research

> Research document for building custom React renderers.

## Overview

[react-reconciler](https://www.npmjs.com/package/react-reconciler) is React's official package for creating custom renderers. It provides the reconciliation algorithm (diffing, scheduling) while you implement the "host config" that describes how to create and manipulate your target platform's primitives.

**Used by:**
- React DOM (browser)
- React Native (mobile)
- React ART (canvas/SVG)
- ink (terminal)
- react-three-fiber (3D)
- Many others

## Core Concept: Host Config

A "host config" is an object describing how to interact with your target platform:

```typescript
import Reconciler from 'react-reconciler'

const hostConfig = {
  // Create a platform element
  createInstance(type, props) {
    return { type, props, children: [] }
  },
  
  // Create a text node
  createTextInstance(text) {
    return { text }
  },
  
  // Append child to parent
  appendChild(parent, child) {
    parent.children.push(child)
  },
  
  // ... many more methods
}

const MyRenderer = Reconciler(hostConfig)
```

## Modes

### Mutation Mode

For platforms like DOM where nodes are mutated in place:

```typescript
const hostConfig = {
  supportsMutation: true,
  
  appendChild(parent, child) {
    parent.appendChild(child)
  },
  
  removeChild(parent, child) {
    parent.removeChild(child)
  },
  
  commitUpdate(instance, updatePayload, type, prevProps, nextProps) {
    // Mutate instance to match nextProps
  },
}
```

### Persistent Mode

For immutable tree platforms (like React Native Fabric):

```typescript
const hostConfig = {
  supportsPersistence: true,
  
  cloneInstance(instance, updatePayload, type, prevProps, nextProps) {
    return { ...instance, props: nextProps }
  },
}
```

**For terminal UIs, use mutation mode.**

## Required Methods

### Instance Creation

```typescript
// Create element instance
createInstance(
  type: string,           // e.g., 'div', 'tui-box'
  props: object,          // Component props
  rootContainer: any,     // Root container
  hostContext: any,       // Context from parent
  internalHandle: any     // React internal (opaque)
): Instance

// Create text node
createTextInstance(
  text: string,
  rootContainer: any,
  hostContext: any,
  internalHandle: any
): TextInstance
```

### Tree Building (Render Phase)

These run during render - must not cause side effects:

```typescript
// Add child during initial render
appendInitialChild(parent: Instance, child: Instance | TextInstance): void

// Check if element handles its own text content
shouldSetTextContent(type: string, props: object): boolean

// Final setup before connecting to tree
finalizeInitialChildren(
  instance: Instance,
  type: string,
  props: object,
  rootContainer: any,
  hostContext: any
): boolean // Return true if commitMount needed
```

### Tree Mutations (Commit Phase)

These run during commit - can cause side effects:

```typescript
// Add child to parent
appendChild(parent: Instance, child: Instance | TextInstance): void

// Add child to root container
appendChildToContainer(container: Container, child: Instance): void

// Insert before another child
insertBefore(
  parent: Instance,
  child: Instance | TextInstance,
  beforeChild: Instance | TextInstance
): void

// Remove child
removeChild(parent: Instance, child: Instance | TextInstance): void

// Remove from container
removeChildFromContainer(container: Container, child: Instance): void
```

### Updates

```typescript
// Prepare update (can return null to skip)
prepareUpdate(
  instance: Instance,
  type: string,
  prevProps: object,
  nextProps: object,
  rootContainer: any,
  hostContext: any
): UpdatePayload | null

// Apply update
commitUpdate(
  instance: Instance,
  updatePayload: UpdatePayload,
  type: string,
  prevProps: object,
  nextProps: object,
  internalHandle: any
): void

// Update text content
commitTextUpdate(
  textInstance: TextInstance,
  prevText: string,
  nextText: string
): void
```

### Commit Lifecycle

```typescript
// Before commit starts
prepareForCommit(container: Container): object | null

// After commit completes
resetAfterCommit(container: Container): void

// Called if finalizeInitialChildren returned true
commitMount(
  instance: Instance,
  type: string,
  props: object,
  internalHandle: any
): void
```

### Context

```typescript
// Get root context
getRootHostContext(rootContainer: Container): HostContext

// Get child context (for nested elements)
getChildHostContext(
  parentHostContext: HostContext,
  type: string,
  rootContainer: Container
): HostContext
```

### Scheduling

```typescript
// Timeout helpers
scheduleTimeout: typeof setTimeout
cancelTimeout: typeof clearTimeout
noTimeout: -1

// Microtask support (optional)
supportsMicrotasks: boolean
scheduleMicrotask?: typeof queueMicrotask

// Is this the primary renderer?
isPrimaryRenderer: boolean

// Event priority (for concurrent features)
getCurrentEventPriority(): EventPriority
```

## Minimal Terminal Host Config

```typescript
import Reconciler from 'react-reconciler'
import Yoga from 'yoga-layout'

interface TuiElement {
  type: string
  props: Record<string, any>
  yogaNode: Yoga.Node
  children: (TuiElement | TuiTextNode)[]
  parent: TuiElement | null
}

interface TuiTextNode {
  type: 'text'
  text: string
  parent: TuiElement | null
}

interface TuiContainer {
  root: TuiElement | null
  onRender: () => void
}

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  
  createInstance(type, props): TuiElement {
    const yogaNode = Yoga.Node.create()
    applyLayoutProps(yogaNode, props)
    return { type, props, yogaNode, children: [], parent: null }
  },
  
  createTextInstance(text): TuiTextNode {
    return { type: 'text', text, parent: null }
  },
  
  appendInitialChild(parent, child) {
    child.parent = parent
    parent.children.push(child)
    if ('yogaNode' in child) {
      parent.yogaNode.insertChild(child.yogaNode, parent.yogaNode.getChildCount())
    }
  },
  
  appendChild(parent, child) {
    this.appendInitialChild(parent, child)
  },
  
  appendChildToContainer(container, child) {
    container.root = child as TuiElement
  },
  
  removeChild(parent, child) {
    const index = parent.children.indexOf(child)
    if (index !== -1) {
      parent.children.splice(index, 1)
      if ('yogaNode' in child) {
        parent.yogaNode.removeChild(child.yogaNode)
        child.yogaNode.free()
      }
    }
  },
  
  removeChildFromContainer(container, child) {
    if (container.root === child) {
      container.root = null
    }
  },
  
  prepareUpdate() {
    return true // Always update (simple approach)
  },
  
  commitUpdate(instance, payload, type, prevProps, nextProps) {
    instance.props = nextProps
    applyLayoutProps(instance.yogaNode, nextProps)
  },
  
  commitTextUpdate(textInstance, prevText, nextText) {
    textInstance.text = nextText
  },
  
  resetAfterCommit(container) {
    container.onRender() // Trigger terminal render
  },
  
  prepareForCommit() { return null },
  
  getRootHostContext() { return {} },
  getChildHostContext(parent) { return parent },
  getPublicInstance(instance) { return instance },
  
  finalizeInitialChildren() { return false },
  shouldSetTextContent() { return false },
  
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  isPrimaryRenderer: true,
  
  getCurrentEventPriority() { return 16 }, // DefaultEventPriority
  
  // No-ops for features we don't use
  preparePortalMount() {},
  hideInstance() {},
  unhideInstance() {},
  hideTextInstance() {},
  unhideTextInstance() {},
  clearContainer() {},
}

const TuiReconciler = Reconciler(hostConfig)
```

## Using the Reconciler

```typescript
// Create root
function createRoot(onRender: () => void) {
  const container: TuiContainer = { root: null, onRender }
  
  const fiberRoot = TuiReconciler.createContainer(
    container,
    0,     // LegacyRoot
    null,  // hydrationCallbacks
    false, // isStrictMode
    null,  // concurrentUpdatesByDefault
    '',    // identifierPrefix
    () => {}, // onRecoverableError
    null,  // transitionCallbacks
  )
  
  return {
    render(element: React.ReactElement) {
      TuiReconciler.updateContainer(element, fiberRoot, null, () => {})
    },
    unmount() {
      TuiReconciler.updateContainer(null, fiberRoot, null, () => {})
    },
    getRoot() {
      return container.root
    },
  }
}
```

## Lifecycle Flow

```
1. Initial Render
   createInstance() → appendInitialChild() → finalizeInitialChildren()
   → prepareForCommit() → appendChild/appendChildToContainer()
   → commitMount() (if finalizeInitialChildren returned true)
   → resetAfterCommit()

2. Update
   prepareUpdate() → commitUpdate() / commitTextUpdate()
   → resetAfterCommit()

3. Removal
   removeChild() / removeChildFromContainer()
   → resetAfterCommit()
```

## Key Insights for Terminal Renderers

### 1. Use `resetAfterCommit` for Output

This is called after React finishes all mutations - perfect for triggering terminal render:

```typescript
resetAfterCommit(container) {
  if (container.root) {
    const lines = renderTreeToLines(container.root)
    writeToTerminal(lines)
  }
}
```

### 2. Yoga Integration

Pair Yoga nodes with React elements:
- Create Yoga node in `createInstance`
- Update Yoga props in `commitUpdate`
- Build Yoga tree in `appendChild`
- Free Yoga nodes in `removeChild`
- Calculate layout in `resetAfterCommit` before rendering

### 3. Text Handling

Two approaches:
- **Text elements**: Create text nodes, handle in render
- **shouldSetTextContent**: Return true for elements that manage their own text

### 4. Keep Host Config Simple

For terminal UIs:
- Skip hydration (not needed)
- Skip persistence (use mutation)
- Skip concurrent features initially
- Focus on the core: create, append, remove, update

## References

- [react-reconciler README](https://github.com/facebook/react/tree/main/packages/react-reconciler)
- [Building a Custom React Renderer](https://medium.com/@agent_hunt/hello-world-custom-react-renderer-9a95b7cd04bc)
- [React ART host config](https://github.com/facebook/react/blob/main/packages/react-art/src/ReactFiberConfigART.js)
- [ink reconciler](https://github.com/vadimdemedes/ink/blob/master/src/reconciler.ts)
