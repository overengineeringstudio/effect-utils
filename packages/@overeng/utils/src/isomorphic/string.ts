/** Converts the first character of a string to lowercase */
export const lowercaseFirstChar = (str: string) => str.charAt(0).toLowerCase() + str.slice(1)

/** Converts the first character of a string to uppercase */
export const uppercaseFirstChar = (str: string) => str.charAt(0).toUpperCase() + str.slice(1)

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
