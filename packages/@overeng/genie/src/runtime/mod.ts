/** Context passed to genie generator functions */
export type GenieContext = {
  /** Repo-relative path to the directory containing this genie file (e.g., 'packages/@overeng/utils') */
  location: string
  /** Absolute path to the working directory (repo root) */
  cwd: string
}

/**
 * Standard output shape for all genie factories.
 *
 * Genie files export a `GenieOutput<T>` object which contains:
 * - `data`: The structured configuration data (fully typed)
 * - `stringify`: A function that serializes the data to a string (JSON, YAML, etc.)
 *
 * This design enables composition - other genie files can import and access
 * the structured data (e.g., for peer dependency inheritance).
 *
 * @example
 * ```ts
 * // Compose peer dependencies from another package
 * import utilsPkg from '../utils/package.json.genie.ts'
 *
 * export default packageJson({
 *   name: 'my-pkg',
 *   peerDependencies: {
 *     ...utilsPkg.data.peerDependencies,
 *   }
 * })
 * ```
 */
export type GenieOutput<T> = {
  /** The structured configuration data */
  data: T
  /** Serialize the data to a string for file output */
  stringify: (ctx: GenieContext) => string
}

export * from './dotdot-config/mod.ts'
export * from './github-workflow/mod.ts'
export * from './oxfmt-config/mod.ts'
export * from './oxlint-config/mod.ts'
export * from './package-json/mod.ts'
export * from './pnpm-workspace/mod.ts'
export * from './tsconfig-json/mod.ts'
