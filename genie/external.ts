/**
 * External configuration - reusable by peer repos
 *
 * This file contains configuration that peer repos can import when they
 * include effect-utils as a submodule.
 *
 * For effect-utils internal use, import from `./internal.ts` instead.
 */

import {
  CatalogBrand,
  computeRelativePath,
  createWorkspaceDepsResolver,
  defineCatalog,
  definePatchedDependencies,
  githubRuleset,
  githubWorkflow,
  megarepoJson,
  oxfmtConfig,
  oxlintConfig,
  packageJson,
  pnpmWorkspaceYaml,
  tsconfigJson,
  workspaceRoot,
  type GenieOutput,
  type GithubRulesetArgs,
  type GitHubWorkflowArgs,
  type MegarepoConfigArgs,
  type OxfmtConfigArgs,
  type OxlintConfigArgs,
  type PackageJsonData,
  type PatchesRegistry,
  type PnpmSettings,
  type PnpmWorkspaceData,
  type ScriptValue,
  type TSConfigArgs,
  type TSConfigCompilerOptions,
  type WorkspaceRootData,
} from '../packages/@overeng/genie/src/runtime/mod.ts'

/** Re-export so TypeScript can reference it in generated declaration files */
export {
  CatalogBrand,
  computeRelativePath,
  createWorkspaceDepsResolver,
  defineCatalog,
  definePatchedDependencies,
  githubRuleset,
  githubWorkflow,
  megarepoJson,
  oxfmtConfig,
  oxlintConfig,
  packageJson,
  pnpmWorkspaceYaml,
  tsconfigJson,
  workspaceRoot,
}
export type {
  GenieOutput,
  GithubRulesetArgs,
  GitHubWorkflowArgs,
  MegarepoConfigArgs,
  OxfmtConfigArgs,
  OxlintConfigArgs,
  PackageJsonData,
  PatchesRegistry,
  PnpmSettings,
  PnpmWorkspaceData,
  ScriptValue,
  TSConfigArgs,
  TSConfigCompilerOptions,
  WorkspaceRootData,
}

// =============================================================================
// pnpm Workspace Helpers
// =============================================================================

/**
 * Convenience shorthand for pnpm-workspace.yaml generation.
 *
 * By default, includes the current directory and all sibling packages (`../*`).
 * Pass custom patterns to include cross-repo packages.
 *
 * Sets `dedupePeerDependents: true` to prevent React duplication issues
 * when packages with peer dependencies are used across package boundaries.
 *
 * For full API access, use `pnpmWorkspaceYaml()` directly.
 *
 * @see https://pnpm.io/pnpm-workspace_yaml
 *
 * @example
 * ```typescript
 * // Standalone package (no siblings)
 * export default pnpmWorkspace('.')
 *
 * // Basic usage - includes siblings
 * export default pnpmWorkspace()
 *
 * // With specific workspace deps
 * export default pnpmWorkspace('../utils', '../tui-react')
 *
 * // With cross-repo packages
 * export default pnpmWorkspace(
 *   '../*',
 *   '../../repos/effect-utils/packages/@overeng/*'
 * )
 *
 * // For full config access, use pnpmWorkspaceYaml directly:
 * export default pnpmWorkspaceYaml({
 *   packages: ['.', '../*'],
 *   dedupePeerDependents: true,
 *   catalog: { react: '18.2.0' },
 * })
 * ```
 */
export const pnpmWorkspace = (...patterns: string[]) => {
  // '.' means standalone (no siblings), otherwise default to '../*'
  const isStandalone = patterns.length === 1 && patterns[0] === '.'
  const additionalPatterns = isStandalone ? [] : patterns.length > 0 ? patterns : ['../*']

  return pnpmWorkspaceYaml({
    packages: ['.', ...additionalPatterns],
    dedupePeerDependents: true,
  })
}

/** A package.json genie output, used as input for workspace deps resolution. */
export type PackageJsonGenie = GenieOutput<PackageJsonData>

/**
 * Catalog versions - single source of truth for dependency versions
 *
 * This catalog contains only external npm package versions.
 * Internal @overeng/* packages are added in internal.ts for effect-utils use.
 *
 * Note: packages/@overeng/react-inspector is a git submodule with its own tooling (tsup, ESLint)
 * We include it in the workspace but keep its build system separate
 */
/**
 * OpenTelemetry SDK packages - peer deps of @effect/opentelemetry.
 * Consumers of packages that depend on @effect/opentelemetry need these.
 */
