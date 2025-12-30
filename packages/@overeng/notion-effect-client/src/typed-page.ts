import type { ISO8601DateTime, Page } from '@overeng/notion-effect-schema'
import { Effect, Schema } from 'effect'

/**
 * A page with decoded properties.
 *
 * Combines Notion page metadata (id, created_time, etc.) with
 * user-defined property schema for type-safe access.
 */
export interface TypedPage<TProperties> {
  /** Page ID */
  readonly id: string
  /** Creation timestamp (ISO 8601) */
  readonly createdTime: ISO8601DateTime
  /** Last edit timestamp (ISO 8601) */
  readonly lastEditedTime: ISO8601DateTime
  /** Page URL */
  readonly url: string
  /** Public URL if shared */
  readonly publicUrl: string | null
  /** Whether page is archived */
  readonly archived: boolean
  /** Whether page is in trash */
  readonly inTrash: boolean
  /** Decoded properties according to provided schema */
  readonly properties: TProperties
  /** Original raw page object for advanced use cases */
  readonly _raw: Page
}

/**
 * Error when decoding page properties fails.
 */
export class PageDecodeError extends Schema.TaggedError<PageDecodeError>()('PageDecodeError', {
  /** Page ID that failed to decode */
  pageId: Schema.String,
  /** The underlying parse error */
  cause: Schema.Defect,
  /** Human-readable message */
  message: Schema.String,
}) {}

/**
 * Decode a raw Notion page using a property schema.
 *
 * @param page - Raw Notion page object
 * @param schema - Effect schema for the properties
 * @returns Typed page with decoded properties
 */
export const decodePage = <TProperties, I, R>(
  page: Page,
  schema: Schema.Schema<TProperties, I, R>,
): Effect.Effect<TypedPage<TProperties>, PageDecodeError, R> =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknown(schema)
    const properties = yield* decode(page.properties).pipe(
      Effect.mapError(
        (cause) =>
          new PageDecodeError({
            pageId: page.id,
            cause,
            message: `Failed to decode properties for page ${page.id}`,
          }),
      ),
    )

    return {
      id: page.id,
      createdTime: page.created_time,
      lastEditedTime: page.last_edited_time,
      url: page.url,
      publicUrl: page.public_url,
      archived: page.archived,
      inTrash: page.in_trash,
      properties,
      _raw: page,
    }
  })

/**
 * Decode multiple pages using a property schema.
 *
 * Fails fast on first decode error.
 */
export const decodePages = <TProperties, I, R>(
  pages: readonly Page[],
  schema: Schema.Schema<TProperties, I, R>,
): Effect.Effect<readonly TypedPage<TProperties>[], PageDecodeError, R> =>
  Effect.forEach(pages, (page) => decodePage(page, schema))
