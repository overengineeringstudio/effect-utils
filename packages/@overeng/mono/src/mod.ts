/**
 * @overeng/mono - Framework for building Effect-based monorepo CLIs
 *
 * Provides reusable task primitives and command factories for common monorepo operations:
 * - Build, test, lint, type-check, clean
 * - CI-aware output (GitHub Actions groups)
 * - Interactive mode with live progress rendering
 *
 * Expects `oxlint.json` and `oxfmt.json` config files at repo root (auto-discovered by oxlint/oxfmt).
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
 *     lintCommand(genieConfig),
 *     tsCommand(),
 *     cleanCommand(),
 *     installCommand(installConfig),
 *     checkCommandWithTaskSystem({ genieConfig }),
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
export type { MonoCliConfig, StandardMonoContext } from './cli.ts'

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
  findPackageDirs,
  installAll,
  installPackage,
  installPackageCaptured,
  // Composite
  allLintChecks,
  allLintFixes,
} from './tasks/mod.ts'

export type {
  GenieCoverageConfig,
  InstallConfig,
  InstallProgress,
  InstallResult,
  TestConfig,
  TypeCheckConfig,
} from './tasks/mod.ts'

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
  testCommand,
  tsCommand,
} from './commands.ts'
