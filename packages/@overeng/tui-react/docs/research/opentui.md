# OpenTUI Research

> Research document for integrating OpenTUI as the alternate screen renderer.

## Overview

[OpenTUI](https://github.com/anomalyco/opentui) is a TypeScript library for building terminal user interfaces. It provides a component-based architecture with Yoga layout, making it an ideal fit for our `progressive-visual-alternate` mode.

**Key facts:**
- MIT licensed, actively maintained
- Used by [opencode](https://opencode.ai) and [terminal.shop](https://terminal.shop)
- React reconciler available (`@opentui/react`)
- Uses Yoga for layout (same as our tui-react)
- Full-screen alternate buffer mode
- Built-in input handling

## Packages

| Package | Purpose |
|---------|---------|
| `@opentui/core` | Core library with imperative API and primitives |
| `@opentui/react` | React reconciler for declarative UI |
| `@opentui/solid` | SolidJS reconciler (alternative) |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     React Components                             │
│              <box><text>Hello</text></box>                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                   @opentui/react Reconciler                      │
│  - Maps JSX to OpenTUI Renderables                              │
│  - Handles React lifecycle                                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      CliRenderer                                 │
│  - Manages terminal output                                       │
│  - Handles input events                                          │
│  - Orchestrates render loop (capped FPS)                        │
│  - Yoga layout engine                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Alternate Screen Buffer                       │
│  - Full terminal takeover                                        │
│  - No scrollback                                                 │
│  - Restored on exit                                              │
└─────────────────────────────────────────────────────────────────┘
```

## API

### Renderer Creation

```typescript
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

const renderer = await createCliRenderer({
  exitOnCtrlC: true,  // Handle Ctrl+C
  // ... other options
})

createRoot(renderer).render(<App />)
```

### Components

**Layout & Display:**
- `<text>` - Styled text with colors and attributes
- `<box>` - Container with borders, padding, flexbox layout
- `<scrollbox>` - Scrollable container
- `<ascii-font>` - ASCII art text

**Input:**
- `<input>` - Single-line text input
- `<textarea>` - Multi-line text input
- `<select>` - Selection list
- `<tab-select>` - Tab-based selection

**Code:**
- `<code>` - Syntax-highlighted code
- `<line-number>` - Code with line numbers and diff highlights
- `<diff>` - Unified/split diff viewer

### Hooks

```typescript
// Access renderer instance
const renderer = useRenderer()

// Keyboard input
useKeyboard((key: KeyEvent) => {
  if (key.name === 'escape') process.exit(0)
  if (key.ctrl && key.name === 'c') process.exit(0)
}, { release: false })

// Terminal resize
useOnResize((width, height) => {
  console.log(`Resized to ${width}x${height}`)
})

// Terminal dimensions (reactive)
const { width, height } = useTerminalDimensions()

// Animation timeline
const timeline = useTimeline({ duration: 1000, loop: false })
```

### KeyEvent Structure

```typescript
interface KeyEvent {
  name: string       // Key name ('escape', 'return', 'a', etc.)
  sequence: string   // Raw escape sequence
  ctrl: boolean      // Ctrl modifier
  shift: boolean     // Shift modifier
  meta: boolean      // Alt/Meta modifier
  option: boolean    // Option modifier (macOS)
  repeated: boolean  // Key repeat
  eventType: 'press' | 'release'
}
```

## Comparison with tui-react

| Feature | tui-react | OpenTUI |
|---------|-----------|---------|
| **Mode** | Inline (scrollback) | Alternate (full-screen) |
| **Layout** | Yoga | Yoga |
| **Reconciler** | Custom react-reconciler | Custom react-reconciler |
| **Input handling** | Not built-in | Built-in (useKeyboard) |
| **Resize handling** | Manual | Built-in (useOnResize) |
| **Static regions** | Yes (`<Static>`) | No (full-screen) |
| **Scrollback** | Preserved | Not available |
| **Animation** | Not built-in | Built-in (useTimeline) |
| **Focus management** | Not built-in | Built-in |

## Integration Strategy

### Shared Components

Both tui-react and OpenTUI use similar component models. We can create shared component abstractions:

```typescript
// Shared component interface
interface BoxProps {
  flexDirection?: 'row' | 'column'
  padding?: number
  border?: boolean
  // ...
}

// tui-react implementation
export const Box: React.FC<BoxProps> = (props) => {
  // Uses tui-react's Box
}

// OpenTUI implementation  
export const Box: React.FC<BoxProps> = (props) => {
  // Uses @opentui/react's box
}
```

### Mode-Based Renderer Selection

```typescript
import { createRoot as createTuiRoot } from '@overeng/tui-react'
import { createRoot as createOpenTuiRoot, createCliRenderer } from '@opentui/react'

const createRenderer = async (config: OutputConfig) => {
  if (config.screen === 'alternate') {
    const renderer = await createCliRenderer()
    return createOpenTuiRoot(renderer)
  } else {
    return createTuiRoot(process.stdout)
  }
}
```

### Event Bridging

OpenTUI's keyboard events can be bridged to our PubSub system:

```typescript
import { useKeyboard } from '@opentui/react'
import { PubSub } from 'effect'

const useEventBridge = (events: PubSub.PubSub<InputEvent>) => {
  useKeyboard((key) => {
    Effect.runSync(PubSub.publish(events, {
      _tag: 'Event.Key',
      key: key.name,
      ctrl: key.ctrl,
      alt: key.meta,
      shift: key.shift,
    }))
  })
  
  useOnResize((cols, rows) => {
    Effect.runSync(PubSub.publish(events, {
      _tag: 'Event.Resize',
      cols,
      rows,
    }))
  })
}
```

## Requirements for Integration

### Dependencies

```json
{
  "dependencies": {
    "@opentui/core": "^0.1.75",
    "@opentui/react": "^0.1.75"
  }
}
```

**Note:** OpenTUI requires Zig to be installed for building native components.

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@opentui/react"
  }
}
```

For mixed usage (tui-react inline + OpenTUI alternate), use explicit JSX pragmas:

```tsx
/** @jsxImportSource @opentui/react */
// This file uses OpenTUI components

/** @jsxImportSource react */
// This file uses tui-react components
```

## Considerations

### Pros

1. **Production-ready** - Used by opencode and terminal.shop
2. **Full-featured** - Input, focus, animation built-in
3. **Same layout engine** - Yoga, familiar flexbox model
4. **React-based** - Same mental model as tui-react
5. **Active development** - Regular releases, responsive maintainers

### Cons

1. **Native dependency** - Requires Zig for building
2. **Different JSX** - May need separate component trees
3. **No static regions** - Different model from inline mode
4. **Larger bundle** - More features = more code

### Mitigation Strategies

1. **Optional dependency** - Only install OpenTUI when alternate mode is used
2. **Adapter layer** - Abstract common components behind shared interface
3. **Clear mode separation** - Don't mix inline and alternate in same command

## Example: Alternate Mode App

```tsx
/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot, useKeyboard, useTerminalDimensions } from "@opentui/react"
import { useState, useEffect } from "react"

interface AppProps {
  state: SubscriptionRef.SubscriptionRef<SyncState>
  events: PubSub.PubSub<InputEvent>
}

function App({ state, events }: AppProps) {
  const [syncState, setSyncState] = useState<SyncState>({ _tag: 'Sync.Idle' })
  const { width, height } = useTerminalDimensions()
  
  // Subscribe to state changes
  useEffect(() => {
    const fiber = Effect.runFork(
      state.changes.pipe(
        Stream.runForEach(s => Effect.sync(() => setSyncState(s)))
      )
    )
    return () => Effect.runSync(Fiber.interrupt(fiber))
  }, [state])
  
  // Bridge keyboard events
  useKeyboard((key) => {
    Effect.runSync(PubSub.publish(events, {
      _tag: 'Event.Key',
      key: key.name,
      ctrl: key.ctrl,
    }))
  })
  
  return (
    <box style={{ width, height, border: true, padding: 1 }}>
      <text fg="#00ff00">Sync Status</text>
      {syncState._tag === 'Sync.Progress' && (
        <box>
          <text>Syncing: {syncState.member}</text>
          <text>{syncState.current}/{syncState.total}</text>
        </box>
      )}
      {syncState._tag === 'Sync.Complete' && (
        <box>
          <text fg="#00ff00">Complete!</text>
          {syncState.results.map(r => (
            <text key={r.member}>{r.member}: {r.status}</text>
          ))}
        </box>
      )}
      <text dim>Press 'q' to quit</text>
    </box>
  )
}

// Entry point
const renderer = await createCliRenderer({ exitOnCtrlC: true })
createRoot(renderer).render(<App state={commandState} events={commandEvents} />)
```

## References

- [OpenTUI GitHub](https://github.com/anomalyco/opentui)
- [OpenTUI Website](https://opentui.com)
- [@opentui/react README](https://github.com/anomalyco/opentui/tree/main/packages/react)
- [Getting Started Guide](https://github.com/anomalyco/opentui/blob/main/packages/core/docs/getting-started.md)
