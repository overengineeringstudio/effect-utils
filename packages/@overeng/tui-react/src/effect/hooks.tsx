/**
 * React hooks for Effect integration.
 *
 * This module re-exports effect-atom primitives for TUI state management.
 * Components use `useAtomValue` to subscribe to state and `useAtomSet` to dispatch actions.
 *
 * @example
 * ```tsx
 * // Define app with atoms
 * const CounterApp = createTuiApp({
 *   stateSchema: CounterState,
 *   actionSchema: CounterAction,
 *   initial: { count: 0 },
 *   reducer: counterReducer,
 * })
 *
 * // View uses atoms directly
 * const CounterView = () => {
 *   const state = useAtomValue(CounterApp.stateAtom)
 *   const dispatch = useAtomSet(CounterApp.dispatchAtom)
 *   return (
 *     <Box>
 *       <Text>Count: {state.count}</Text>
 *     </Box>
 *   )
 * }
 * ```
 *
 * @module
 */

// =============================================================================
// Re-exports from effect-atom
// =============================================================================

/**
 * Atom - Reactive state primitive.
 * @see https://github.com/effect-ts/effect-atom
 */
export { Atom, Result } from '@effect-atom/atom'
export type { Registry } from '@effect-atom/atom'

/**
 * React hooks for atoms.
 *
 * - `useAtomValue(atom)` - Subscribe to an atom's value
 * - `useAtom(atom)` - Get [value, setValue] tuple
 * - `useAtomSet(atom)` - Get setter function only
 * - `useAtomMount(atom)` - Mount atom without reading value
 * - `useAtomRefresh(atom)` - Get refresh function for async atoms
 * - `useAtomSuspense(atom)` - Use with React Suspense
 * - `useAtomSubscribe(atom, callback)` - Side-effect subscription
 */
export {
  useAtomValue,
  useAtom,
  useAtomSet,
  useAtomMount,
  useAtomRefresh,
  useAtomSuspense,
  useAtomSubscribe,
  useAtomInitialValues,
  RegistryProvider,
  RegistryContext,
} from '@effect-atom/atom-react'

// =============================================================================
// React hook re-exports (to ensure single React instance)
// =============================================================================

/**
 * Re-export React hooks to ensure consumers use the same React instance.
 * This prevents "Invalid hook call" errors in monorepo setups where
 * module resolution can lead to multiple React copies.
 *
 * @example
 * ```tsx
 * // Import hooks from tui-react instead of react
 * import { useMemo, useCallback, useState, useEffect } from '@overeng/tui-react'
 * ```
 */
export {
  useMemo,
  useCallback,
  useState,
  useEffect,
  useRef,
  useContext,
  useReducer,
  useLayoutEffect,
  useSyncExternalStore,
  useId,
  useTransition,
  useDeferredValue,
  useImperativeHandle,
  useDebugValue,
} from 'react'

// =============================================================================
// TUI-specific utilities
// =============================================================================

import { Atom } from '@effect-atom/atom'

/**
 * Create a pair of atoms for reducer-style state management.
 *
 * This is a convenience utility for the common pattern of having a state atom
 * and a dispatch atom that applies actions through a reducer.
 *
 * @param options.initial - Initial state value
 * @param options.reducer - Pure function: (state, action) => newState
 * @returns Object with `stateAtom` and `dispatchAtom`
 *
 * @example
 * ```typescript
 * const { stateAtom, dispatchAtom } = createReducerAtoms({
 *   initial: { count: 0 },
 *   reducer: (state, action) => {
 *     switch (action._tag) {
 *       case 'Increment': return { count: state.count + 1 }
 *       case 'Decrement': return { count: state.count - 1 }
 *     }
 *   }
 * })
 *
 * // In React component
 * const state = useAtomValue(stateAtom)      // { count: 0 }
 * const dispatch = useAtomSet(dispatchAtom)
 * dispatch({ _tag: 'Increment' })            // state becomes { count: 1 }
 * ```
 */
export const createReducerAtoms = <S, A>({
  initial,
  reducer,
}: {
  readonly initial: S
  readonly reducer: (state: S, action: A) => S
}) => {
  const stateAtom = Atom.make(initial)
  const dispatchAtom = Atom.fnSync((action: A, get) => {
    const currentState = get(stateAtom)
    const newState = reducer(currentState, action)
    get.set(stateAtom, newState)
  })
  return { stateAtom, dispatchAtom } as const
}
