/**
 * Namespaced block key derived from a business identifier.
 *
 * Use this at call sites where multiple renderers might share a cache file
 * and you want to avoid collisions with unrelated keys.
 */
export const blockKey = (business: string): string => `b:${business}`
