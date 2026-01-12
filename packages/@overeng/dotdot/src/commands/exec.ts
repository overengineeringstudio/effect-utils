/**
 * dotdot exec command
 *
 * Run a command in all repos
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import {
  CurrentWorkingDirectory,
  collectAllConfigs,
  type ExecutionMode,
  executeForAll,
  findWorkspaceRoot,
  type RepoConfig,
  runShellCommand,
} from '../lib/mod.ts'

/** Error during exec operation */
export class ExecError extends Schema.TaggedError<ExecError>()('ExecError', {
  repo: Schema.String,
  command: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Result of executing command in a repo */
type ExecResult = {
  name: string
  status: 'success' | 'failed' | 'skipped'
  message?: string
}

/** Collect all declared repos from configs */
const collectDeclaredRepos = (
  configs: Array<{
    config: { repos: Record<string, RepoConfig> }
    isRoot: boolean
    dir: string
  }>,
) => {
  const repos = new Map<string, RepoConfig>()

  for (const source of configs) {
    for (const [name, config] of Object.entries(source.config.repos)) {
      // First declaration wins (root config takes precedence)
      if (!repos.has(name)) {
        repos.set(name, config)
      }
    }
  }

  return repos
}

/** Exec command implementation */
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
  ({ command, mode, maxParallel }) =>
    Effect.gen(function* () {
      const cwd = yield* CurrentWorkingDirectory
      const fs = yield* FileSystem.FileSystem

      const workspaceRoot = yield* findWorkspaceRoot(cwd)

      yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
      yield* Effect.log(`Running: ${command}`)
      yield* Effect.log(`Execution mode: ${mode}`)
      yield* Effect.log('')

      const configs = yield* collectAllConfigs(workspaceRoot)
      const declaredRepos = collectDeclaredRepos(configs)

      if (declaredRepos.size === 0) {
        yield* Effect.log('No repos declared in config')
        return
      }

      const repoNames = Array.from(declaredRepos.keys())

      const results = yield* executeForAll(
        repoNames,
        (name) =>
          Effect.gen(function* () {
            const repoPath = path.join(workspaceRoot, name)

            // Check if repo exists
            const exists = yield* fs.exists(repoPath)
            if (!exists) {
              yield* Effect.log(`[${name}] Skipped (directory does not exist)`)
              return {
                name,
                status: 'skipped' as const,
                message: 'Directory does not exist',
              }
            }

            yield* Effect.log(`[${name}] Running...`)

            const result = yield* runShellCommand(command, repoPath).pipe(
              Effect.map(() => ({ name, status: 'success' as const })),
              Effect.catchAll((error) =>
                Effect.succeed({
                  name,
                  status: 'failed' as const,
                  message: error instanceof Error ? error.message : String(error),
                }),
              ),
            )

            if (result.status === 'success') {
              yield* Effect.log(`[${name}] Done`)
            } else {
              yield* Effect.log(`[${name}] Failed: ${result.message}`)
            }

            return result
          }),
        { mode, maxParallel: Option.getOrUndefined(maxParallel) },
      )

      yield* Effect.log('')

      const success = results.filter((r) => r.status === 'success').length
      const failed = results.filter((r) => r.status === 'failed').length
      const skipped = results.filter((r) => r.status === 'skipped').length

      const summary: string[] = []
      if (success > 0) summary.push(`${success} success`)
      if (failed > 0) summary.push(`${failed} failed`)
      if (skipped > 0) summary.push(`${skipped} skipped`)

      yield* Effect.log(`Done: ${summary.join(', ')}`)
    }).pipe(Effect.withSpan('dotdot/exec')),
)
