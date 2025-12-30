import React from 'react'

/** Run an async effect inside useEffect (fire and forget) */
export const useAsyncEffectUnsafe = (effect: () => Promise<void>, deps: React.DependencyList) => {
  React.useEffect(
    () => {
      void effect()
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally using deps array parameter
    deps,
  )
}
