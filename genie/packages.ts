/**
 * Single source of truth for all @overeng/* packages in effect-utils.
 *
 * This list is used to generate catalog entries in internal.ts and explicit
 * workspace member lists for root workspace topology files.
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

/** Explicit workspace members for the root pnpm workspace and tsconfig refs. */
export const workspaceMemberPaths = [
  'context/effect/socket',
  'context/opentui',
  'packages/@overeng/effect-ai-claude-cli',
  'packages/@overeng/effect-path',
  'packages/@overeng/effect-react',
  'packages/@overeng/effect-rpc-tanstack',
  'packages/@overeng/effect-rpc-tanstack/examples/basic',
  'packages/@overeng/effect-schema-form',
  'packages/@overeng/effect-schema-form-aria',
  'packages/@overeng/genie',
  'packages/@overeng/megarepo',
  'packages/@overeng/notion-cli',
  'packages/@overeng/notion-effect-client',
  'packages/@overeng/notion-effect-schema',
  'packages/@overeng/oxc-config',
  'packages/@overeng/react-inspector',
  'packages/@overeng/tui-core',
  'packages/@overeng/tui-react',
  'packages/@overeng/utils',
  'packages/@overeng/utils-dev',
] as const
