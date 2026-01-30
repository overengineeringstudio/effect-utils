/**
 * Exec Command
 *
 * Execute a command in member directories.
 */

import * as Cli from '@effect/cli'
import { Command, FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { renderToString, Text } from '@overeng/tui-react'

import { CONFIG_FILE_NAME, getMemberPath, MegarepoConfig } from '../../lib/config.ts'
import { Cwd, findMegarepoRoot, jsonOption, verboseOption } from '../context.ts'
import {
  ExecErrorOutput,
  ExecVerboseHeader,
  ExecMemberSkipped,
  ExecMemberPath,
  ExecMemberHeader,
  ExecStderr,
} from '../renderers/ExecOutput.tsx'

/** Execution mode for running commands across members */
type ExecMode = 'parallel' | 'sequential'

/** Execute command across members */
export const execCommand = Cli.Command.make(
  'exec',
  {
    command: Cli.Args.text({ name: 'command' }).pipe(
      Cli.Args.withDescription('Command to execute'),
    ),
    json: jsonOption,
    member: Cli.Options.text('member').pipe(
      Cli.Options.withAlias('m'),
      Cli.Options.withDescription('Run only in this member'),
      Cli.Options.optional,
    ),
    mode: Cli.Options.choice('mode', ['parallel', 'sequential'] as const).pipe(
      Cli.Options.withDescription('Execution mode: parallel (default) or sequential'),
      Cli.Options.withDefault('parallel' as ExecMode),
    ),
    verbose: verboseOption,
  },
  ({ command: cmd, json, member, mode, verbose }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'not_found',
              message: 'No megarepo.json found',
            }),
          )
        } else {
          const output = yield* Effect.promise(() =>
            renderToString({ element: React.createElement(ExecErrorOutput, { type: 'not_in_megarepo' }) }),
          )
          yield* Console.error(output)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Load config
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      // Filter members
      const membersToRun = Option.match(member, {
        onNone: () => Object.keys(config.members),
        onSome: (m) => (m in config.members ? [m] : []),
      })

      if (membersToRun.length === 0) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'Member not found' }))
        } else {
          const output = yield* Effect.promise(() =>
            renderToString({ element: React.createElement(ExecErrorOutput, { type: 'member_not_found' }) }),
          )
          yield* Console.error(output)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      // Verbose: show execution details
      if (verbose && !json) {
        const verboseOutput = yield* Effect.promise(() =>
          renderToString({
            element: React.createElement(ExecVerboseHeader, {
              command: cmd,
              mode,
              members: membersToRun,
            }),
          }),
        )
        yield* Console.log(verboseOutput)
      }

      /** Run command in a single member */
      const runInMember = (name: string) =>
        Effect.gen(function* () {
          const memberPath = getMemberPath({ megarepoRoot: root.value, name })
          const exists = yield* fs.exists(memberPath)

          if (!exists) {
            if (verbose && !json) {
              const skippedOutput = yield* Effect.promise(() =>
                renderToString({ element: React.createElement(ExecMemberSkipped, { name }) }),
              )
              yield* Console.log(skippedOutput)
            }
            return {
              name,
              exitCode: -1,
              stdout: '',
              stderr: 'Member not synced',
            }
          }

          if (verbose && !json) {
            const pathOutput = yield* Effect.promise(() =>
              renderToString({ element: React.createElement(ExecMemberPath, { name, path: memberPath }) }),
            )
            yield* Console.log(pathOutput)
          }

          // Run the command
          return yield* Effect.gen(function* () {
            const shellCmd = Command.make('sh', '-c', cmd).pipe(
              Command.workingDirectory(memberPath),
            )
            const output = yield* Command.string(shellCmd)
            return { name, exitCode: 0, stdout: output, stderr: '' }
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed({
                name,
                exitCode: 1,
                stdout: '',
                stderr: error instanceof Error ? error.message : String(error),
              }),
            ),
          )
        })

      let results: Array<{
        name: string
        exitCode: number
        stdout: string
        stderr: string
      }>

      if (mode === 'parallel') {
        // Run all commands in parallel
        results = yield* Effect.all(
          membersToRun.map((name) => runInMember(name)),
          { concurrency: 'unbounded' },
        )
      } else {
        // Run commands sequentially
        results = []
        for (const name of membersToRun) {
          const result = yield* runInMember(name)
          results.push(result)

          // Print output immediately in sequential mode (unless JSON)
          if (!json) {
            const nameOutput = yield* Effect.promise(() =>
              renderToString({ element: React.createElement(ExecMemberHeader, { name }) }),
            )
            yield* Console.log(nameOutput)
            if (result.stdout) {
              console.log(result.stdout)
            }
            if (result.stderr) {
              const stderrOutput = yield* Effect.promise(() =>
                renderToString({ element: React.createElement(ExecStderr, { stderr: result.stderr }) }),
              )
              console.error(stderrOutput)
            }
          }
        }
      }

      // Print results for parallel mode (all at once at the end)
      if (!json && mode === 'parallel') {
        for (const result of results) {
          const nameOutput = yield* Effect.promise(() =>
            renderToString({ element: React.createElement(ExecMemberHeader, { name: result.name }) }),
          )
          yield* Console.log(nameOutput)
          if (result.stdout) {
            console.log(result.stdout)
          }
          if (result.stderr) {
            const stderrOutput = yield* Effect.promise(() =>
              renderToString({ element: React.createElement(ExecStderr, { stderr: result.stderr }) }),
            )
            console.error(stderrOutput)
          }
        }
      }

      if (json) {
        console.log(JSON.stringify({ results }))
      }
    }).pipe(Effect.withSpan('megarepo/exec')),
).pipe(Cli.Command.withDescription('Execute a command in member directories'))
