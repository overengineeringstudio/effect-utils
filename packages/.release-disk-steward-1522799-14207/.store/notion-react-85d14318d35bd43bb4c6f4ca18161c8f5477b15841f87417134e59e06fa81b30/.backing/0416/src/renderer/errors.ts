import { Data } from 'effect'

import type { DiffOp } from './sync-diff.ts'

/**
 * Error produced during a Notion sync/render.
 *
 * `violations` is populated only for `reason: 'page-lifecycle-violation'`
 * (#1124): the offending `DiffOp[]` the `'append-only'` page-lifecycle
 * predicate rejected, in plan order, before any op was applied.
 */
export class NotionSyncError extends Data.TaggedError('NotionSyncError')<{
  readonly reason: string
  readonly cause?: unknown
  readonly violations?: readonly DiffOp[]
}> {}

/** Error produced by a NotionCache backend */
export class CacheError extends Data.TaggedError('CacheError')<{
  readonly reason: string
  readonly cause?: unknown
}> {}
