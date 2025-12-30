import React from 'react'

/**
 * A variant of `React.useState` which allows the `inputState` to change over time as well.
 * Important: This hook is synchronous / single-render-pass (i.e. doesn't use `useEffect` or `setState` directly).
 *
 * Notes:
 * - The output state is always reset to the input state in case the input state changes
 * - This hook might not work properly with React Suspense
 */
export const useStateRefWithReactiveInput = <T>(
  inputState: T,
): [React.RefObject<T>, (newState: T | ((prev: T) => T)) => void] => {
  const [_, rerender] = React.useState(0)

  const lastKnownInputStateRef = React.useRef<T>(inputState)
  const stateRef = React.useRef<T>(inputState)

  if (lastKnownInputStateRef.current !== inputState) {
    lastKnownInputStateRef.current = inputState
    stateRef.current = inputState
  }

  const setStateAndRerender = React.useCallback((newState: ((prev: T) => T) | T) => {
    // @ts-expect-error https://github.com/microsoft/TypeScript/issues/37663
    const val = typeof newState === 'function' ? newState(stateRef.current) : newState
    stateRef.current = val
    rerender((c) => c + 1)
  }, [])

  return [stateRef, setStateAndRerender]
}
