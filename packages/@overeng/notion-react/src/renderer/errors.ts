import { Data } from 'effect'

/** Error produced during a Notion sync/render */
export class NotionSyncError extends Data.TaggedError('NotionSyncError')<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/** Error produced by a NotionCache backend */
export class CacheError extends Data.TaggedError('CacheError')<{
  readonly reason: string
  readonly cause?: unknown
}> {}
