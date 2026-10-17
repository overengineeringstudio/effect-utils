import { Effect } from 'effect'

import type { CacheTree, NotionCache } from './types.ts'

/** Pure in-memory `NotionCache` for tests and ephemeral sessions. */
export const InMemoryCache = {
  make: (initial?: CacheTree): NotionCache => {
    let state: CacheTree | undefined = initial
    return {
      load: Effect.sync(() => state),
      save: (tree) =>
        Effect.sync(() => {
          state = tree
        }),
    }
  },
} as const
