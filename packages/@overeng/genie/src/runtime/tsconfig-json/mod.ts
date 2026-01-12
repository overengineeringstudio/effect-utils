/**
 * Type-safe tsconfig.json generator
 * Reference: https://www.typescriptlang.org/tsconfig
 */

type Target =
  | 'ES3'
  | 'ES5'
  | 'ES6'
  | 'ES2015'
  | 'ES2016'
  | 'ES2017'
  | 'ES2018'
  | 'ES2019'
  | 'ES2020'
  | 'ES2021'
  | 'ES2022'
  | 'ES2023'
  | 'ES2024'
  | 'ESNext'

type Module =
  | 'CommonJS'
  | 'AMD'
  | 'System'
  | 'UMD'
  | 'ES6'
  | 'ES2015'
  | 'ES2020'
  | 'ES2022'
  | 'ESNext'
  | 'Node16'
  | 'NodeNext'
  | 'None'
  | 'Preserve'

type ModuleResolution = 'Node' | 'Node10' | 'Node16' | 'NodeNext' | 'Classic' | 'Bundler'

type JSX = 'preserve' | 'react' | 'react-native' | 'react-jsx' | 'react-jsxdev'

type WatchFile =
  | 'useFsEvents'
  | 'dynamicPriorityPolling'
  | 'fixedPollingInterval'
  | 'priorityPollingInterval'

type WatchDirectory =
  | 'useFsEvents'
  | 'dynamicPriorityPolling'
  | 'fixedPollingInterval'
  | 'fixedChunkSizePolling'

type FallbackPolling =
  | 'dynamicPriority'
  | 'priorityPolling'
  | 'fixedPolling'
  | 'fixedInterval'
  | 'dynamicPriorityPolling'

/** TypeScript compiler options */
export type TSConfigCompilerOptions = {
  /** Allow JavaScript files to be compiled */
  allowJs?: boolean
  /** Allow default imports from modules with no default export */
  allowSyntheticDefaultImports?: boolean
  /** Allow importing .ts/.tsx files with .ts/.tsx extensions */
  allowImportingTsExtensions?: boolean
  /** Rewrite relative import extensions from .ts to .js */
  rewriteRelativeImportExtensions?: boolean
  /** Enable 'import x from y' when module doesn't have default export */
  esModuleInterop?: boolean
  /** ECMAScript target version */
  target?: Target
  /** Module code generation */
  module?: Module
  /** Library files to include */
  lib?: string[]
  /** JSX code generation */
  jsx?: JSX
  /** JSX factory function */
  jsxFactory?: string
  /** JSX Fragment factory */
  jsxFragmentFactory?: string
  /** Specify module specifier for importing jsx factory functions */
  jsxImportSource?: string
  /** Generate .d.ts declaration files */
  declaration?: boolean
  /** Generate .d.ts.map source maps for declaration files */
  declarationMap?: boolean
  /** Output directory for declaration files */
  declarationDir?: string
  /** Incremental compilation info file */
  tsBuildInfoFile?: string
  /** Output directory */
  outDir?: string
  /** Concatenate and emit to single file */
  outFile?: string
  /** Root directory of input files */
  rootDir?: string
  /** Multiple root folders for project structure */
  rootDirs?: string[]
  /** Skip type checking declaration files */
  skipLibCheck?: boolean
  /** Enable all strict type checking options */
  strict?: boolean
  /** Error on expressions with implied 'any' type */
  noImplicitAny?: boolean
  /** Enable strict null checks */
  strictNullChecks?: boolean
  /** Ensure class properties initialized in constructor */
  strictPropertyInitialization?: boolean
  /** Enable strict function type checking */
  strictFunctionTypes?: boolean
  /** Enable strict bind/call/apply checking */
  strictBindCallApply?: boolean
  /** Disable project reference redirect */
  disableSourceOfProjectReferenceRedirect?: boolean
  /** Error on missing return statements */
  noImplicitReturns?: boolean
  /** Error on unused local variables */
  noUnusedLocals?: boolean
  /** Error on unused parameters */
  noUnusedParameters?: boolean
  /** Error on switch case fallthrough */
  noFallthroughCasesInSwitch?: boolean
  /** Use colors in error messages */
  pretty?: boolean
  /** Enable incremental compilation */
  incremental?: boolean
  /** Generate source maps */
  sourceMap?: boolean
  /** Module resolution strategy */
  moduleResolution?: ModuleResolution
  /** Base directory for non-relative module names */
  baseUrl?: string
  /** Path mappings for module names */
  paths?: Record<string, string[]>
  /** Emit design-type metadata for decorators */
  emitDecoratorMetadata?: boolean
  /** Enable experimental decorator support */
  experimentalDecorators?: boolean
  /** Import helper functions from tslib */
  importHelpers?: boolean
  /** Enable project compilation */
  composite?: boolean
  /** Enforce consistent file name casing */
  forceConsistentCasingInFileNames?: boolean
  /** Require override modifier for derived class members */
  noImplicitOverride?: boolean
  /** Remove comments from output */
  removeComments?: boolean
  /** Don't truncate error messages */
  noErrorTruncation?: boolean
  /** Don't emit on errors */
  noEmitOnError?: boolean
  /** Error on indexing objects without index signatures */
  noUncheckedIndexedAccess?: boolean
  /** Don't emit @internal declarations */
  stripInternal?: boolean
  /** Don't emit output files */
  noEmit?: boolean
  /** Allow UMD global access from modules */
  allowUmdGlobalAccess?: boolean
  /** Ensure imports can be safely transpiled in isolation */
  isolatedModules?: boolean
  /** Suppress excess property errors */
  suppressExcessPropertyErrors?: boolean
  /** Suppress implicit any index errors */
  suppressImplicitAnyIndexErrors?: boolean
  /** Type declaration root directories */
  typeRoots?: string[]
  /** Type declarations to include */
  types?: string[]
  /** Language service plugins */
  plugins?: Array<{
    name: string
    transform?: string
    after?: boolean
    afterDeclarations?: boolean
    [key: string]: unknown
  }>
  /** Enable resolution tracing */
  traceResolution?: boolean
  /** keyof only yields string-valued properties */
  keyofStringsOnly?: boolean
  /** Use defineProperty for class fields */
  useDefineForClassFields?: boolean
  /** Emit imports/exports as written */
  verbatimModuleSyntax?: boolean
  /** Exact optional property types */
  exactOptionalPropertyTypes?: boolean
  /** Allow arbitrary extensions in imports */
  allowArbitraryExtensions?: boolean
  /** Resolve package.json exports */
  resolvePackageJsonExports?: boolean
  /** Resolve package.json imports */
  resolvePackageJsonImports?: boolean
  /** Resolve JSON modules */
  resolveJsonModule?: boolean
  /** Disable solution searching */
  disableSolutionSearching?: boolean
  /** Disable referenced project load */
  disableReferencedProjectLoad?: boolean
  /** Use case-sensitive file names */
  useCaseSensitiveFileNames?: boolean
  /** Custom conditions for exports/imports resolution */
  customConditions?: string[]
  /** Only allow syntax that can be erased (for Node.js type stripping) */
  erasableSyntaxOnly?: boolean
}

