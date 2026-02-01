# react-reconciler Research

> Research document for building custom React renderers with react-reconciler 0.33 (React 19).

## Overview

[react-reconciler](https://www.npmjs.com/package/react-reconciler) is React's official package for creating custom renderers. It provides the reconciliation algorithm (diffing, scheduling) while you implement the "host config" that describes how to create and manipulate your target platform's primitives.

**Used by:** React DOM, React Native, ink (terminal), react-three-fiber (3D), OpenTUI (terminal), and our tui-react.

## Host Config

A "host config" is an object describing how to interact with your target platform:

```typescript
import Reconciler from 'react-reconciler'

const hostConfig = {
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,

  createInstance(type, props) {
    /* ... */
  },
  createTextInstance(text) {
    /* ... */
  },
  appendChild(parent, child) {
    /* ... */
  },
  commitUpdate(instance, type, oldProps, newProps) {
    /* ... */
  },
  // ... many more methods
}

const MyRenderer = Reconciler(hostConfig)
```

For terminal UIs, use **mutation mode** (`supportsMutation: true`).

## React 19 API Changes (0.32 → 0.33)

These are the significant breaking changes from React 18 to React 19 reconciler:

### `commitUpdate` signature changed

The `updatePayload` parameter was removed. This is the most impactful change for custom renderers.

```typescript
// Old (React 18 / pre-0.32) — DO NOT USE
commitUpdate(instance, updatePayload, type, prevProps, nextProps) { ... }

// New (React 19 / 0.33)
commitUpdate(instance, type, oldProps, newProps) { ... }
```

**Pitfall:** Because host config methods are loosely typed, TypeScript won't catch a signature mismatch. If you use the old signature, all parameters shift by one position — `type` receives old props, `oldProps` receives new props, etc. — and `commitUpdate` silently does nothing.

Reference: [pmndrs/react-three-fiber#3224](https://github.com/pmndrs/react-three-fiber/pull/3224)

### `prepareUpdate` return value ignored

In React 19, `prepareUpdate` is still called but its return value is **ignored** in mutation mode. `commitUpdate` is always called when props differ. Returning `true` unconditionally is fine.

### New required fields

React 19 / react-reconciler 0.33 requires these additional host config fields:

```typescript
// Transition support
NotPendingTransition: null,
HostTransitionContext: createContext(null),
resetFormInstance() {},
requestPostPaintCallback() {},
shouldAttemptEagerTransition() { return false },

// Event system
resolveEventTimeStamp() { return Date.now() },
resolveEventType() { return null },
resolveEventPriority() { return 16 }, // DefaultEventPriority
trackSchedulerEvent() {},

// Suspense (must be present even if unused)
maySuspendCommit() { return false },
preloadInstance() { return true },
startSuspendingCommit() {},
suspendInstance() {},
waitForCommitToBeReady() { return null },
```

## Required Host Config Methods

### Instance Creation

```typescript
createInstance(type: string, props: object): Instance
createTextInstance(text: string): TextInstance
```

### Tree Building (Render Phase)

No side effects allowed:

```typescript
appendInitialChild(parent: Instance, child: Instance | TextInstance): void
shouldSetTextContent(type: string, props: object): boolean
finalizeInitialChildren(instance, type, props, rootContainer, hostContext): boolean
```

### Tree Mutations (Commit Phase)

```typescript
appendChild(parent: Instance, child: Instance | TextInstance): void
appendChildToContainer(container: Container, child: Instance): void
insertBefore(parent: Instance, child: Instance | TextInstance, beforeChild: Instance | TextInstance): void
removeChild(parent: Instance, child: Instance | TextInstance): void
removeChildFromContainer(container: Container, child: Instance): void
clearContainer(container: Container): void
```

### Updates

```typescript
// Return truthy to signal update needed (return value ignored in React 19 mutation mode)
prepareUpdate(): any

// Apply prop changes to an existing instance — React 19 signature
commitUpdate(instance: Instance, type: string, oldProps: object, newProps: object): void

// Update text content
commitTextUpdate(textInstance: TextInstance, oldText: string, newText: string): void
```

### Commit Lifecycle

```typescript
prepareForCommit(container: Container): object | null
resetAfterCommit(container: Container): void
```

### Context

```typescript
getRootHostContext(rootContainer: Container): HostContext
getChildHostContext(parentHostContext: HostContext, type: string): HostContext
```

### Scheduling & Priority

```typescript
scheduleTimeout: typeof setTimeout
cancelTimeout: typeof clearTimeout
noTimeout: -1
isPrimaryRenderer: boolean

supportsMicrotasks: boolean
scheduleMicrotask: (fn: () => void) => void

getCurrentEventPriority(): number   // 16 = DefaultEventPriority
resolveUpdatePriority(): number
getCurrentUpdatePriority(): number
setCurrentUpdatePriority(priority: number): void
```

## Key Insights for Terminal Renderers

### 1. Use `resetAfterCommit` for Output

Called after React finishes all mutations — trigger terminal render here:

```typescript
resetAfterCommit(container) {
  container.onRender()
}
```

### 2. Yoga Integration

Pair Yoga nodes with React elements:

- Create Yoga node in `createInstance`
- Update Yoga props in `commitUpdate`
- Build Yoga tree in `appendChild` / `appendInitialChild`
- Free Yoga nodes in `removeChild` / `removeChildFromContainer`
- Calculate layout in the render path (before writing to terminal)

### 3. `clearContainer` Should Actually Clear

`clearContainer` is called before `appendChildToContainer` during certain commit phases. Implement it properly — a no-op can leave stale state:

```typescript
clearContainer(container) {
  if (container.root) {
    freeYogaNode(container.root.yogaNode)
    container.root = null
  }
}
```

### 4. Microtask Tracking for Synchronous Flush

When `supportsMicrotasks` is true, React schedules passive effects (useEffect, useSyncExternalStore) via microtasks. To flush synchronously (needed for terminal output before unmount), wrap `scheduleMicrotask` to track pending work:

```typescript
const pendingMicrotasks: Array<() => void> = []

scheduleMicrotask: (fn) => {
  pendingMicrotasks.push(fn)
  queueMicrotask(() => {
    const index = pendingMicrotasks.indexOf(fn)
    if (index !== -1) {
      pendingMicrotasks.splice(index, 1)
      fn()
    }
  })
}

// Call before rendering to ensure all React work is done
function flushPendingMicrotasks() {
  while (pendingMicrotasks.length > 0) {
    pendingMicrotasks.shift()!()
  }
}
```

### 5. Render Batching via Microtask

React can trigger multiple commit phases for a single update (e.g., effect cleanup + re-render). Batch renders via microtask in `resetAfterCommit` to avoid rendering intermediate states:

```typescript
resetAfterCommit(container) {
  if (!microtaskScheduled) {
    microtaskScheduled = true
    queueMicrotask(() => {
      microtaskScheduled = false
      scheduleRender()
    })
  }
}
```

### 6. `doFlush()` Double-Update Pattern

For `useSyncExternalStore` subscriptions, a single flush loop may not pick up store changes that arrive during passive effects. Re-rendering the same element forces React to call `getSnapshot()` again:

```typescript
function doFlush() {
  // Phase 1: flush all pending React work
  for (let i = 0; i < 20; i++) {
    reconciler.flushPassiveEffects()
    reconciler.flushSyncWork()
    flushPendingMicrotasks()
  }

  // Phase 2: re-render to pick up store changes from effects
  if (lastRenderedElement) {
    reconciler.updateContainerSync(
      wrapWithProviders(lastRenderedElement),
      fiberRoot,
      null,
      () => {},
    )
    for (let i = 0; i < 20; i++) {
      reconciler.flushPassiveEffects()
      reconciler.flushSyncWork()
      flushPendingMicrotasks()
    }
  }

  doRender()
}
```

## Comparison with OpenTUI

[OpenTUI](https://github.com/sst/opentui) is a terminal React renderer using react-reconciler 0.32. Key differences from our implementation:

| Aspect                  | OpenTUI                           | tui-react                         |
| ----------------------- | --------------------------------- | --------------------------------- |
| Container model         | Stateful object with add/remove   | Plain `{ root, onRender }` object |
| `clearContainer`        | Removes all children              | Frees yoga node, clears root      |
| Root type               | ConcurrentRoot                    | LegacyRoot                        |
| `detachDeletedInstance` | Recursive destroy                 | No-op (cleanup via removeChild)   |
| `commitUpdate`          | Calls `updateProperties` + render | Updates props + yoga layout       |

Both implementations now use the correct React 19 `commitUpdate` signature.

## References

- [react-reconciler README](https://github.com/facebook/react/tree/main/packages/react-reconciler)
- [react-three-fiber React 19 migration](https://github.com/pmndrs/react-three-fiber/pull/3224) — documents `commitUpdate` signature change
- [ink reconciler](https://github.com/vadimdemedes/ink/blob/master/src/reconciler.ts)
- [OpenTUI host config](https://github.com/sst/opentui/blob/main/packages/react/src/reconciler/host-config.ts)
- [facebook/react#13006](https://github.com/facebook/react/issues/13006) — Core Q&A about react-reconciler
