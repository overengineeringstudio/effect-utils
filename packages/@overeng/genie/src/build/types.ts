import type { FileSystem, Option, Path } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import type * as CommandExecutor from 'effect/unstable/process/ChildProcessSpawner'

import type { OutputModeValue } from '@overeng/tui-react/node'
import type { CurrentWorkingDirectory } from '@overeng/utils/node'

import type {
  GenieCheckError,
  GenieGenerationFailedError,
  GenieImportError,
} from '../core/errors.ts'

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
  | CommandExecutor.ChildProcessSpawner
  | CurrentWorkingDirectory

/** Possible errors from genie command execution */
export type GenieCommandError =
  | GenieCheckError
  | GenieGenerationFailedError
  | GenieImportError
  | PlatformError