export const otelSdkDeps = [
  '@opentelemetry/resources',
  '@opentelemetry/sdk-logs',
  '@opentelemetry/sdk-metrics',
  '@opentelemetry/sdk-trace-base',
  '@opentelemetry/sdk-trace-node',
  '@opentelemetry/sdk-trace-web',
  '@opentelemetry/semantic-conventions',
] as const

/** Catalog versions - single source of truth for dependency versions */
export const catalog = defineCatalog({
  // Observability
  '@opentelemetry/api': '1.9.0',
  '@opentelemetry/resources': '2.2.0',
  '@opentelemetry/sdk-logs': '0.208.0',
  '@opentelemetry/sdk-metrics': '2.2.0',
  '@opentelemetry/sdk-trace-base': '2.2.0',
  '@opentelemetry/sdk-trace-node': '2.2.0',
  '@opentelemetry/sdk-trace-web': '2.2.0',
  '@opentelemetry/semantic-conventions': '1.38.0',

  // Effect ecosystem
  '@effect/ai': '0.33.2',
  'effect-distributed-lock': '0.0.11',
  effect: '3.19.15',
  '@effect/platform': '0.94.2',
  '@effect/platform-node': '0.104.1',
  '@effect/cli': '0.73.1',
  '@effect/vitest': '0.27.0',
  '@effect/printer': '0.47.0',
  '@effect/printer-ansi': '0.47.0',
  '@effect/typeclass': '0.38.0',
  '@effect/cluster': '0.56.1',
  '@effect/sql': '0.49.0',
  '@effect/experimental': '0.58.0',
  '@effect/workflow': '0.16.0',
  '@effect/language-service': '0.69.2',
  '@effect/rpc': '0.73.0',
  '@effect/opentelemetry': '0.61.0',

  // React ecosystem
  react: '19.2.3',
  'react-dom': '19.2.3',
  'react-aria-components': '1.14.0',

  // Type definitions
  '@types/react': '19.2.7',
  '@types/react-dom': '19.2.3',
  '@types/node': '25.0.3',
  '@types/bun': '1.3.5',
  '@types/eslint': '9.6.1',
  '@types/is-dom': '1.1.2',

  // Build tools
  typescript: '5.9.3',
  '@playwright/test': '1.57.0',
  vite: '7.3.0',
  // TODO upgrade to 4.x once fixed https://github.com/Effect-TS/effect/issues/5976
  vitest: '3.2.4',
  '@vitejs/plugin-react': '5.1.2',

  // TanStack
  '@tanstack/react-router': '1.145.7',
  '@tanstack/react-start': '1.145.10',
  '@tanstack/router-plugin': '1.145.10',

  // Styling
  tailwindcss: '4.1.18',
  '@tailwindcss/vite': '4.1.18',

  // Storybook
  storybook: '10.2.1',
  '@storybook/react': '10.2.1',
  '@storybook/react-vite': '10.2.1',
  'eslint-plugin-storybook': '10.2.3',

  // xterm (terminal emulator for browser/testing)
  '@xterm/xterm': '6.0.0',
  '@xterm/headless': '6.0.0',
  '@xterm/addon-fit': '0.11.0',

  // Testing
  '@testing-library/react': '16.3.1',
  '@testing-library/user-event': '14.6.1',
  'happy-dom': '18.0.1',

  // Linting
  /** Kept for rule-tester/types used by our custom lint rules even though runtime linting is oxlint. */
  eslint: '9.39.2',
  '@typescript-eslint/parser': '8.52.0',
  '@typescript-eslint/rule-tester': '8.52.0',
  '@typescript-eslint/utils': '8.52.0',
  'typescript-eslint': '8.52.0',
  oxfmt: '0.23.0',
  oxlint: '1.39.0',
  'oxlint-tsgolint': '0.11.4',

  // Crypto
  '@noble/hashes': '1.7.1',

  // DOM utilities
  'is-dom': '1.1.0',

  // Redis
  ioredis: '5.6.1',

  // OpenTUI / Effect Atom (experimental)
  '@effect-atom/atom': '0.4.13',
  '@effect-atom/atom-react': '0.4.5',
  '@opentui/core': '0.1.74',
  '@opentui/react': '0.1.74',

  // Pi-tui (terminal UI framework)
  '@mariozechner/pi-tui': '0.45.7',

  // TUI React renderer dependencies
  'react-reconciler': '0.33.0',
  '@types/react-reconciler': '0.28.9',
  'yoga-layout': '3.2.1',
  'string-width': '7.2.0',
  'cli-truncate': '5.1.1',
})

