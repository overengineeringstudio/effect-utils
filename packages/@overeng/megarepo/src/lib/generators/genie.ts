/**
 * Genie Generator
 *
 * Generates a genie configuration directory with reusable helpers for megarepo members.
 * Output: genie/ directory in the megarepo root containing:
 * - repo.ts: Catalog, tsconfig helpers, and common exports
 */

import { FileSystem } from '@effect/platform'
import { Effect } from 'effect'

import { type AbsoluteDirPath, EffectPath, type MegarepoConfig } from '../config.ts'

/** Options for the genie generator */
export interface GenieGeneratorOptions {
  /** Path to the megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** The megarepo config */
  readonly config: typeof MegarepoConfig.Type
  /** Package scope (e.g., "@myorg") */
  readonly scope?: string | undefined
}

/**
 * Generate repo.ts content - the main genie configuration file
 */
export const generateRepoTsContent = (options: GenieGeneratorOptions): string => {
  const scope = options.scope ?? options.config.generators?.genie?.scope ?? '@megarepo'

  return `/**
 * Genie Configuration - Megarepo-specific
 *
 * This file contains shared configuration for generating package.json and tsconfig.json
 * files across megarepo members using genie.
 *
 * Usage in member package.json.genie.ts:
 * \`\`\`ts
 * import { catalog, packageJson, privatePackageDefaults } from '../../genie/repo.ts'
 *
 * export default packageJson({
 *   name: '${scope}/my-package',
 *   ...privatePackageDefaults,
 *   dependencies: {
 *     ...catalog.pick('effect', '@effect/platform'),
 *   },
 * })
 * \`\`\`
 */

// Re-export genie runtime utilities
export { packageJson } from '@overeng/genie/runtime'
export { tsconfigJson } from '@overeng/genie/runtime'

// =============================================================================
// Package Defaults
// =============================================================================

/** Common fields for private packages */
export const privatePackageDefaults = {
  version: '0.1.0',
  private: true,
  type: 'module',
} as const

// =============================================================================
// Catalog
// =============================================================================

import { defineCatalog } from '@overeng/genie/runtime'

/**
 * Catalog versions - single source of truth for dependency versions
 *
 * Add your shared dependencies here. Members import via:
 * \`\`\`ts
 * dependencies: {
 *   ...catalog.pick('effect', '@effect/platform'),
 * }
 * \`\`\`
 */
export const catalog = defineCatalog({
  // Effect ecosystem
  effect: '3.19.14',
  '@effect/platform': '0.94.1',
  '@effect/platform-node': '0.104.0',
  '@effect/cli': '0.73.0',
  '@effect/vitest': '0.27.0',

  // Type definitions
  '@types/node': '25.0.3',
  '@types/bun': '1.3.5',

  // Build tools
  typescript: '5.9.3',
  vitest: '3.2.4',
})

// =============================================================================
// TSConfig Options
// =============================================================================

import type { TSConfigCompilerOptions } from '@overeng/genie/runtime'

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
} as const satisfies TSConfigCompilerOptions

/** Standard package tsconfig compiler options (composite mode with src/dist structure) */
export const packageTsconfigCompilerOptions = {
  composite: true,
  rootDir: '.',
  outDir: './dist',
  tsBuildInfoFile: './dist/tsconfig.tsbuildinfo',
} as const
`
}

/**
 * Generate sample package.json.genie.ts content
 */
export const generateSamplePackageJsonGenieContent = (options: GenieGeneratorOptions): string => {
  const scope = options.scope ?? options.config.generators?.genie?.scope ?? '@megarepo'

  return `import { catalog, packageJson, privatePackageDefaults } from '../../genie/repo.ts'

export default packageJson({
  name: '${scope}/example-package',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  dependencies: {
    ...catalog.pick('effect', '@effect/platform'),
  },
  devDependencies: {
    ...catalog.pick('@types/node', '@effect/vitest', 'vitest'),
  },
})
`
}

/**
 * Generate sample tsconfig.json.genie.ts content
 */
export const generateSampleTsconfigJsonGenieContent = (): string => {
  return `import { baseTsconfigCompilerOptions, packageTsconfigCompilerOptions } from '../../genie/repo.ts'
import { tsconfigJson } from '@overeng/genie/runtime'

export default tsconfigJson({
  compilerOptions: {
    ...baseTsconfigCompilerOptions,
    ...packageTsconfigCompilerOptions,
    types: ['node'],
  },
  include: ['src/**/*.ts'],
})
`
}

/**
 * Generate genie configuration files
 */
export const generateGenie = (options: GenieGeneratorOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Create genie directory
    const genieDir = EffectPath.ops.join(
      options.megarepoRoot,
      EffectPath.unsafe.relativeDir('genie/'),
    )
    yield* fs.makeDirectory(genieDir, { recursive: true })

    // Generate repo.ts
    const repoTsContent = generateRepoTsContent(options)
    const repoTsPath = EffectPath.ops.join(genieDir, EffectPath.unsafe.relativeFile('repo.ts'))
    yield* fs.writeFileString(repoTsPath, repoTsContent)

    // Create samples directory
    const samplesDir = EffectPath.ops.join(genieDir, EffectPath.unsafe.relativeDir('samples/'))
    yield* fs.makeDirectory(samplesDir, { recursive: true })

    // Generate sample files
    const samplePackageJsonGeniePath = EffectPath.ops.join(
      samplesDir,
      EffectPath.unsafe.relativeFile('package.json.genie.ts'),
    )
    yield* fs.writeFileString(
      samplePackageJsonGeniePath,
      generateSamplePackageJsonGenieContent(options),
    )

    const sampleTsconfigJsonGeniePath = EffectPath.ops.join(
      samplesDir,
      EffectPath.unsafe.relativeFile('tsconfig.json.genie.ts'),
    )
    yield* fs.writeFileString(sampleTsconfigJsonGeniePath, generateSampleTsconfigJsonGenieContent())

    return {
      paths: {
        repoTs: repoTsPath,
        samplePackageJsonGenie: samplePackageJsonGeniePath,
        sampleTsconfigJsonGenie: sampleTsconfigJsonGeniePath,
      },
    }
  })
