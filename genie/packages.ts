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
  'kdl',
  'kdl-effect',
  'megarepo',
  'notion-cli',
  'notion-effect-client',
  'notion-effect-schema',
  'pty-effect',
  'tui-core',
  'tui-react',
  'tui-stories',
  'utils',
  'utils-dev',
] as const

/** Short name of an internal @overeng/* package. */
export type InternalPackageName = (typeof internalPackages)[number]

/**
 * Generate catalog entries for all internal packages.
 * Using `workspace:^` (not `workspace:*`) so pnpm resolves the actual version
 * from package.json. This is critical for GVS: with `workspace:*`, pnpm stores
 * workspace packages with `undefined` as version in the global link store,
 * breaking TypeScript resolution through GVS real paths.
 */
export const internalPackageCatalogEntries = Object.fromEntries(
  internalPackages.map((name) => [`@overeng/${name}`, 'workspace:^'] as const),
) as Record<`@overeng/${InternalPackageName}`, 'workspace:^'>
