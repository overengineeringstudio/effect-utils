/**
 * Single source of truth for all @overeng/* packages in effect-utils.
 *
 * This list is used to generate catalog entries in internal.ts.
 * When adding a new package, add it here.
 */

/**
 * All internal @overeng/* package short names.
 */
export const internalPackages = [
  'effect-path',
  'effect-schema-form',
  'effect-schema-form-aria',
  'genie',
  'megarepo',
  'notion-cli',
  'notion-effect-client',
  'notion-effect-schema',
  'otel-cli',
  'tui-core',
  'tui-react',
  'utils',
  'utils-dev',
] as const

/** Short name of an internal @overeng/* package. */
export type InternalPackageName = (typeof internalPackages)[number]

/**
 * Generate catalog entries for all internal packages.
 * All internal packages use workspace:* protocol.
 */
export const internalPackageCatalogEntries = Object.fromEntries(
  internalPackages.map((name) => [`@overeng/${name}`, 'workspace:*'] as const),
) as Record<`@overeng/${InternalPackageName}`, 'workspace:*'>
