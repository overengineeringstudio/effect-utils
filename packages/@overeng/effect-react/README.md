# @overeng/effect-react

React integration for [Effect](https://effect.website). Provides a context-based approach for running Effect with React applications.

## Installation

```bash
pnpm add @overeng/effect-react effect react
```

## Features

- **EffectProvider** - Initialize Effect runtime from a Layer and provide it to React components
- **useEffectRunner** - Run effects with automatic error handling
- **useEffectCallback** - Create stable callbacks that run effects
- **useEffectOnMount** - Run effects when components mount
- **cuid/slug** - Generate collision-resistant unique IDs

## Usage

### Basic Setup

```tsx
import { EffectProvider, useEffectRunner } from '@overeng/effect-react'
import { Effect, Layer, Logger } from 'effect'

// Define your app layer
const AppLayer = Layer.mergeAll(
  Logger.pretty,
  // ... your services
)

// Wrap your app with EffectProvider
const App = () => (
  <EffectProvider
    layer={AppLayer}
    Loading={() => <div>Loading...</div>}
    Error={({ cause, onRetry }) => (
      <div>
        <pre>{Cause.pretty(cause)}</pre>
        <button onClick={onRetry}>Retry</button>
      </div>
    )}
  >
    <MainApp />
  </EffectProvider>
)

// Use effects in your components
const MainApp = () => {
  const runEffect = useEffectRunner()

  const handleClick = () => {
    runEffect(
      Effect.gen(function* () {
        yield* Effect.log('Button clicked!')
        // Use your services here
      }).pipe(Effect.withSpan('button.click'))
    )
  }

  return <button onClick={handleClick}>Click me</button>
}
```

### Running Effects

```tsx
import { useEffectRunner, useEffectCallback, useEffectOnMount } from '@overeng/effect-react'

const MyComponent = () => {
  // Option 1: Get a runner function
  const runEffect = useEffectRunner()

  const handleSave = () => {
    const cancel = runEffect(saveData())
    // cancel() to abort
  }

  // Option 2: Create a stable callback
  const handleLoad = useEffectCallback(loadData())

  // Option 3: Run on mount
  useEffectOnMount(initializeComponent())

  return (
    <div>
      <button onClick={handleSave}>Save</button>
      <button onClick={handleLoad}>Load</button>
    </div>
  )
}
```

### Custom Error Handling

```tsx
import { EffectProvider, extractErrorMessage } from '@overeng/effect-react'

const App = () => (
  <EffectProvider
    layer={AppLayer}
    onError={(cause, runtime) => {
      // Custom error handling - show toast, log to service, etc.
      const message = extractErrorMessage(cause)
      showToast({ type: 'error', message })
    }}
  >
    <MainApp />
  </EffectProvider>
)
```

### Accessing the Runtime Directly

```tsx
import { useRuntime } from '@overeng/effect-react'
import { Runtime } from 'effect'

const MyComponent = () => {
  const runtime = useRuntime<MyServices>()

  // Use runtime directly for advanced cases
  const result = Runtime.runSync(runtime)(myEffect)

  return <div>{result}</div>
}
```

## API Reference

### Components

#### `EffectProvider<TEnv, TErr>`

Provider component that initializes an Effect runtime from a Layer.

Props:
- `layer` - The Layer to build the runtime from
- `Loading` - Component to show while loading (optional)
- `Error` - Component to show on error (optional)
- `onError` - Handler called when effects fail (optional)
- `children` - React children

### Hooks

#### `useEffectRunner<TEnv>()`

Returns a function to run effects with automatic error handling. Returns a cancel function.

#### `useEffectCallback<TEnv, TA, TE>(effect)`

Create a stable callback that runs an effect when called.

#### `useEffectOnMount<TEnv, TA, TE>(effect)`

Run an effect when the component mounts. Cancels on unmount.

#### `useRuntime<TEnv>()`

Get the raw Effect runtime from context.

### Utilities

#### `extractErrorMessage(cause)`

Extract a user-friendly error message from a Cause.

#### `cuid()`

Generate a collision-resistant unique ID.

#### `slug()`

Generate a short slug-style ID.
