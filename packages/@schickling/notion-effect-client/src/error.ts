import { Schema } from 'effect'

/**
 * Notion API error codes.
 *
 * @see https://developers.notion.com/reference/errors
 */
export const NotionErrorCode = Schema.Literal(
  'invalid_json',
  'invalid_request_url',
  'invalid_request',
  'validation_error',
  'missing_version',
  'unauthorized',
  'restricted_resource',
  'object_not_found',
  'conflict_error',
  'rate_limited',
  'internal_server_error',
  'service_unavailable',
  'database_connection_unavailable',
  'gateway_timeout',
)

export type NotionErrorCode = typeof NotionErrorCode.Type

/**
 * Error returned by the Notion API.
 *
 * Preserves full error context for debugging including HTTP status,
 * error code, message, and request ID for support requests.
 *
 * @see https://developers.notion.com/reference/errors
 */
export class NotionApiError extends Schema.TaggedError<NotionApiError>()('NotionApiError', {
  /** HTTP status code */
  status: Schema.Number,
  /** Notion-specific error code */
  code: NotionErrorCode,
  /** Human-readable error message */
  message: Schema.String,
  /** Request ID for Notion support (from x-request-id header) */
  requestId: Schema.optionalWith(Schema.String, { as: 'Option' }),
  /** Original request URL for debugging */
  url: Schema.optionalWith(Schema.String, { as: 'Option' }),
  /** Original request method for debugging */
  method: Schema.optionalWith(Schema.String, { as: 'Option' }),
}) {
  /** Check if error is retryable (rate limit or server error) */
  get isRetryable(): boolean {
    return (
      this.code === 'rate_limited' ||
      this.code === 'internal_server_error' ||
      this.code === 'service_unavailable' ||
      this.code === 'database_connection_unavailable' ||
      this.code === 'gateway_timeout'
    )
  }
}

/**
 * Raw error response shape from Notion API.
 * Used for parsing API error responses before converting to NotionApiError.
 */
export const NotionErrorResponse = Schema.Struct({
  object: Schema.Literal('error'),
  status: Schema.Number,
  code: NotionErrorCode,
  message: Schema.String,
})

export type NotionErrorResponse = typeof NotionErrorResponse.Type
