import type { ReactNode } from 'react'

import type { HttpClient } from '@effect/platform'
import { Effect } from 'effect'

import type { NotionConfig } from '@overeng/notion-effect-client'

import type { NotionCache } from '../cache/types.ts'
import { CACHE_SCHEMA_VERSION } from '../cache/types.ts'
import { NotionSyncError } from './errors.ts'
import { renderToNotion, type SyncResult } from './render-to-notion.ts'

/**
 * Cache-backed incremental sync.
 *
 * v0 behaviour: if no cache is present, fall back to an append-only render
 * (same as `renderToNotion`) and then persist a minimal cache snapshot so
 * subsequent calls can compute deltas. The full minimum-ops diff algorithm
 * lives in the VRS; v0 intentionally ships the fallback path so callers can
 * start using the API and we can layer diffing in without changing the
 * public surface.
 */
export const sync = (
  element: ReactNode,
  opts: { readonly pageId: string; readonly cache: NotionCache },
): Effect.Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const prior = yield* opts.cache.load.pipe(
      Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-load-failed', cause })),
    )
    const result = yield* renderToNotion(element, { pageId: opts.pageId })
    yield* opts.cache
      .save({ schemaVersion: CACHE_SCHEMA_VERSION, rootId: opts.pageId, children: [] })
      .pipe(Effect.mapError((cause) => new NotionSyncError({ reason: 'cache-save-failed', cause })))
    return {
      ...result,
      fallbackReason:
        prior === undefined ? 'cold-cache' : 'delta-diff-not-implemented-v0',
    }
  })
