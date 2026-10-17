import type { Effect } from 'effect'

import { NotionApiError } from '@overeng/notion-effect-client'

import type { NotionSyncError } from './errors.ts'

/**
 * Hook payload provided to the consumer when a Notion op fails because of
 * an upload-id related validation error. The consumer is expected to
 * re-upload the corresponding asset and return the fresh `file_upload_id`.
 */
export interface UploadIdRejectionContext {
  /** Server block id for update ops. `undefined` when the op targeted a block being created. */
  readonly blockId: string | undefined
  /** Internal tmp id used for append/insert ops. `undefined` for update ops. */
  readonly tmpId: string | undefined
  /** The rejected file_upload_id as it appeared in the op payload. */
  readonly fileUploadId: string
  /** The original Notion API error for context / logging. */
  readonly originalError: NotionApiError
}

/**
 * Returns the fresh `file_upload_id` to retry the op with. Any consumer
 * requirements (database, logger, Notion client) must be pre-provided on
 * the returned Effect — the library can't plumb arbitrary `R` through the
 * sync signature without leaking consumer concerns into its public type.
 * Mirrors the `cache.save` / `cache.load` contract on `NotionCache`.
 */
export type OnUploadIdRejected = (
  ctx: UploadIdRejectionContext,
) => Effect.Effect<{ readonly newUploadId: string }, NotionSyncError>

/**
 * Pattern match against Notion's error envelope for upload-id rejections.
 * The API surfaces these as `validation_error` with a message that
 * references the upload id (evicted early, not-yet-usable, race). Returns
 * the matched cause when the error shape fits — the caller extracts the
 * actual `file_upload_id` from the op payload separately (it's not always
 * present in the error message body).
 */
export const isUploadIdRejection = (err: unknown): err is NotionApiError => {
  if (!(err instanceof NotionApiError)) return false
  if (err.status !== 400) return false
  if (err.code !== 'validation_error') return false
  return /file[_ ]upload/i.test(err.message)
}

/**
 * Extract the `file_upload_id` from a block-op props payload. Props follow
 * Notion's block body shape (`host-config.ts`): media blocks carry the id
 * under `props.file_upload.id`. Returns `undefined` when the op isn't of a
 * shape that references an upload id.
 */
export const extractFileUploadId = (props: Record<string, unknown>): string | undefined => {
  const fu = props.file_upload
  if (fu !== undefined && typeof fu === 'object' && fu !== null) {
    const id = (fu as { id?: unknown }).id
    if (typeof id === 'string') return id
  }
  return undefined
}

/** Immutably replace the `file_upload.id` in a props payload. */
export const replaceFileUploadId = (
  props: Record<string, unknown>,
  newId: string,
): Record<string, unknown> => ({
  ...props,
  file_upload: { id: newId },
})