/** Common fields for private packages */
export const privatePackageDefaults = {
  version: '0.1.0',
  private: true,
  type: 'module',
} as const

/** Standard package tsconfig compiler options (composite mode with src/dist structure) */
export const packageTsconfigCompilerOptions = {
  composite: true,
  rootDir: '.',
  outDir: './dist',
  tsBuildInfoFile: './dist/tsconfig.tsbuildinfo',
} as const

/** DOM library set for browser-compatible packages */
export const domLib = ['ES2024', 'DOM', 'DOM.Iterable'] as const

/** React JSX configuration for React packages */
export const reactJsx = { jsx: 'react-jsx' as const }

// =============================================================================
// Effect Language Service Helpers
// =============================================================================

/**
 * DevDependencies required for Effect Language Service.
 * Includes both the language service and typescript (required for patching).
 *
 * Patching is handled centrally by the `ts:patch-lsp` devenv task (see ts.nix),
 * not by per-package postinstall scripts. Packages still need these devDeps
 * for tsconfig plugin module resolution.
 */
export const effectLspDevDeps = () => catalog.pick('@effect/language-service', 'typescript')

// =============================================================================
// TypeScript Reference Helpers
// =============================================================================

/**
 * effect-utils package paths for tsconfig references.
 * Paths are relative to the packages directory (e.g. '@overeng/react-inspector').
 * Parent repos can use createRefs() to build refs with the appropriate base path.
 */
export const effectUtilsPackages = {
  reactInspector: '@overeng/react-inspector',
  schemaForm: '@overeng/effect-schema-form',
} as const

/**
 * Creates tsconfig reference objects for effect-utils packages.
 * @param basePath Path from consuming package to effect-utils' packages dir (e.g. '../../../submodules/effect-utils/packages')
 */
export const createEffectUtilsRefs = (basePath: string) =>
  Object.fromEntries(
    Object.entries(effectUtilsPackages).map(([key, pkgPath]) => [
      key,
      { path: `${basePath}/${pkgPath}` },
    ]),
  ) as { [K in keyof typeof effectUtilsPackages]: { path: string } }

// =============================================================================
// Patch Postinstall Helpers
// =============================================================================

/**
 * Patches registry for effect-utils dependencies.
 * Paths are relative to the effect-utils repo root.
 *
 * See context/workarounds/bun-patched-dependencies.md for details on why
 * we use postinstall scripts instead of bun's patchedDependencies.
 */
const patches = {
  'effect-distributed-lock@0.0.11': 'packages/@overeng/utils/patches/effect-distributed-lock@0.0.11.patch',
} as const satisfies PatchesRegistry

/**
 * Parse a patch specifier into package name and version.
 */
const parsePatchSpecifier = (specifier: string): [string, string] | undefined => {
  const lastAtIndex = specifier.lastIndexOf('@')
  if (lastAtIndex <= 0) return undefined

  if (specifier.startsWith('@') === true) {
    const afterScope = specifier.indexOf('/', 1)
    if (afterScope === -1) return undefined
    const versionAtIndex = specifier.indexOf('@', afterScope)
    if (versionAtIndex === -1) return undefined
    return [specifier.slice(0, versionAtIndex), specifier.slice(versionAtIndex + 1)]
  }

  return [specifier.slice(0, lastAtIndex), specifier.slice(lastAtIndex + 1)]
}

/**
 * Generate postinstall script commands for applying patches.
 */
const generatePatchCommands = ({
  patchEntries,
  location,
}: {
  patchEntries: Array<[string, string]>
  location: string
}): string => {
  return patchEntries
    .map(([specifier, patchPath]) => {
      const parsed = parsePatchSpecifier(specifier)
      if (!parsed) return undefined
      const [pkgName] = parsed
      const relativePath =
        patchPath.startsWith('./') === true || patchPath.startsWith('../') === true
          ? patchPath
          : computeRelativePath({ from: location, to: patchPath })
      return `patch --forward -p1 -d node_modules/${pkgName} < ${relativePath} || true`
    })
    .filter((x): x is string => x !== undefined)
    .join(' && ')
}

/**
 * Creates a postinstall script function for applying patches.
 * Returns a function that resolves at stringify time using ctx.location.
 *
 * Uses the effect-utils patches registry by default.
 *
 * @example
 * ```ts
 * import { patchPostinstall } from '../genie/repo.ts'
 *
 * export default packageJson({
 *   scripts: {
 *     postinstall: patchPostinstall(),
 *   },
 * })
 * ```
 */
