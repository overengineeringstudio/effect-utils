/**
 * TUI with Effect atoms, keyboard input, and Effect runtime integration.
 *
 * Key patterns:
 * - ManagedRuntime for Effect runtime lifecycle
 * - Layer-based dependency injection
 * - Effect atoms for reactive UI state
 * - Structured effect execution with spans and error handling
 *
 * Run: bun examples/effect-atoms-keyboard.tsx
 */
import { Atom, Registry } from '@effect-atom/atom'
import { RegistryContext, useAtomValue } from '@effect-atom/atom-react'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { Cause, Effect, Fiber, Layer, ManagedRuntime, Runtime } from 'effect'

// -----------------------------------------------------------------------------
// Services (Layer-based dependencies)
// -----------------------------------------------------------------------------

/** Counter service demonstrating dependency injection */
class CounterService extends Effect.Service<CounterService>()('CounterService', {
  effect: Effect.sync(() => {
    let value = 0

    return {
      get: () => value,
      increment: () =>
        Effect.gen(function* () {
          yield* Effect.sleep('100 millis') // Simulate async work
          value += 1
          return value
        }),
      decrement: () =>
        Effect.gen(function* () {
          yield* Effect.sleep('100 millis')
          value -= 1
          return value
        }),
      reset: () =>
        Effect.gen(function* () {
          yield* Effect.sleep('50 millis')
          value = 0
          return value
        }),
    }
  }),
}) {}

const AppLayer = Layer.mergeAll(CounterService.Default)

// -----------------------------------------------------------------------------
// Atoms (Reactive UI state)
// -----------------------------------------------------------------------------

const countAtom = Atom.make(0)
const statusAtom = Atom.make<'idle' | 'loading' | 'error'>('idle')
const messageAtom = Atom.make('Press ↑/↓ to change, r to reset, q to quit')

// -----------------------------------------------------------------------------
// Effect Runner
// -----------------------------------------------------------------------------

type CancelFn = () => void

/** Create an effect runner from a runtime with error handling */
const createEffectRunner = (options: {
  runtime: Runtime.Runtime<CounterService>
  onError: (cause: Cause.Cause<never>) => void
}) => {
  return (effect: Effect.Effect<void, never, CounterService>): CancelFn => {
    const fiber = effect.pipe(
      Effect.tapErrorCause((cause) => Effect.sync(() => options.onError(cause))),
      Effect.withSpan('ui.effect', { root: true }),
      Runtime.runFork(options.runtime),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }
}

// -----------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------

/** Status indicator component */
const StatusIndicator = () => {
  const status = useAtomValue(statusAtom)

  const color = status === 'loading' ? 'yellow' : status === 'error' ? 'red' : 'green'
  const text = status === 'loading' ? '⟳' : status === 'error' ? '✗' : '✓'

  return <text fg={color}>[{text}]</text>
}

const App = () => {
  const count = useAtomValue(countAtom)
  const message = useAtomValue(messageAtom)

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text fg="cyan">
        <b>Effect Atoms + Keyboard Example</b>
      </text>

      <box flexDirection="row" gap={2}>
        <text>Count:</text>
        <text fg="green">
          <b>{count}</b>
        </text>
        <StatusIndicator />
      </box>

      <text fg="gray">{message}</text>
    </box>
  )
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

const main = async () => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  const root = createRoot(renderer)
  const registry = Registry.make()

  // Initialize Effect runtime from Layer
  const managedRuntime = ManagedRuntime.make(AppLayer)
  const runtime = await Effect.runPromise(managedRuntime.runtimeEffect)

  // Create effect runner with error handling
  const runEffect = createEffectRunner({
    runtime,
    onError: (cause) => {
      registry.set(statusAtom, 'error')
      registry.set(messageAtom, `Error: ${Cause.pretty(cause)}`)
    },
  })

  // Subscribe to atoms
  const unsubs = [
    registry.subscribe(countAtom, () => {}),
    registry.subscribe(statusAtom, () => {}),
    registry.subscribe(messageAtom, () => {}),
  ]

  // Handle keyboard input - bridges imperative events to Effect execution
  renderer.keyInput.on('keypress', (key: { name: string; ctrl: boolean }) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      cleanup()
      return
    }

    if (key.name === 'up') {
      runEffect(
        Effect.gen(function* () {
          registry.set(statusAtom, 'loading')
          registry.set(messageAtom, 'Incrementing...')

          const counter = yield* CounterService
          const newValue = yield* counter.increment()

          registry.set(countAtom, newValue)
          registry.set(statusAtom, 'idle')
          registry.set(messageAtom, 'Incremented!')
        }).pipe(Effect.withSpan('counter.increment')),
      )
    }

    if (key.name === 'down') {
      runEffect(
        Effect.gen(function* () {
          registry.set(statusAtom, 'loading')
          registry.set(messageAtom, 'Decrementing...')

          const counter = yield* CounterService
          const newValue = yield* counter.decrement()

          registry.set(countAtom, newValue)
          registry.set(statusAtom, 'idle')
          registry.set(messageAtom, 'Decremented!')
        }).pipe(Effect.withSpan('counter.decrement')),
      )
    }

    if (key.name === 'r') {
      runEffect(
        Effect.gen(function* () {
          registry.set(statusAtom, 'loading')
          registry.set(messageAtom, 'Resetting...')

          const counter = yield* CounterService
          const newValue = yield* counter.reset()

          registry.set(countAtom, newValue)
          registry.set(statusAtom, 'idle')
          registry.set(messageAtom, 'Reset!')
        }).pipe(Effect.withSpan('counter.reset')),
      )
    }
  })

  const cleanup = () => {
    unsubs.forEach((unsub) => unsub())
    root.unmount()
    renderer.destroy()
    process.stdin.pause()
    registry.dispose()
    managedRuntime.dispose()
    process.exit(0)
  }

  root.render(
    <RegistryContext.Provider value={registry}>
      <App />
    </RegistryContext.Provider>,
  )

  await new Promise(() => {})
}

main().catch(console.error)
