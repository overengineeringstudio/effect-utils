# pi-tui Research

> Research document for inline terminal rendering with pi-tui.

## Overview

[pi-tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui) (`@mariozechner/pi-tui`) is a minimal terminal UI framework with differential rendering and synchronized output. It's part of the pi-mono toolkit by Mario Zechner.

**Key characteristics:**

- Imperative component model (not React-based)
- Differential rendering with three strategies
- Synchronized output (CSI 2026) for flicker-free updates
- Built-in components: Text, Editor, Markdown, SelectList, etc.
- Used in production by the `pi` coding agent CLI

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          TUI                                     │
│  - Manages component tree                                        │
│  - Orchestrates rendering loop                                   │
│  - Handles input routing                                         │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                ┌───────────────┴───────────────┐
                │                               │
                ▼                               ▼
      ┌─────────────────┐             ┌─────────────────┐
      │    Components   │             │    Terminal     │
      │                 │             │                 │
      │  render(width)  │             │  ProcessTerminal│
      │  handleInput()  │             │  VirtualTerminal│
      └─────────────────┘             └─────────────────┘
```

## Component Interface

All pi-tui components implement:

```typescript
interface Component {
  /** Returns array of strings, one per line. Each line must not exceed width. */
  render(width: number): string[]

  /** Called when component has focus and receives keyboard input */
  handleInput?(data: string): void

