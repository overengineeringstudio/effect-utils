# @overeng/effect-react

React integration for [Effect](https://effect.website). Provides utilities for integrating Effect runtime with React applications.

## Installation

```bash
pnpm add @overeng/effect-react effect react react-dom
```

## Features

- **Layer-based app initialization** - Bootstrap React apps with Effect layers
- **Service context propagation** - Access Effect services from React components
- **Loading state management** - Track initialization progress
- **React hooks** - Utilities for working with async effects in React

## Usage

### Basic App Setup

```tsx
import { makeReactAppLayer, LoadingState } from '@overeng/effect-react'
import { Effect, Layer, SubscriptionRef } from 'effect'

// Define your app layer
const AppServicesLayer = Layer.mergeAll(
  DatabaseLayer,
  ApiClientLayer,
  // ... other services
)

// Create the React app layer
const AppLayer = makeReactAppLayer({
  getRootEl: () => document.getElementById('root')!,
  render: (props) => {
    switch (props._tag) {
      case 'Loading':
        return <LoadingScreen state={props.readyState} />
      case 'Error':
        return <ErrorScreen cause={props.errorCause} />
      case 'Ready':
        return <App />
    }
  },
  layer: AppServicesLayer,
})

// Bootstrap the app
const LoadingStateLayer = Layer.effect(
  LoadingState<{ message: string }>(),
  SubscriptionRef.make({ message: 'Initializing...' }),
)

const MainLayer = Layer.provide(AppLayer, LoadingStateLayer)

Effect.runFork(Layer.launch(MainLayer))
```

### Using Service Context

```tsx
import { useServiceContext } from '@overeng/effect-react'
import { Effect } from 'effect'

const MyComponent = () => {
  const ctx = useServiceContext<MyServices>()

  const handleClick = () => {
    ctx.runWithErrorLog(
      Effect.gen(function* () {
        const api = yield* ApiClient
        yield* api.fetchData()
      })
    )
  }

  return <button onClick={handleClick}>Fetch</button>
}
```

### React Hooks

```tsx
import { useInterval, useAsyncEffectUnsafe } from '@overeng/effect-react'

// Run intervals with automatic cleanup
const MyComponent = () => {
  useInterval(() => console.log('tick'), true, 1000)
  return <div>...</div>
}

// Run async effects in useEffect
const MyComponent = () => {
  useAsyncEffectUnsafe(async () => {
    await fetchData()
  }, [])
  return <div>...</div>
}
```

## API Reference

### `makeReactAppLayer`

Creates a layer that initializes and renders a React app with Effect integration.

### `useServiceContext<TCtx>()`

Hook to access the Effect service context from React components.

### `LoadingState<TProps>()`

Context tag for tracking app initialization progress.

### Hooks

- `useAsyncEffectUnsafe(effect, deps)` - Run async effects in useEffect
- `useInterval(callback, isActive, delay)` - Managed interval with cleanup
- `useStateRefWithReactiveInput(inputState)` - State ref that syncs with external input

### Utilities

- `cuid()` - Generate collision-resistant unique IDs
- `slug()` - Generate short slug-style IDs
