/**
 * Configuration types for mono CLI tasks.
 */

/** Configuration for oxc-based lint tasks */
export interface OxcConfig {
  /** Additional oxlint args (e.g. --report-unused-disable-directives) */
  extraLintArgs?: string[]
}

/** Configuration for genie coverage checking */
export interface GenieCoverageConfig {
  /** Directories to scan for config files (e.g. ['apps', 'packages', 'scripts']) */
  scanDirs: string[]
  /** Directories to skip when scanning (e.g. ['node_modules', 'dist', '.git']) */
  skipDirs: string[]
  /** Config file patterns to check (defaults to ['package.json', 'tsconfig.json']) */
  patterns?: string[]
}

/** Configuration for TypeScript checking */
export interface TypeCheckConfig {
  /** Path to tsconfig for project references build (e.g. 'tsconfig.all.json') */
  tsconfigPath?: string
}

/** Configuration for test running */
export interface TestConfig {
  /** Test runner command (defaults to 'vitest') */
  command?: string
  /** Additional args for the test runner */
  args?: string[]
}

/** Configuration for install task */
export interface InstallConfig {
  /** Directories to scan for package.json files (e.g. ['packages', 'scripts', 'apps']) */
  scanDirs: string[]
  /** Directories to skip when scanning (e.g. ['node_modules', '.git']) */
  skipDirs?: string[]
}

/** Configuration for check task system */
export interface CheckTasksConfig {
  oxcConfig?: OxcConfig
  genieConfig: GenieCoverageConfig
  /** Skip genie check */
  skipGenie?: boolean
  /** Skip tests */
  skipTests?: boolean
}

/** Result of installing a package */
export type InstallResult =
  | { _tag: 'success'; dir: string }
  | {
      _tag: 'failure'
      dir: string
      error: unknown
      stderr?: string
      stdout?: string
    }

/** Install result with progress tracking */
export type InstallProgress = {
  total: number
  completed: number
  running: number
  results: InstallResult[]
}
