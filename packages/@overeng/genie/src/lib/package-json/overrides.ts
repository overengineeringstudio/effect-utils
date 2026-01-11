/**
 * Type-safe overrides composition with duplicate/conflict detection.
 *
 * Similar to catalog.ts but for pnpm overrides and patched dependencies.
 */

import { Schema } from 'effect'

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
export class OverrideConflictError extends Schema.TaggedError<OverrideConflictError>()(
  'OverrideConflictError',
  {
    key: Schema.String,
    baseValue: Schema.String,
    newValue: Schema.String,
  },
) {
  get message() {
    return `Override conflict for "${this.key}": "${this.baseValue}" vs "${this.newValue}"`
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
>(
  input: { extends: readonly TBase[]; overrides: TNew },
): TBase & TNew => {
  const merged: Record<string, string> = {}

  // Merge all base overrides
  for (const base of input.extends) {
    for (const [key, value] of Object.entries(base)) {
      if (key in merged && merged[key] !== value) {
        throw new OverrideConflictError({ key, baseValue: merged[key]!, newValue: value })
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
        throw new OverrideConflictError({ key, baseValue: merged[key]!, newValue: value })
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
 * prefixPatchPaths(patches, 'submodules/foo/')
 * // => { 'pkg@1.0.0': 'submodules/foo/patches/pkg.patch' }
 * ```
 */
export const prefixPatchPaths = <T extends Record<string, string>>(
  patches: T,
  prefix: string,
): { [K in keyof T]: string } =>
  Object.fromEntries(
    Object.entries(patches).map(([pkg, path]) => [pkg, `${prefix}${path}`]),
  ) as { [K in keyof T]: string }
