/**
 * Notion File Uploads API.
 *
 * Three-step upload flow:
 * 1. Create a file upload (POST /v1/file_uploads, JSON body)
 * 2. Send the file data (POST /v1/file_uploads/{id}/send, multipart form-data)
 * 3. Reference the upload ID in a `pdf` or `file` block when creating/updating a page
 *
 * Requires `Notion-Version: 2026-03-11` (newer than the standard `2022-06-28`).
 *
 * @see https://developers.notion.com/reference/create-a-file-upload
 */

import { Effect, Option, Redacted, Schema } from 'effect'

import { NotionConfig } from './config.ts'
import { NotionApiError } from './error.ts'

/** API version required for file uploads (newer than the standard version) */
const FILE_UPLOAD_API_VERSION = '2026-03-11'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FileUploadResponseSchema = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  upload_url: Schema.String,
  filename: Schema.NullOr(Schema.String),
  content_type: Schema.NullOr(Schema.String),
  content_length: Schema.NullOr(Schema.Number),
})

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for uploading a file to Notion */
export interface UploadFileOptions {
  /** File content as bytes */
  readonly content: Uint8Array
  /** Filename including extension (max 900 bytes) */
  readonly filename: string
  /** MIME content type (e.g. "application/pdf") */
  readonly contentType: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Upload a file to Notion.
 *
 * Creates a file upload object, sends the file data, and returns the upload ID
 * that can be referenced in `pdf` or `file` blocks.
 *
 * @example
 * ```ts
 * const uploadId = yield* NotionFiles.upload({
 *   content: pdfBytes,
 *   filename: 'document.pdf',
 *   contentType: 'application/pdf',
 * })
 *
 * // Use in a pdf block for inline preview:
 * yield* NotionBlocks.append({
 *   blockId: pageId,
 *   children: [{
 *     type: 'pdf',
 *     pdf: { type: 'file_upload', file_upload: { id: uploadId } },
 *   }],
 * })
 * ```
 */
export const upload = Effect.fn('NotionFiles.upload')(function* (opts: UploadFileOptions) {
  const notionConfig = yield* NotionConfig
  const authToken = Redacted.value(notionConfig.authToken)
  const headers = {
    Authorization: `Bearer ${authToken}`,
    'Notion-Version': FILE_UPLOAD_API_VERSION,
  }

  // Step 1: Create file upload object
  const createRes = yield* Effect.tryPromise({
    try: async () => {
      const res = await fetch('https://api.notion.com/v1/file_uploads', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'single_part',
          filename: opts.filename,
          content_type: opts.contentType,
        }),
      })
      if (res.ok === false) {
        const text = await res.text()
        throw new Error(`File upload create failed (${res.status}): ${text}`)
      }
      return await res.json()
    },
    catch: (cause) =>
      new NotionApiError({
        status: 400,
        code: 'validation_error',
        message: `File upload create failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryAfterSeconds: Option.none(),
        requestId: Option.none(),
        url: Option.some('/v1/file_uploads'),
        method: Option.some('POST'),
      }),
  })

  const parsed = yield* Schema.decodeUnknown(FileUploadResponseSchema)(createRes).pipe(
    Effect.mapError(
      (cause) =>
        new NotionApiError({
          status: 400,
          code: 'validation_error',
          message: `Unexpected file upload response: ${cause}`,
          retryAfterSeconds: Option.none(),
          requestId: Option.none(),
          url: Option.some('/v1/file_uploads'),
          method: Option.some('POST'),
        }),
    ),
  )

  // Step 2: Send file data via multipart form-data
  const formData = new FormData()
  formData.append(
    'file',
    new Blob([opts.content.buffer as ArrayBuffer], { type: opts.contentType }),
    opts.filename,
  )

  yield* Effect.tryPromise({
    try: async () => {
      const res = await fetch(parsed.upload_url, {
        method: 'POST',
        headers,
        body: formData,
      })
      if (res.ok === false) {
        const text = await res.text()
        throw new Error(`File upload send failed (${res.status}): ${text}`)
      }
    },
    catch: (cause) =>
      new NotionApiError({
        status: 400,
        code: 'validation_error',
        message: `File upload send failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        retryAfterSeconds: Option.none(),
        requestId: Option.none(),
        url: Option.some(`/v1/file_uploads/${parsed.id}/send`),
        method: Option.some('POST'),
      }),
  })

  return parsed.id
})

// ---------------------------------------------------------------------------
// Namespace export
// ---------------------------------------------------------------------------

/** Notion file upload operations */
export const NotionFiles = { upload } as const
