/**
 * dotdot exec command
 *
 * Run a command in all repos
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { kv, styled, symbols } from '@overeng/cli-ui'
import { Effect, Layer, Option, Schema } from 'effect'

import {
  type BaseResult,
  buildSummary,
  CurrentWorkingDirectory,
  type ExecutionMode,
  executeForAll,
  existsAsGitRepo,
  type RepoInfo,
  runShellCommand,
  WorkspaceService,
} from '../lib/mod.ts'

/** Error during exec operation */
export class ExecError extends Schema.TaggedError<ExecError>()('ExecError', {
  repo: Schema.String,
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Result of executing command in a repo */
type ExecResult = BaseResult<'success' | 'skipped' | 'failed'> & {
  output?: string
}

const ExecStatusLabels = {
  success: 'success',
  skipped: 'skipped',
  failed: 'failed',
} as const

/** Execute command in a single repo */
const execInRepo = ({ repo, command }: { repo: RepoInfo; command: string }) =>
  Effect.gen(function* () {
    const { name, path: repoPath } = repo

    yield* Effect.log(`${styled.dim('running')} ${styled.bold(name)}`)

    const result = yield* runShellCommand({ command, cwd: repoPath }).pipe(
      Effect.map((output) => ({ name, status: 'success' as const, output })),
      Effect.catchAll((error) =>
        Effect.succeed({
          name,
          status: 'failed' as const,
          message: error instanceof Error ? error.message : String(error),
        } satisfies ExecResult),
      ),
    )

    if (result.status === 'success') {
      if (result.output) {
        yield* Effect.log(result.output)
      }
      yield* Effect.log(`  ${styled.green(symbols.check)} ${styled.dim('done')}`)
    } else {
      yield* Effect.log(`  ${styled.red(symbols.cross)} ${styled.dim(result.message ?? 'failed')}`)
    }

    return result
  })

/** Exec command handler - separated for testability */
export const execHandler = ({
  command,
  mode,
  maxParallel,
}: {
  command: string
  mode: ExecutionMode
  maxParallel: Option.Option<number>
}) =>
  Effect.gen(function* () {
    const workspace = yield* WorkspaceService

    yield* Effect.log(kv('workspace', path.basename(workspace.root)))
    yield* Effect.log(kv('command', styled.cyan(command)))
    yield* Effect.log(styled.dim(`${mode} mode`))
    yield* Effect.log('')

    // Get all repos and filter to existing git repos
    const allRepos = yield* workspace.scanRepos()
    const repos = allRepos.filter(existsAsGitRepo)

    if (repos.length === 0) {
      yield* Effect.log(styled.dim('no repos declared in config'))
      return
    }

    const results = yield* executeForAll({
      items: repos,
      fn: (repo) => execInRepo({ repo, command }),
      options: { mode, maxParallel: Option.getOrUndefined(maxParallel) },
    })

    yield* Effect.log('')

    const summary = buildSummary({ results, statusLabels: ExecStatusLabels })
    yield* Effect.log(styled.dim(`done: ${summary}`))
  }).pipe(Effect.withSpan('dotdot/exec'))

/** Exec command implementation.
 * Provides its own WorkspaceService.live layer - validates config is in sync before running. */
export const execCommand = Cli.Command.make(
  'exec',
  {
    command: Cli.Args.text({ name: 'command' }).pipe(
      Cli.Args.withDescription('Command to run in each repo'),
    ),
    mode: Cli.Options.choice('mode', ['parallel', 'sequential'] as const).pipe(
      Cli.Options.withDescription('Execution mode: parallel or sequential'),
      Cli.Options.withDefault('sequential' as ExecutionMode),
    ),
    maxParallel: Cli.Options.integer('max-parallel').pipe(
      Cli.Options.withDescription('Maximum parallel operations (only for parallel mode)'),
      Cli.Options.optional,
    ),
  },
  (args) =>
    execHandler(args).pipe(
      Effect.provide(WorkspaceService.live.pipe(Layer.provide(CurrentWorkingDirectory.live))),
      Effect.catchTag('ConfigOutOfSyncError', (e) =>
        Effect.logError(`${styled.red(symbols.cross)} ${styled.dim(e.message)}`),
      ),
    ),
)