export const patchPostinstall = (customPatches: PatchesRegistry = patches): ScriptValue => {
  const entries = Object.entries(customPatches).toSorted(([a], [b]) => a.localeCompare(b))
  return (location: string) => generatePatchCommands({ patchEntries: entries, location })
}

/**
 * Returns pnpm.patchedDependencies config using the effect-utils patches registry.
 *
 * Uses pnpm's native patching which works with `--ignore-scripts` (patches are applied
 * during package resolution, not as lifecycle scripts).
 *
 * Paths are repo-relative and will be resolved to package-relative paths at stringify time.
 *
 * @example
 * ```ts
 * import { pnpmPatchedDependencies } from '../genie/repo.ts'
 *
 * export default packageJson({
 *   pnpm: {
 *     patchedDependencies: pnpmPatchedDependencies(),
 *   },
 * })
 * ```
 */
export const pnpmPatchedDependencies = (
  customPatches: PatchesRegistry = patches,
): PatchesRegistry => ({ ...customPatches })

/**
 * Creates a pnpmPatchedDependencies function with prefixed paths for use from a peer repo.
 *
 * @param basePath Path from consuming repo to effect-utils root (e.g. 'effect-utils')
 * @returns A pnpmPatchedDependencies function that uses prefixed patch paths
 *
 * @example
 * ```ts
 * // In schickling.dev/genie/repo.ts
 * import { createPnpmPatchedDependencies } from './effect-utils/genie/external.ts'
 *
 * export const pnpmPatchedDependencies = createPnpmPatchedDependencies({ basePath: 'effect-utils' })
 * ```
 */
export const createPnpmPatchedDependencies = (args: { basePath: string }) => {
  const prefixedPatches = Object.fromEntries(
    Object.entries(patches).map(([pkg, path]) => [pkg, `${args.basePath}/${path}`]),
  ) as PatchesRegistry
  return (customPatches: PatchesRegistry = prefixedPatches): PatchesRegistry => ({
    ...customPatches,
  })
}

/**
 * Creates a patchPostinstall function with prefixed paths for use from a peer repo.
 *
 * @param basePath Path from consuming repo to effect-utils root (e.g. 'effect-utils')
 * @returns A patchPostinstall function that uses prefixed patch paths
 *
 * @example
 * ```ts
 * // In schickling.dev/genie/repo.ts
 * import { createPatchPostinstall } from './effect-utils/genie/external.ts'
 *
 * export const patchPostinstall = createPatchPostinstall({ basePath: 'effect-utils' })
 * ```
 */
export const createPatchPostinstall = (args: { basePath: string }) => {
  const prefixedPatches = Object.fromEntries(
    Object.entries(patches).map(([pkg, path]) => [pkg, `${args.basePath}/${path}`]),
  ) as PatchesRegistry
  return (customPatches: PatchesRegistry = prefixedPatches): ScriptValue => {
    const entries = Object.entries(customPatches).toSorted(([a], [b]) => a.localeCompare(b))
    return (location: string) => generatePatchCommands({ patchEntries: entries, location })
  }
}

/** Base tsconfig compiler options shared across all packages */
export const baseTsconfigCompilerOptions = {
  target: 'ES2024',
  lib: ['ES2024'],
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  resolveJsonModule: true,
  esModuleInterop: true,
  allowJs: false,
  declaration: true,
  declarationMap: true,
  sourceMap: true,
  outDir: 'dist',
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitReturns: true,
  noFallthroughCasesInSwitch: true,
  noImplicitOverride: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  forceConsistentCasingInFileNames: true,
  plugins: [
    {
      // Important: Do not disable/weaken these warnings.
      // Keep Effect Language Service checks active in CLI so they are visible during
      // typecheck/build. These remain non-fatal but are reported as CLI warnings.
      name: '@effect/language-service',
      reportSuggestionsAsWarningsInTsc: true,
      pipeableMinArgCount: 2,
      diagnosticSeverity: {
        missedPipeableOpportunity: 'warning',
        schemaUnionOfLiterals: 'warning',
        anyUnknownInErrorContext: 'warning',
        preferSchemaOverJson: 'warning',
      },
    },
  ],
} as const satisfies TSConfigCompilerOptions

// =============================================================================
// Oxlint Configuration Helpers
// =============================================================================

