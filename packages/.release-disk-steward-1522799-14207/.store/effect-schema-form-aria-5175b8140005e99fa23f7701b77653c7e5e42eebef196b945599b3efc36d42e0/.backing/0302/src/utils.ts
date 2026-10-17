/**
 * Format a literal value as a human-readable label.
 * Converts kebab-case, camelCase, and snake_case to Title Case.
 */
export const formatLiteralLabel = (value: string): string => {
  // Handle camelCase: insert space before capitals
  const spaced = value.replace(/([a-z])([A-Z])/g, '$1 $2')
  // Handle kebab-case and snake_case: replace hyphens/underscores with spaces
  const normalized = spaced.replace(/[-_]/g, ' ')
  // Title case each word
  return normalized
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}
