/**
 * Mono CLI task definitions.
 *
 * Re-exports all task modules for convenient access.
 */

// Types
export type {
  CheckTasksConfig,
  GenieCoverageConfig,
  InstallConfig,
  InstallProgress,
  InstallResult,
  TestConfig,
  TypeCheckConfig,
} from './types.ts'

// Format tasks
export { formatCheck, formatFix } from './format.ts'

// Lint tasks
export { allLintChecks, allLintFixes, lintCheck, lintFix } from './lint.ts'

// Genie tasks
export { checkGenieCoverage, genieCheck } from './genie.ts'

// TypeScript tasks
export { build, resolveLocalTsc, typeCheck, typeCheckClean, typeCheckWatch } from './typescript.ts'

// Test tasks
export { testRun, testWatch } from './test.ts'

// Install tasks
export {
  cleanNodeModules,
  findPackageDirs,
  installAll,
  installAllWithTaskSystem,
  installPackage,
  installPackageCaptured,
} from './install.ts'

// Check orchestrator
export { checkAllWithTaskSystem } from './check.ts'
