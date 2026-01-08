/**
 * Type-safe package.json generator
 * Reference: https://github.com/sindresorhus/type-fest/blob/main/source/package-json.d.ts
 */

type Person =
  | string
  | {
      name: string
      email?: string
      url?: string
    }

type Bugs =
  | string
  | {
      url?: string
      email?: string
    }

type Repository =
  | string
  | {
      type: string
      url: string
      directory?: string
    }

type ExportsEntry =
  | string
  | Record<string, string>
  | {
      import?: string
      require?: string
      node?: string
      default?: string
      types?: string
      browser?: string
    }

type Funding =
  | string
  | {
      type?: string
      url?: string
    }

/** Arguments for generating a package.json file */
export type PackageJSONArgs = {
  /** Package name */
  name?: string
  /** Package version (semver) */
  version?: string
  /** Short package description */
  description?: string
  /** Keywords for npm search */
  keywords?: string[]
  /** Homepage URL */
  homepage?: string
  /** Bug tracker URL or configuration */
  bugs?: Bugs
  /** License identifier (SPDX) */
  license?: string
  /** Package author */
  author?: Person
  /** Package contributors */
  contributors?: Person[]
  /** Repository information */
  repository?: Repository
  /** Main entry point (CJS) */
  main?: string
  /** Module entry point (ESM) */
  module?: string
  /** TypeScript types definition file */
  types?: string
  /** TypeScript types definition file (legacy alias) */
  typings?: string
  /** Files to include when publishing */
  files?: string[]
  /** Package entry points (modern ESM exports) */
  exports?: Record<string, ExportsEntry>
  /** Package type: "module" for ESM, "commonjs" for CJS */
  type?: 'module' | 'commonjs'
  /** Binary executables */
  bin?: string | Record<string, string>
  /** Man pages */
  man?: string | string[]
  /** Directory structure */
  directories?: {
    lib?: string
    bin?: string
    man?: string
    doc?: string
    example?: string
    test?: string
  }
  /** npm scripts */
  scripts?: Record<string, string>
  /** Package configuration values */
  config?: Record<string, unknown>
  /** Production dependencies */
  dependencies?: Record<string, string>
  /** Development dependencies */
  devDependencies?: Record<string, string>
  /** Peer dependencies */
  peerDependencies?: Record<string, string>
  /** Peer dependency metadata */
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  /** Optional dependencies */
  optionalDependencies?: Record<string, string>
  /** Bundled dependencies */
  bundledDependencies?: string[]
  /** Engine requirements */
  engines?: {
    node?: string
    npm?: string
    pnpm?: string
    yarn?: string
  }
  /** Supported operating systems */
  os?: string[]
  /** Supported CPU architectures */
  cpu?: string[]
  /** Mark as private (prevents publishing) */
  private?: boolean
  /** Publishing configuration */
  publishConfig?: {
    access?: 'public' | 'restricted'
    registry?: string
    tag?: string
    [key: string]: unknown
  }
  /** Workspace configuration */
  workspaces?: string[] | { packages?: string[] }
  /** pnpm-specific configuration */
  pnpm?: {
    overrides?: Record<string, string>
    /** Patched dependencies with paths to patch files */
    patchedDependencies?: Record<string, string>
    /** Packages that should only be built (not hoisted) */
    onlyBuiltDependencies?: string[]
    packageExtensions?: Record<
      string,
      {
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
    >
    peerDependencyRules?: {
      allowedVersions?: Record<string, string>
      ignoreMissing?: string[]
    }
  }
  /** npm/pnpm hooks */
  hooks?: Record<string, string>
  /** Tree-shaking side effects configuration */
  sideEffects?: boolean | string[]
  /** Browser field for bundlers */
  browser?: string | Record<string, string | false>
  /** Funding information */
  funding?: Funding | Funding[]
  /** Yarn resolutions */
  resolutions?: Record<string, string>
  /** pnpm: prefer unplugged */
  preferUnplugged?: boolean
  /** Package manager for corepack */
  packageManager?: string
  /** pnpm catalog references */
  catalog?: Record<string, string>
  /** pnpm patched dependencies */
  patchedDependencies?: Record<string, string>
}

/** Options for customizing package.json generation */
export type PackageJSONOptions = {
  /** Custom stringify function */
  stringify?: (args: PackageJSONArgs) => string
}

/**
 * Creates a package.json configuration string.
 *
 * Generated files include a `$genie` field which is enriched by cli.ts with source file
 * information. The field appears at the end after oxfmt sorting (known fields first).
 *
 * @example
 * ```ts
 * export default packageJSON({
 *   name: "my-package",
 *   version: "1.0.0",
 *   type: "module",
 *   exports: { ".": "./src/mod.ts" }
 * })
 * ```
 */
// oxlint-disable-next-line overeng/jsdoc-require-exports, overeng/named-args -- JSDoc above; DSL-style API
export const packageJSON = (args: PackageJSONArgs, options?: PackageJSONOptions): string => {
  if (args.private !== true) {
    if (args.name === undefined) {
      console.warn('Warning: Package is not private but missing a name')
    }
    if (args.version === undefined) {
      console.warn('Warning: Package is not private but missing a version')
    }
  }

  // Add marker field - cli.ts enriches this with source file info
  const withMarker = {
    $genie: true,
    ...args,
  }

  return options?.stringify?.(withMarker) ?? JSON.stringify(withMarker, null, 2)
}