import type { OxlintOverride } from '../packages/@overeng/genie/src/runtime/oxlint-config/mod.ts'

/** Standard oxlint plugins for Effect/TypeScript projects (includes oxc for custom rules) */
export const baseOxlintPlugins = ['import', 'typescript', 'unicorn', 'oxc'] as const

/** Standard oxlint category severities */
export const baseOxlintCategories = {
  correctness: 'error',
  suspicious: 'warn',
  pedantic: 'off',
  perf: 'warn',
  style: 'off',
  restriction: 'off',
} as const satisfies OxlintConfigArgs['categories']

/** Standard oxlint rules for Effect/TypeScript projects (includes custom overeng rules) */
export const baseOxlintRules = {
  // Disallow dynamic import() and require()
  'import/no-dynamic-require': ['warn', { esmodule: true }],
  // Disallow re-exports except in mod.ts entry points
  'oxc/no-barrel-file': ['warn', { threshold: 0 }],
  // Enforce named arguments (options objects) instead of positional parameters
  'overeng/named-args': 'warn',
  // Disallow CommonJS (require/module.exports) - enforce ESM
  'import/no-commonjs': 'error',
  // Detect circular dependencies
  'import/no-cycle': 'warn',
  // Prefer function expressions over declarations
  'func-style': ['warn', 'expression', { allowArrowFunctions: true }],
  // Enforce exported declarations come before non-exported declarations
  'overeng/exports-first': 'warn',
  // Require JSDoc comments on type/wildcard exports
  'overeng/jsdoc-require-exports': 'warn',
  // Basic quality rules
  'no-unused-vars': 'warn',
  eqeqeq: 'error',
} as const satisfies OxlintConfigArgs['rules']

/** Standard overrides for mod.ts entry point files */
export const modEntryOxlintOverride = {
  files: ['**/mod.ts'],
  rules: { 'oxc/no-barrel-file': 'off' },
} as const satisfies OxlintOverride

/** Standard overrides for storybook story files (*.stories.*) */
export const storybookOxlintOverride = {
  files: ['**/*.stories.tsx', '**/*.stories.ts'],
  rules: {
    // Relaxed rules for story files
    'func-style': 'off',
    'overeng/exports-first': 'off',
    'overeng/jsdoc-require-exports': 'off',
    // Storybook best practices (re-exported from eslint-plugin-storybook)
    'overeng/storybook/meta-satisfies-type': 'error',
    'overeng/storybook/default-exports': 'error',
    'overeng/storybook/story-exports': 'warn',
    'overeng/storybook/csf-component': 'warn',
    'overeng/storybook/hierarchy-separator': 'warn',
    'overeng/storybook/no-redundant-story-name': 'warn',
    'overeng/storybook/prefer-pascal-case': 'warn',
  },
} as const satisfies OxlintOverride

/** Standard overrides for storybook config files (.storybook/*) */
export const storybookConfigOxlintOverride = {
  files: ['**/.storybook/**'],
  rules: {
    'func-style': 'off',
    'overeng/exports-first': 'off',
    'overeng/jsdoc-require-exports': 'off',
    'import/no-unassigned-import': 'off',
  },
} as const satisfies OxlintOverride

/** Standard overrides for config files */
export const configFilesOxlintOverride = {
  files: ['**/vitest.config.ts', '**/vite.config.ts', '**/playwright.config.ts'],
  rules: {
    'func-style': 'off',
    'overeng/jsdoc-require-exports': 'off',
  },
} as const satisfies OxlintOverride

/** Standard overrides for test files */
export const testFilesOxlintOverride = {
  files: ['**/*.test.ts', '**/*.test.tsx', '**/__tests__/**'],
  rules: {
    'overeng/named-args': 'off',
    'unicorn/no-array-sort': 'off',
    'unicorn/consistent-function-scoping': 'off',
    'require-yield': 'off',
  },
} as const satisfies OxlintOverride

/** Re-export oxlint ignore patterns from oxlint-base */
export { baseOxlintIgnorePatterns } from './oxlint-base.ts'

// =============================================================================
// CI Workflow Helpers
// =============================================================================

export {
  checkoutStep,
  cachixStep,
  devenvShellDefaults,
  installDevenvFromLockStep,
  installMegarepoStep,
  installNixStep,
  namespaceRunner,
  repairNixStoreStep,
  standardCIEnv,
  syncMegarepoStep,
  RUNNER_PROFILES,
  type RunnerProfile,
} from './ci-workflow.ts'
