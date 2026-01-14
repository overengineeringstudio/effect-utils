import type { Error as PlatformError, FileSystem, Path } from '@effect/platform'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { Option } from 'effect'

import type { CurrentWorkingDirectory } from '@overeng/utils/node'

import type { GenieCheckError, GenieGenerationFailedError, GenieImportError } from './errors.ts'

/** Context passed to genie generator functions */
export type GenieContext = {
  /** Repo-relative path to the directory containing this genie file (e.g., 'packages/@overeng/utils') */
  location: string
  /** Absolute path to the working directory (repo root) */
  cwd: string
}

export type GenieCommandConfig = {
  cwd: string
  watch: boolean
  writeable: boolean
  check: boolean
  dryRun: boolean
  oxfmtConfig: Option.Option<string>
}

export type GenieCommandEnv =
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor
  | CurrentWorkingDirectory

export type GenieCommandError =
  | GenieCheckError
  | GenieGenerationFailedError
  | GenieImportError
  | PlatformError.PlatformError

/** Successful generation of a single file */
export type GenerateSuccess =
  | { _tag: 'created'; targetFilePath: string }
  | { _tag: 'updated'; targetFilePath: string }
  | { _tag: 'unchanged'; targetFilePath: string }
  | { _tag: 'skipped'; targetFilePath: string; reason: string }

/** Warning info for tsconfig references that don't match workspace dependencies */
export type TsconfigReferencesWarning = {
  tsconfigPath: string
  missingReferences: string[]
  extraReferences: string[]
}

/** Result of attempting to stat a file - handles broken symlinks gracefully */
export type StatResult = { type: 'directory' } | { type: 'file' } | { type: 'skip'; reason: string }
