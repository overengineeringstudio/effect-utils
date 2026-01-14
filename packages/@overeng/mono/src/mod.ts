/**
 * @overeng/mono - Framework for building Effect-based monorepo CLIs
 *
 * Provides reusable task primitives and command factories for common monorepo operations:
 * - Build, test, lint, type-check, clean
 * - CI-aware output (GitHub Actions groups)
 * - Interactive mode with live progress rendering
 *
 * @example
 * ```ts
 * #!/usr/bin/env bun
 * import {
 *   runMonoCli,
 *   buildCommand,
 *   testCommand,
 *   lintCommand,
 *   tsCommand,
 *   cleanCommand,
 *   installCommand,
 *   checkCommandWithTaskSystem,
 * } from '@overeng/mono'
 *
 * const oxcConfig = { configPath: 'packages/@overeng/oxc-config' }
 * const genieConfig = {
 *   scanDirs: ['packages', 'scripts'],
 *   skipDirs: ['node_modules', 'dist', '.git'],
 * }
 * const installConfig = {
 *   scanDirs: ['packages', 'scripts'],
 * }
 *
 * runMonoCli({
 *   name: 'mono',
 *   version: '0.1.0',
 *   description: 'Monorepo management CLI',
 *   commands: [
 *     buildCommand(),
 *     testCommand(),
 *     lintCommand({ oxcConfig, genieConfig }),
 *     tsCommand(),
 *     cleanCommand(),
 *     installCommand(installConfig),
 *     checkCommandWithTaskSystem({ oxcConfig, genieConfig }),
 *   ],
 * })
 * ```
 *
 * @module
 */

// =============================================================================
// Errors
// =============================================================================

export { CommandError, GenieCoverageError } from './errors.ts'

// =============================================================================
// Utilities
// =============================================================================

export { ciGroup, ciGroupEnd, IS_CI, runCommand, startProcess } from './utils.ts'

// =============================================================================
// CLI Runner
// =============================================================================

export { runMonoCli } from './cli.ts'
export type { MonoCliConfig, MonoCommand, StandardMonoContext } from './cli.ts'

// =============================================================================
// Task Primitives
// =============================================================================

export {
  // Format
  formatCheck,
  formatFix,
  // Lint
  lintCheck,
  lintFix,
  // Genie
  checkGenieCoverage,
  genieCheck,
  // TypeScript
  typeCheck,
  typeCheckClean,
  typeCheckWatch,
  // Test
  testRun,
  testWatch,
  // Build
  build,
  // Install
  cleanNodeModules,
  findPackageDirs,
  installAll,
  installPackage,
  installPackageCaptured,
  // Composite
  allLintChecks,
  allLintFixes,
} from './tasks.ts'

export type {
  GenieCoverageConfig,
  InstallConfig,
  InstallProgress,
  InstallResult,
  OxcConfig,
  TestConfig,
  TypeCheckConfig,
} from './tasks.ts'

// =============================================================================
// Commands
// =============================================================================

export {
  // Standard commands
  buildCommand,
  checkCommandWithTaskSystem,
  cleanCommand,
  installCommand,
  lintCommand,
  nixCommand,
  testCommand,
  tsCommand,
} from './commands.ts'