  /** Called to clear cached render state */
  invalidate?(): void
}
```

**Key constraint:** Each line returned by `render()` must not exceed the `width` parameter. The TUI will error if any line is wider than the terminal.

## Differential Rendering

pi-tui uses three rendering strategies:

| Strategy          | When             | Behavior                                                                   |
| ----------------- | ---------------- | -------------------------------------------------------------------------- |
| **First Render**  | Initial output   | Output all lines without clearing scrollback                               |
| **Width Changed** | Terminal resized | Clear screen and full re-render                                            |
| **Normal Update** | Typical case     | Move cursor to first changed line, clear to end, render only changed lines |

All updates are wrapped in **synchronized output** (`\x1b[?2026h` ... `\x1b[?2026l`) for atomic, flicker-free rendering.

## Built-in Components

### Layout

| Component   | Purpose                              |
| ----------- | ------------------------------------ |
| `Container` | Groups child components              |
| `Box`       | Padding and background color wrapper |
| `Spacer`    | Empty vertical spacing               |

### Text Display

| Component       | Purpose                                    |
| --------------- | ------------------------------------------ |
| `Text`          | Multi-line text with word wrapping         |
| `TruncatedText` | Single-line text that truncates to fit     |
| `Markdown`      | Rendered markdown with syntax highlighting |

### Input

| Component      | Purpose                             |
| -------------- | ----------------------------------- |
| `Input`        | Single-line text input              |
| `Editor`       | Multi-line editor with autocomplete |
| `SelectList`   | Interactive selection list          |
| `SettingsList` | Settings panel with value cycling   |

### Other

| Component           | Purpose                               |
| ------------------- | ------------------------------------- |
| `Loader`            | Animated loading spinner              |
| `CancellableLoader` | Loader with AbortSignal support       |
| `Image`             | Inline images (Kitty/iTerm2 protocol) |

## API

### TUI (Main Container)

```typescript
import { TUI, Text, ProcessTerminal } from '@mariozechner/pi-tui'

const terminal = new ProcessTerminal()
const tui = new TUI(terminal)

// Add/remove components
tui.addChild(new Text('Hello'))
tui.removeChild(component)

// Lifecycle
tui.start()
tui.stop()

// Request re-render
tui.requestRender()
```

### Overlays

Overlays render on top of existing content (dialogs, menus):

```typescript
const handle = tui.showOverlay(component, {
  width: 60, // Fixed or "80%"
  maxHeight: 20, // Max height
  anchor: 'center', // Position: 'center', 'top-left', 'bottom-right', etc.
  margin: 2, // Edge margin
})

handle.hide() // Remove overlay
handle.setHidden(true) // Temporarily hide
```

### Key Detection

```typescript
import { matchesKey, Key } from '@mariozechner/pi-tui'

if (matchesKey(data, Key.ctrl('c'))) {
  process.exit(0)
}
if (matchesKey(data, Key.enter)) {
  submit()
}
if (matchesKey(data, Key.escape)) {
  cancel()
}
```

### Utilities

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui'

// Get visible width (ignoring ANSI codes)
visibleWidth('\x1b[31mHello\x1b[0m') // 5

// Truncate to width (preserves ANSI, adds ellipsis)
truncateToWidth('Hello World', 8) // "Hello..."

// Wrap text (preserves ANSI across lines)
wrapTextWithAnsi('Long text...', 20) // ["Long text", "..."]
```

## Comparison with Our Needs

### Pros

1. **Battle-tested** - Used in production by pi coding agent
2. **Efficient rendering** - Differential updates with synchronized output
3. **Rich components** - Editor, Markdown, SelectList built-in
4. **Input handling** - Built-in keyboard handling and autocomplete

### Cons

1. **Imperative model** - Not React-based, different paradigm
2. **No layout engine** - Manual positioning, no flexbox
3. **No static regions** - No built-in log-above-progress pattern
4. **Single-tree model** - Components are managed imperatively

### Key Differences from React-based Approach

| Aspect          | pi-tui                   | React-based               |
| --------------- | ------------------------ | ------------------------- |
| Component model | Imperative               | Declarative JSX           |
| Layout          | Manual width management  | Yoga flexbox              |
| State           | Component instances      | React state/hooks         |
| Updates         | `requestRender()`        | Automatic on state change |
| Tree management | `addChild`/`removeChild` | React reconciliation      |

## Integration Options

### Option A: Use pi-tui Directly

Replace our React-based inline renderer with pi-tui's imperative model:

```typescript
import { TUI, Container, Text, Loader } from '@mariozechner/pi-tui'

const renderState = (state: BuildState, tui: TUI) => {
  tui.clear()

  if (state._tag === 'Build.Progress') {
    tui.addChild(new Loader(tui, chalk.cyan, chalk.gray, `Building ${state.package}...`))
  } else if (state._tag === 'Build.Complete') {
    state.packages.forEach((pkg) => {
      tui.addChild(new Text(`✓ ${pkg.name}`))
    })
  }
}

// Subscribe to state and re-render
state.changes.pipe(Stream.runForEach((s) => Effect.sync(() => renderState(s, tui))))
```

**Trade-off:** Lose React's declarative model and component reuse.

### Option B: Hybrid Approach

Use pi-tui's rendering primitives but keep React for component model:

```typescript
// Use pi-tui's differential rendering utilities
import { visibleWidth, truncateToWidth } from '@mariozechner/pi-tui'

// In our InlineRenderer, adopt pi-tui's three-strategy approach
class InlineRenderer {
  private renderDifferential() {
    // Adopt pi-tui's algorithm
  }
}
```

**Trade-off:** Cherry-pick utilities without full integration.

### Option C: Wrap pi-tui in React

Create a React reconciler that targets pi-tui components:

```typescript
// Custom reconciler that creates pi-tui components
const hostConfig = {
  createInstance(type, props) {
    if (type === 'tui-text') return new Text(props.content)
    if (type === 'tui-loader') return new Loader(...)
  },
  appendChild(parent, child) {
    parent.addChild(child)
  }
}
```

**Trade-off:** Complex integration, may not be worth it.

## Recommendation

For our `progressive-visual-inline` mode, we have two viable paths:

1. **Keep current approach** - Our custom React reconciler + InlineRenderer already provides:
   - Differential line rendering
   - Synchronized output
   - Static/dynamic regions
   - React's declarative model

2. **Adopt pi-tui utilities** - Cherry-pick specific utilities:
   - `visibleWidth()` / `truncateToWidth()` for text handling
   - Key detection patterns with `matchesKey()`
   - Consider their three-strategy rendering algorithm

The full switch to pi-tui is likely **not worth it** because:

- We lose React's declarative model
- We lose Yoga layout
- We'd need to rewrite all components
- Our current InlineRenderer already handles the hard parts

## References

- [pi-tui package](https://github.com/badlogic/pi-mono/tree/main/packages/tui)
- [npm: @mariozechner/pi-tui](https://www.npmjs.com/package/@mariozechner/pi-tui)
- [pi-mono repository](https://github.com/badlogic/pi-mono)
