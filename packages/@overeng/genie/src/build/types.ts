import type { Error as PlatformError, FileSystem, Path } from '@effect/platform'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { Option } from 'effect'

import type { OutputModeValue } from '@overeng/tui-react'
import type { CurrentWorkingDirectory } from '@overeng/utils/node'

import type { GenieCheckError, GenieGenerationFailedError, GenieImportError } from './errors.ts'

// Re-export GenieContext from runtime (single source of truth)
export type { GenieContext } from '../runtime/mod.ts'

/** Configuration options for genie commands */
export type GenieCommandConfig = {
  cwd: string
  watch: boolean
  writeable: boolean
  check: boolean
  dryRun: boolean
  oxfmtConfig: Option.Option<string>
  output: OutputModeValue
}

/** Effect dependencies required by genie commands */
export type GenieCommandEnv =
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor
  | CurrentWorkingDirectory

/** Possible errors from genie command execution */
export type GenieCommandError =
  | GenieCheckError
  | GenieGenerationFailedError
  | GenieImportError
  | PlatformError.PlatformError

/** Successful generation of a single file */
export type GenerateSuccess =
  | { _tag: 'created'; targetFilePath: string }
  | { _tag: 'updated'; targetFilePath: string; diffSummary?: string }
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
