import type { Error as PlatformError, FileSystem, Path } from 'effect'
import type { Option } from 'effect'
import type { ChildProcessSpawner } from 'effect/unstable/process'

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
  | ChildProcessSpawner.ChildProcessSpawner
  | CurrentWorkingDirectory

/** Possible errors from genie command execution */
export type GenieCommandError =
  | GenieCheckError
  | GenieGenerationFailedError
  | GenieImportError
  | PlatformError.PlatformError
