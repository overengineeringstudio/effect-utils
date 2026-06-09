/** Converts the first character of a string to lowercase */
export const lowercaseFirstChar = (str: string) => str.charAt(0).toLowerCase() + str.slice(1)

/** Converts the first character of a string to uppercase */
export const uppercaseFirstChar = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

/**
 * Format the human-readable `message` for a tagged "reason" error.
 *
 * The SSOT for the `get message()` body our tagged errors hand-copy (e.g.
 * `RestateError`, `PtyError`): space-join the `reason` discriminator, an optional
 * `[label]` (a key/name that scopes the failure), the `(method)` that failed, and
 * `: <cause.message>` (or `: <String(cause)>` for a non-`Error` cause). Omitted
 * parts are dropped. The cause segment is space-separated like the others, so it
 * reads `... (method) : message` — preserving the existing `RestateError` /
 * `PtyError` output verbatim (this is a behavior-preserving consolidation).
 *
 * ```ts
 * formatReasonMessage({ reason: 'IngressFailed', method: 'call', cause: err })
 * // → "IngressFailed (call) : connection refused"
 * formatReasonMessage({ reason: 'WriteFailed', label: 'sess-1', method: 'press' })
 * // → "WriteFailed [sess-1] (press)"
 * ```
 */
export const formatReasonMessage = (input: {
  readonly reason: string
  readonly label?: string | undefined
  readonly method?: string | undefined
  readonly cause?: unknown
}): string => {
  const parts: string[] = [input.reason]
  if (input.label !== undefined) parts.push(`[${input.label}]`)
  if (input.method !== undefined) parts.push(`(${input.method})`)
  if (input.cause instanceof Error) parts.push(`: ${input.cause.message}`)
  else if (input.cause !== undefined) parts.push(`: ${String(input.cause)}`)
  return parts.join(' ')
}

/**
 * Converts a title into a URL-safe lowercase slug (max 120 chars).
 *
 * Non-alphanumeric runs become single hyphens; leading/trailing hyphens are trimmed.
 * Returns `"untitled"` for blank or all-punctuation titles.
 */
export const titleSlug = (title: string): string => {
  const slug = title
    .normalize('NFC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '')

  return slug.length > 0 ? slug : 'untitled'
}
