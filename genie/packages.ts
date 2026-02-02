/**
 * Single source of truth for all @overeng/* packages in effect-utils.
 *
 * When adding a new package:
 * 1. Add it to `internalPackages` below
 * 2. Add the import in `workspace-registry.ts`
 *
 * The catalog in internal.ts is derived from this list automatically.
 */

/**
 * All internal @overeng/* package short names.
 * Used to derive catalog entries and validate registry completeness.
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
  'tui-core',
  'tui-react',
  'utils',
] as const

export type InternalPackageName = (typeof internalPackages)[number]

/**
 * Convert short name to full package name.
 */
export const toFullPackageName = (shortName: InternalPackageName): string =>
  `@overeng/${shortName}`

/**
 * Generate catalog entries for all internal packages.
 * All internal packages use workspace:* protocol.
 */
export const internalPackageCatalogEntries = Object.fromEntries(
  internalPackages.map((name) => [`@overeng/${name}`, 'workspace:*'] as const),
) as Record<`@overeng/${InternalPackageName}`, 'workspace:*'>
