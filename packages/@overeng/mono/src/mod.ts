/**
 * @overeng/mono - Framework for building Effect-based monorepo CLIs
 *
 * Provides reusable task primitives and command factories for common monorepo operations:
 * - Build, test, lint, type-check, clean
 * - CI-aware output (GitHub Actions groups)
 * - Interactive mode with TaskRunner for live progress
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
 *   checkCommand,
 *   createStandardCheckConfig,
 * } from '@overeng/mono'
 *
 * const oxcConfig = { configPath: 'packages/@overeng/oxc-config' }
 * const genieConfig = {
 *   scanDirs: ['packages', 'scripts'],
 *   skipDirs: ['node_modules', 'dist', '.git'],
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
 *     checkCommand(createStandardCheckConfig({ oxcConfig, genieConfig })),
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
  // Composite
  allLintChecks,
  allLintFixes,
} from './tasks.ts'

export type { GenieCoverageConfig, OxcConfig, TestConfig, TypeCheckConfig } from './tasks.ts'

// =============================================================================
// Commands
// =============================================================================

export {
  // Standard commands
  buildCommand,
  checkCommand,
  cleanCommand,
  lintCommand,
  testCommand,
  tsCommand,
  // Check command variants
  checkCommandCI,
  checkCommandInteractive,
  // Check config factory
  createStandardCheckConfig,
} from './commands.ts'

export type { CheckCommandConfig, CheckTask } from './commands.ts'
