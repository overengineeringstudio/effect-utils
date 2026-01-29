# @overeng/tui-react

React renderer for terminal UI with Effect integration.

## Features

- **React-based** - Use familiar React patterns for terminal UIs
- **Flexbox layout** - Powered by Yoga for flexible layouts
- **Effect integration** - First-class support for Effect-based CLIs
- **Multiple output modes** - Visual, JSON, and streaming modes
- **Universal components** - Renderer-agnostic components for future OpenTUI support

## Installation

```bash
pnpm add @overeng/tui-react
```

## Quick Start

### Basic React Rendering

```tsx
import { createRoot, Box, Text, Spinner } from '@overeng/tui-react'

const App = () => (
  <Box flexDirection="column" padding={1}>
    <Box flexDirection="row">
      <Spinner />
      <Text> Loading...</Text>
    </Box>
    <Text color="green">Ready!</Text>
  </Box>
)

const root = createRoot(process.stdout)
root.render(<App />)

// Later: root.unmount()
```

### Effect CLI Integration

Use `createTuiApp` for mode-dependent rendering in Effect-based CLIs:

```tsx
import { Effect, Schema } from 'effect'
import { createTuiApp, useTuiAppState, progressiveVisualLayer, Box, Text } from '@overeng/tui-react'

// 1. Define state and action schemas
const AppState = Schema.Struct({
  status: Schema.String,
  progress: Schema.Number,
})
type AppState = Schema.Schema.Type<typeof AppState>

const AppAction = Schema.Union(
  Schema.TaggedStruct('SetProgress', { progress: Schema.Number }),
  Schema.TaggedStruct('Complete', {}),
)
type AppAction = Schema.Schema.Type<typeof AppAction>

// 2. Define reducer
const appReducer = (state: AppState, action: AppAction): AppState => {
  switch (action._tag) {
    case 'SetProgress':
      return { ...state, status: 'Processing', progress: action.progress }
    case 'Complete':
      return { status: 'Complete', progress: 100 }
  }
}

// 3. Create the TuiApp
const MyApp = createTuiApp({
  stateSchema: AppState,
  actionSchema: AppAction,
  initial: { status: 'Starting', progress: 0 },
  reducer: appReducer,
})

// 4. Define view using hooks
const AppView = () => {
  const state = useTuiAppState<AppState>()
  return (
    <Box>
      <Text>
        {state.status}: {state.progress}%
      </Text>
    </Box>
  )
}

// 5. Use in Effect
const program = Effect.gen(function* () {
  const tui = yield* MyApp.run(<AppView />)

  tui.dispatch({ _tag: 'SetProgress', progress: 50 })
  yield* Effect.sleep('1 second')
  tui.dispatch({ _tag: 'Complete' })
}).pipe(Effect.scoped)

// Run with mode layer
Effect.runPromise(program.pipe(Effect.provide(progressiveVisualLayer)))
```

### Universal Components

Renderer-agnostic components that work across inline and alternate screen modes:

```tsx
import { Universal } from '@overeng/tui-react'

const { AutoAdapterProvider, Box, Text, Spinner, IfCapability } = Universal

const App = () => (
  <AutoAdapterProvider>
    <Box>
      <Spinner label="Loading..." />

      <IfCapability capability="scroll" fallback={<Text>No scroll</Text>}>
        <Universal.ScrollBox height={10}>{/* Scrollable content */}</Universal.ScrollBox>
      </IfCapability>
    </Box>
  </AutoAdapterProvider>
)
```

## Output Modes

| Mode                           | Description                | Use Case             |
| ------------------------------ | -------------------------- | -------------------- |
| `progressive-visual`           | Real-time React rendering  | Interactive TTY      |
| `progressive-visual-alternate` | Full-screen mode (OpenTUI) | Complex UIs          |
| `final-visual`                 | No progressive output      | Batch processing     |
| `final-json`                   | JSON output on completion  | CI/CD, piping        |
| `progressive-json`             | NDJSON streaming           | Real-time monitoring |

```tsx
import {
  progressiveVisualLayer,
  progressiveJsonLayer,
  finalJsonLayer,
  detectLayer, // Auto-detect based on TTY
} from '@overeng/tui-react'

// Use TTY detection
const layer = process.stdout.isTTY ? progressiveVisualLayer : finalJsonLayer
```

## Components

### Layout

- **`Box`** - Flexbox container
- **`Static`** - Permanent log region (rendered once, persists above dynamic content)

### Text

- **`Text`** - Styled text with colors, bold, dim, etc.

### Feedback

- **`Spinner`** - Animated loading indicator
- **`TaskList`** - List of tasks with status indicators

## API Reference

### `createRoot(stream, options?)`

Create a root for rendering React elements.

### `createTuiApp(config)`

Create a TuiApp factory with state/action schemas and reducer:

```tsx
const MyApp = createTuiApp({
  stateSchema: MyState, // Effect Schema for state
  actionSchema: MyAction, // Effect Schema for actions
  initial: {
    /* ... */
  }, // Initial state value
  reducer: myReducer, // (state, action) => state
})

// Run the app with a view
const tui = yield * MyApp.run(<MyView />)

// API returned by run():
tui.dispatch(action) // Dispatch an action (sync)
tui.getState() // Get current state (sync)
tui.stateRef // SubscriptionRef for advanced use
```

### View Hooks

Inside your view component:

```tsx
const MyView = () => {
  const state = useTuiAppState<MyState>() // Subscribe to state
  const dispatch = useTuiAppDispatch<MyAction>() // Get dispatch function
  // or both:
  const { state, dispatch } = useTuiApp<MyState, MyAction>()

  return <Box>...</Box>
}
```

### `Universal.*`

Renderer-agnostic components and utilities.

## Examples

See the `examples/` directory:

- `examples/basic.tsx` - Simple rendering
- `examples/deploy-cli/` - Full CLI with Effect integration
- `examples/interactive-counter/` - Counter with keyboard input
- `examples/effect-integration.tsx` - Effect state management
- `examples/effect-logging.tsx` - TUI logger integration
- `examples/universal-components-demo.tsx` - Universal components

## License

MIT
