export { resolveCliVersion } from './cli-version.ts'

// Config types and schemas
export {
  CONFIG_FILE_NAME,
  type DepConfig,
  DepConfigSchema,
  GENERATED_CONFIG_FILE_NAME,
  GENERATED_CONFIG_WARNING,
  generateJsonSchema,
  JSON_SCHEMA_URL,
  type MemberConfig,
  MemberConfigSchema,
  type PackageExpose,
  PackageExposeSchema,
  type PackageIndexEntry,
  PackageIndexEntrySchema,
  type RepoConfig,
  RepoConfigSchema,
  type RootConfig,
  RootConfigSchema,
} from './config.ts'

// Config Writer
export {
  ConfigWriteError,
  createEmptyMemberConfig,
  removeRepo,
  updateRepoRev,
  upsertRepo,
  writeGeneratedConfig,
  writeMemberConfig,
  writeRootConfig,
} from './config-writer.ts'

// Execution
export {
  type ExecutionMode,
  ExecutionModeSchema,
  type ExecutionOptions,
  executeForAll,
  executeParallel,
  executeSequential,
  executeTopoForAll,
  type TopoExecutionOptions,
} from './execution.ts'

// Git and shell
export * as Git from './git.ts'
export { GitError, runShellCommand, ShellError } from './git.ts'

// Graph
export * as Graph from './graph.ts'
export { CycleError } from './graph.ts'

// Loader
export {
  checkConfigSync,
  collectMemberConfigs,
  ConfigError,
  ConfigOutOfSyncError,
  findWorkspaceRoot,
  loadMemberConfig,
  loadMemberConfigFile,
  type MemberConfigSource,
  type MergedConfig,
  mergeMemberConfigs,
  loadRootConfig,
  loadRootConfigFile,
  loadRootConfigWithSyncCheck,
  type RootConfigSource,
} from './loader.ts'

export { CurrentWorkingDirectory } from './workspace.ts'