/** TypeScript watch mode options */
export type TSConfigWatchOptions = {
  /** File watching strategy */
  watchFile?: WatchFile
  /** Directory watching strategy */
  watchDirectory?: WatchDirectory
  /** Fallback polling strategy */
  fallbackPolling?: FallbackPolling
  /** Synchronous directory watching */
  synchronousWatchDirectory?: boolean
  /** Files to exclude from watching */
  excludeFiles?: string[]
  /** Directories to exclude from watching */
  excludeDirectories?: string[]
}

/** ts-node specific configuration options */
export type TSNodeOptions = {
  /** Use TypeScript compiler host API */
  compilerHost?: boolean
  /** Merge with compiler options */
  compilerOptions?: Record<string, unknown>
  /** Emit output files */
  emit?: boolean
  /** Load files from tsconfig.json */
  files?: boolean
  /** Path patterns to skip */
  ignore?: string[]
  /** Diagnostic codes to ignore */
  ignoreDiagnostics?: (string | number)[]
  /** Transpile with swc */
  swc?: boolean
  /** Use pretty diagnostic formatter */
  pretty?: boolean
  /** Use transpileModule for faster compilation */
  transpileOnly?: boolean
  /** Prefer .ts extensions in imports */
  preferTsExts?: boolean
  /** Modules to require */
  require?: string[]
  /** Skip ignore check */
  skipIgnore?: boolean
  /** Custom compiler path */
  compiler?: string
  /** Custom transpiler */
  transpiler?: string
}

/** Arguments for generating a tsconfig.json file */
export type TSConfigArgs = {
  /** Files to include (glob patterns) */
  include?: string[]
  /** Files to exclude (glob patterns) */
  exclude?: string[]
  /** Explicit file list */
  files?: string[]
  /** Base configuration to extend */
  extends?: string | string[]
  /** Project references */
  references?: Array<{ path: string; prepend?: boolean }>
  /** Compiler options */
  compilerOptions?: TSConfigCompilerOptions
  /** Watch options */
  watchOptions?: TSConfigWatchOptions
  /** ts-node options */
  ts_node?: TSNodeOptions
}

/** Options for customizing tsconfig.json generation (reserved for future use) */
export type TSConfigOptions = Record<string, never>

/**
 * Creates a tsconfig.json configuration string
 *
 * @example
 * ```ts
 * export default tsconfigJSON({
 *   extends: "../tsconfig.base.json",
 *   compilerOptions: {
 *     rootDir: ".",
 *     outDir: "dist"
 *   },
 *   include: ["src/**\/*.ts"]
 * })
 * ```
 */
// oxlint-disable-next-line overeng/named-args -- DSL-style API
export const tsconfigJSON = (args: TSConfigArgs, _options?: TSConfigOptions): string => {
  return JSON.stringify(args, null, 2)
}
