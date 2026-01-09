/**
 * Shared constants and utilities for genie configuration files
 */

import { createPackageJson } from '../packages/@overeng/genie/src/lib/mod.ts'

/**
 * Catalog versions - single source of truth for dependency versions
 *
 * Note: packages/@overeng/react-inspector is a git submodule with its own tooling (tsup, ESLint)
 * We include it in the workspace but keep its build system separate
 */
export const catalog = {
  // Observability
  '@opentelemetry/api': '1.9.0',

  // Effect ecosystem
  '@effect/ai': '0.33.2',
  'effect-distributed-lock': '0.0.11',
  effect: '3.19.14',
  '@effect/platform': '0.94.1',
  '@effect/platform-node': '0.104.0',
  '@effect/cli': '0.73.0',
  '@effect/vitest': '0.27.0',
  '@effect/printer': '0.47.0',
  '@effect/printer-ansi': '0.47.0',
  '@effect/typeclass': '0.38.0',
  '@effect/cluster': '0.56.0',
  '@effect/sql': '0.49.0',
  '@effect/experimental': '0.58.0',
  '@effect/workflow': '0.16.0',
  '@effect/language-service': '0.63.2',
  '@effect/rpc': '0.73.0',
  '@effect/opentelemetry': '0.60.0',

  // React ecosystem
  react: '19.2.3',
  'react-dom': '19.2.3',
  'react-aria-components': '1.14.0',

  // Type definitions
  '@types/react': '19.2.7',
  '@types/react-dom': '19.2.3',
  '@types/node': '25.0.3',
  '@types/eslint': '9.6.1',
  '@types/is-dom': '1.1.2',

  // Build tools
  typescript: '5.9.3',
  '@playwright/test': '1.57.0',
  vite: '7.3.0',
  vitest: '4.0.16',
  '@vitejs/plugin-react': '5.1.2',

  // TanStack
  '@tanstack/react-router': '1.145.7',
  '@tanstack/react-start': '1.145.10',
  '@tanstack/router-plugin': '1.145.10',

  // Styling
  tailwindcss: '4.1.18',
  '@tailwindcss/vite': '4.1.18',

  // Storybook
  storybook: '10.1.11',
  '@storybook/react': '10.1.11',
  '@storybook/react-vite': '10.1.11',

  // Testing
  '@testing-library/react': '16.3.1',
  '@testing-library/user-event': '14.6.1',
  'happy-dom': '18.0.1',

  // Linting
  eslint: '9.28.0',
  'typescript-eslint': '8.34.0',

  // Crypto
  '@noble/hashes': '1.7.1',

  // DOM utilities
  'is-dom': '1.1.0',

  // OpenTUI / Effect Atom (experimental)
  '@effect-atom/atom': '0.4.11',
  '@effect-atom/atom-react': '0.4.4',
  '@opentui/core': '0.1.68',
  '@opentui/react': '0.1.68',
} as const

/** Use catalog reference for dependencies */
export const catalogRef = 'catalog:' as const

/**
 * Package name patterns for dependency resolution.
 * Used by packageJsonWithContext to determine workspace: protocol.
 */
export const workspacePackagePatterns = ['@overeng/*'] as const

/**
 * Type-safe package.json builder. Dependencies are validated against the catalog
 * and workspace patterns at compile time.
 *
 * @example
 * ```ts
 * import { pkg } from '../../../genie/repo.ts'
 *
 * export default pkg({
 *   name: '@overeng/utils',
 *   dependencies: ['effect', '@overeng/other'], // typos caught at compile time
 *   peerDependencies: { react: '^' },
 * })
 * ```
 */
export const pkg = createPackageJson({
  catalog,
  workspacePackages: workspacePackagePatterns,
})

/** Root package.json configuration for composition */
export const rootPackageJson = {
  devDependencies: {
    '@effect/cli': catalogRef,
    '@effect/language-service': catalogRef,
    '@effect/platform': catalogRef,
    '@effect/platform-node': catalogRef,
    '@effect/rpc': catalogRef,
    '@overeng/utils': 'workspace:*',
    effect: catalogRef,
    oxfmt: '0.21.0',
    oxlint: '1.36.0',
    typescript: catalogRef,
    vitest: catalogRef,
  },
  pnpm: {
    patchedDependencies: {
      'effect-distributed-lock@0.0.11': 'patches/effect-distributed-lock@0.0.11.patch',
    },
  },
} as const

/** Workspace reference paths for tsconfig.all.json */
export const workspaceReferences = [
  './scripts',
  './context/effect/socket',
  './context/opentui',
  './packages/@overeng/genie',
  './packages/@overeng/notion-effect-schema',
  './packages/@overeng/notion-cli',
  './packages/@overeng/notion-effect-client',
  './packages/@overeng/effect-ai-claude-cli',
  './packages/@overeng/effect-schema-form',
  './packages/@overeng/effect-schema-form-aria',
  './packages/@overeng/effect-react',
  './packages/@overeng/react-inspector',
  './packages/@overeng/utils',
  './packages/@overeng/oxc-config',
  './packages/@overeng/pnpm-compose',
  './packages/@overeng/effect-path',
  './packages/@overeng/effect-rpc-tanstack',
] as const

/**
 * Computes the relative path to tsconfig.base.json from a package directory
 * @example getRelativeBasePath('./packages/@overeng/utils') // '../../../tsconfig.base.json'
 */
export const getRelativeBasePath = (packagePath: string): string => {
  const depth = packagePath.split('/').filter(Boolean).length
  return '../'.repeat(depth) + 'tsconfig.base.json'
}

/** Standard package tsconfig compiler options (composite mode with src/dist structure) */
export const packageTsconfigCompilerOptions = {
  composite: true,
  rootDir: '.',
  outDir: './dist',
  tsBuildInfoFile: './tsconfig.tsbuildinfo',
} as const

/** DOM library set for browser-compatible packages */
export const domLib = ['ES2022', 'DOM', 'DOM.Iterable'] as const

/** React JSX configuration for React packages */
export const reactJsx = { jsx: 'react-jsx' as const }

/** Base tsconfig compiler options shared across all packages */
export const baseTsconfigCompilerOptions = {
  target: 'ES2023' as const,
  lib: ['ES2023'],
  module: 'ESNext' as const,
  moduleResolution: 'Bundler' as const,
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  allowSyntheticDefaultImports: true,
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
      name: '@effect/language-service',
      reportSuggestionsAsWarningsInTsc: true,
      pipeableMinArgCount: 2,
      diagnosticSeverity: {
        missedPipeableOpportunity: 'suggestion',
        schemaUnionOfLiterals: 'warning',
        anyUnknownInErrorContext: 'warning',
      },
    },
  ],
}
