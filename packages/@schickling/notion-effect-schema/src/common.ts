import { Schema } from 'effect'

// -----------------------------------------------------------------------------
// Custom Annotations
// -----------------------------------------------------------------------------

/**
 * Annotation key for Notion API docs path fragment.
 * Use with `resolveDocsUrl` to get the full URL.
 *
 * @example
 * ```ts
 * Schema.Struct({ ... }).annotations({
 *   [docsPath]: 'property-value-object#title',
 * })
 * ```
 */
export const docsPath: unique symbol = Symbol.for('@schickling/notion-effect-schema/docsPath')

/** Base URL for Notion API documentation */
export const NOTION_DOCS_BASE = 'https://developers.notion.com/reference'

/** Resolve full docs URL from path fragment */
export const resolveDocsUrl = (path: string): string => `${NOTION_DOCS_BASE}/${path}`

// -----------------------------------------------------------------------------
// Primitive Schemas
// -----------------------------------------------------------------------------

/**
 * Notion UUID identifier.
 *
 * @see https://developers.notion.com/reference/intro#conventions
 */
export const NotionUUID = Schema.String.annotations({
  identifier: 'Notion.UUID',
  title: 'Notion UUID',
  description: 'A unique identifier in UUID format used throughout the Notion API.',
  examples: ['2afe4693-b7ce-4c6d-b98a-6a5f67f7a0b1'],
  [docsPath]: 'intro#conventions',
})

export type NotionUUID = typeof NotionUUID.Type

/**
 * ISO 8601 date-time string as returned by Notion API.
 *
 * @see https://developers.notion.com/reference/intro#conventions
 */
export const ISO8601DateTime = Schema.String.annotations({
  identifier: 'Notion.ISO8601DateTime',
  title: 'ISO 8601 DateTime',
  description: 'A timestamp in ISO 8601 format.',
  examples: ['2024-01-15T10:30:00.000Z'],
  [docsPath]: 'intro#conventions',
})

export type ISO8601DateTime = typeof ISO8601DateTime.Type

/**
 * Notion color values used in annotations, select options, etc.
 *
 * @see https://developers.notion.com/reference/rich-text#the-annotation-object
 */
export const NotionColor = Schema.Literal(
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
  'gray_background',
  'brown_background',
  'orange_background',
  'yellow_background',
  'green_background',
  'blue_background',
  'purple_background',
  'pink_background',
  'red_background',
).annotations({
  identifier: 'Notion.Color',
  title: 'Notion Color',
  description: 'Color values used for text annotations and backgrounds.',
  [docsPath]: 'rich-text#the-annotation-object',
})

export type NotionColor = typeof NotionColor.Type

/**
 * Select option color values (subset of NotionColor, no backgrounds).
 *
 * @see https://developers.notion.com/reference/property-value-object#select
 */
export const SelectColor = Schema.Literal(
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
).annotations({
  identifier: 'Notion.SelectColor',
  title: 'Select Color',
  description: 'Color values used for select and multi-select options.',
  [docsPath]: 'property-value-object#select',
})

export type SelectColor = typeof SelectColor.Type

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export const isDevEnv = (): boolean => {
  if (typeof process === 'undefined') {
    return false
  }

  if (typeof process.env === 'undefined') {
    return false
  }

  return process.env.NODE_ENV !== 'production'
}

export const shouldNeverHappen = (msg?: string, ...args: unknown[]): never => {
  console.error(msg, ...args)
  if (isDevEnv()) {
    // biome-ignore lint/suspicious/noDebugger: intentional breakpoint for impossible states during development
    debugger
  }

  throw new Error(`This should never happen: ${msg}`)
}
