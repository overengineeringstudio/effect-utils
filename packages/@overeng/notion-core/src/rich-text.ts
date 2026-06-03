type UnknownRecord = { readonly [key: string]: unknown }

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null

/**
 * Plain-text extraction over an untyped Notion rich-text array.
 *
 * Elements without a `plain_text` field contribute an empty string. Non-array
 * inputs also return an empty string so callers can safely pass raw API fields.
 */
export const richTextPlainText = (value: unknown): string => {
  if (Array.isArray(value) === false) return ''

  return value
    .map((part) => (isRecord(part) === true && 'plain_text' in part ? String(part.plain_text) : ''))
    .join('')
}
