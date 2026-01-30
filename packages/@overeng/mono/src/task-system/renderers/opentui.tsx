/**
 * OpenTUI renderer: React-based terminal UI with Stream → Atom bridge.
 *
 * Architecture:
 * - Stream<TaskEvent> from graph execution
 * - Atom<TaskSystemState> for reactive state management
 * - React components for declarative UI rendering
 * - OpenTUI for ANSI rendering (useAlternateScreen: false)
 */

import { Atom, Registry } from '@effect-atom/atom'
import { RegistryContext } from '@effect-atom/atom-react'
import { Effect, Stream } from 'effect'

import { reduceEvent } from '../graph.ts'
import type { TaskEvent, TaskSystemState } from '../types.ts'
import { TaskSystemState as TaskSystemStateClass } from '../types.ts'
import { TaskSystemUI } from '../ui/components/TaskSystemUI.tsx'

/**
 * OpenTUI renderer using factory function pattern.
 *
 * Returns an object with render method that consumes an event stream.
 */
export const opentuiRenderer = () => {
  let registry: Registry.Registry | undefined
  let stateAtom: Atom.Writable<TaskSystemState> | undefined
  let root: any | undefined
  let renderer: any | undefined

  const initialState: TaskSystemState = new TaskSystemStateClass({ tasks: {} })

  return {
    /**
     * Render consumes the event stream and updates UI reactively.
     *
     * - Initializes OpenTUI on first call
     * - Updates state atom for each event
     * - Atom changes trigger React re-renders
     * - Returns final state when stream completes
     */
    render: Effect.fnUntraced(function* (eventStream: Stream.Stream<TaskEvent<string>>) {
      // Initialize on first render
      if (!stateAtom) {
        // Setup atom registry
        registry = Registry.make()
        stateAtom = Atom.make(initialState)

        // Setup OpenTUI renderer (dynamic imports to avoid TS module resolution issues)
        // @ts-expect-error - OpenTUI packages have incomplete ESM type definitions
        const { createCliRenderer } = yield* Effect.promise(() => import('@opentui/core'))
        // @ts-expect-error - OpenTUI packages have incomplete ESM type definitions
        const { createRoot } = yield* Effect.promise(() => import('@opentui/react'))

        renderer = yield* Effect.promise(() =>
          createCliRenderer({
            useAlternateScreen: false,
            exitOnCtrlC: true,
          }),
        )
        root = createRoot({ terminalOrStream: renderer })

        // Subscribe to atom changes → trigger re-render
        registry.subscribe(stateAtom, () => {
          root!.render(
            <RegistryContext.Provider value={registry!}>
              <TaskSystemUI atom={stateAtom!} />
            </RegistryContext.Provider>,
          )
        })

        // Initial render
        root.render(
          <RegistryContext.Provider value={registry}>
            <TaskSystemUI atom={stateAtom} />
          </RegistryContext.Provider>,
        )
      }

      // Consume event stream → update atom → return final state
      const finalState = yield* eventStream.pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            const currentState = registry!.get(stateAtom!)
            const newState = reduceEvent({ state: currentState, event })
            registry!.set(stateAtom!, newState)
          }),
        ),
        Stream.runFold(initialState, (state, event) => reduceEvent({ state, event })),
      )

      return finalState
    }),

    /**
     * Cleanup resources.
     *
     * CRITICAL: Must call process.stdin.pause() due to OpenTUI bug.
     *
     * NOTE: Not called by default to preserve output on screen.
     * OpenTUI uses useAlternateScreen: false, so output persists.
     * The CLI runner will call process.stdin.pause() on exit.
     */
    cleanup: Effect.gen(function* () {
      // Wait a bit for final render to complete
      yield* Effect.sleep('100 millis')

      // Cleanup (CRITICAL: must call pause() due to OpenTUI bug)
      if (registry) registry.dispose()
      if (root) root.unmount()
      if (renderer) renderer.destroy()
      process.stdin.pause()
    }),

    /**
     * Minimal cleanup - only pause stdin to allow process exit.
     * Preserves rendered output on screen.
     */
    pauseStdin: Effect.gen(function* () {
      // Wait for final render to complete before pausing stdin
      yield* Effect.sleep('100 millis')
      process.stdin.pause()
    }),
  }
}
