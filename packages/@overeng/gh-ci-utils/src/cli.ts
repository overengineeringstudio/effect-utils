/**
 * gh-ci-utils CLI
 *
 * Real-time CI debugging — per-job status, log fetching, and structured annotations.
 */
import * as Cli from 'effect/unstable/cli'

import { authCommand } from './node/commands/auth.ts'
import { inspectCommand } from './node/commands/inspect.ts'
import { logsCommand } from './node/commands/logs.ts'
import { cancelCommand, rerunCommand, runCommand } from './node/commands/rerun.ts'
import { runnersCommand } from './node/commands/runners.ts'
import { statusCommand } from './node/commands/status.ts'
import { tracesCommand } from './node/commands/traces.ts'

/** Root CLI command for the gh-ci-utils tool */
export const ghCiUtilsCommand = Cli.Command.make('gh-ci-utils').pipe(
  Cli.Command.withSubcommands([
    statusCommand,
    tracesCommand,
    logsCommand,
    runCommand,
    rerunCommand,
    cancelCommand,
    authCommand,
    inspectCommand,
    runnersCommand,
  ]),
  Cli.Command.withDescription(
    'Real-time CI debugging — per-job status, log fetching, and structured annotations',
  ),
)
