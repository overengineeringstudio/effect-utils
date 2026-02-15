/**
 * Type-safe overrides composition with duplicate/conflict detection.
 *
 * Similar to catalog.ts but for pnpm overrides and patched dependencies.
 */

// =============================================================================
// Types
// =============================================================================

/** Base overrides type - a record of package names to version/value strings */
export type OverridesInput = Record<string, string>

/** Configuration for extending existing overrides */
export type ExtendedOverridesInput<TBase extends OverridesInput = OverridesInput> = {
  /** Base override sets to extend from */
  extends: readonly TBase[]
  /** New overrides to add (will be checked for duplicates/conflicts) */
  overrides: OverridesInput
}

// =============================================================================
// Errors
// =============================================================================

/** Error thrown when overrides have conflicting values for the same key */
export class OverrideConflictError extends Error {
  public readonly key: string
  public readonly baseValue: string
  public readonly newValue: string

  constructor(args: { key: string; baseValue: string; newValue: string }) {
    const { key, baseValue, newValue } = args
    super(`Override conflict for "${key}": "${baseValue}" vs "${newValue}"`)
    this.key = key
    this.baseValue = baseValue
    this.newValue = newValue
    this.name = 'OverrideConflictError'
  }
}

// =============================================================================
// Composition Helpers
// =============================================================================

/**
 * Composes multiple override objects with duplicate/conflict detection.
 *
 * - Duplicate (same key + same value): Console warning, proceeds
 * - Conflict (same key + different value): Throws {@link OverrideConflictError}
 *
 * @example
 * ```ts
 * const livestoreOverrides = { puppeteer: '23.11.1' }
 * const myOverrides = { '@types/node': 'catalog:' }
 *
 * const composed = defineOverrides({
 *   extends: [livestoreOverrides],
 *   overrides: myOverrides,
 * })
 * // => { puppeteer: '23.11.1', '@types/node': 'catalog:' }
 * ```
 */
export const defineOverrides = <
  const TBase extends OverridesInput,
  const TNew extends OverridesInput,
>(input: {
  extends: readonly TBase[]
  overrides: TNew
}): TBase & TNew => {
  const merged: Record<string, string> = {}

  // Merge all base overrides
  for (const base of input.extends) {
    for (const [key, value] of Object.entries(base)) {
      if (key in merged && merged[key] !== value) {
        throw new OverrideConflictError({
          key,
          baseValue: merged[key]!,
          newValue: value,
        })
      }
      merged[key] = value
    }
  }

  // Check and merge new overrides
  for (const [key, value] of Object.entries(input.overrides)) {
    if (key in merged) {
      if (merged[key] === value) {
        console.warn(`[defineOverrides] Duplicate: "${key}" = "${value}" already defined`)
      } else {
        throw new OverrideConflictError({
          key,
          baseValue: merged[key]!,
          newValue: value,
        })
      }
    }
    merged[key] = value
  }

  return merged as TBase & TNew
}

/**
 * Prefix all patch paths with a base path.
 *
 * Useful when composing patches from submodules that need path prefixes.
 *
 * @example
 * ```ts
 * const patches = { 'pkg@1.0.0': 'patches/pkg.patch' }
 * prefixPatchPaths({ patches, prefix: 'submodules/foo/' })
 * // => { 'pkg@1.0.0': 'submodules/foo/patches/pkg.patch' }
 * ```
 */
export const prefixPatchPaths = <T extends Record<string, string>>(args: {
  patches: T
  prefix: string
}): { [K in keyof T]: string } =>
  Object.fromEntries(
    Object.entries(args.patches).map(([pkg, path]) => [pkg, `${args.prefix}${path}`]),
  ) as {
    [K in keyof T]: string
  }

/**
 * Defines patched dependencies with repo-relative paths.
 *
 * Use this to define patches that can be inherited by downstream packages.
 * The paths are repo-relative and will be resolved to package-relative paths
 * at stringify time by genie.
 *
 * @param location - Repo-relative location of the package defining the patches (e.g., 'packages/@overeng/utils')
 * @param patches - Patches with paths relative to the package (e.g., './patches/pkg.patch')
 * @returns Patches with repo-relative paths for composition
 *
 * @example
 * ```ts
 * // In packages/@overeng/utils/package.json.genie.ts
 * export const utilsPatches = definePatchedDependencies({
 *   location: 'packages/@overeng/utils',
 *   patches: {
 *     'effect-distributed-lock@0.0.11': './patches/effect-distributed-lock@0.0.11.patch',
 *   },
 * })
 * // => { 'effect-distributed-lock@0.0.11': 'packages/@overeng/utils/patches/effect-distributed-lock@0.0.11.patch' }
 *
 * // In scripts/package.json.genie.ts (downstream)
 * export default packageJson({
 *   patchedDependencies: {
 *     ...utilsPatches, // Genie resolves to '../packages/@overeng/utils/patches/...'
 *   },
 * })
 * ```
 */
export const definePatchedDependencies = <T extends Record<string, string>>(args: {
  location: string
  patches: T
}): { [K in keyof T]: string } =>
  Object.fromEntries(
    Object.entries(args.patches).map(([pkg, path]) => {
      // Convert local path (./patches/...) to repo-relative path
      const repoRelativePath =
        path.startsWith('./') === true
          ? `${args.location}/${path.slice(2)}`
          : path.startsWith('../') === true
            ? `${args.location}/${path}`
            : path
      return [pkg, repoRelativePath]
    }),
  ) as { [K in keyof T]: string }
