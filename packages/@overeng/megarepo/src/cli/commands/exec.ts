/**
 * Exec Command
 *
 * Execute a command in member directories.
 */

import * as Cli from '@effect/cli'
import { Command, FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import { CONFIG_FILE_NAME, getMemberPath, MegarepoConfig } from '../../lib/config.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer, verboseOption } from '../context.ts'
import { ExecApp, ExecView } from '../renderers/ExecOutput/mod.ts'

/** Execution mode for running commands across members */
type ExecMode = 'parallel' | 'sequential'

/** Execute command across members */
export const execCommand = Cli.Command.make(
  'exec',
  {
    command: Cli.Args.text({ name: 'command' }).pipe(
      Cli.Args.withDescription('Command to execute'),
    ),
    output: outputOption,
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
  ({ command: cmd, output, member, mode, verbose }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      yield* run(
        ExecApp,
        (tui) =>
          Effect.gen(function* () {
            if (Option.isNone(root) === true) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_found',
                message: 'No megarepo.json found',
              })
              return
            }

            // Load config
            const fs = yield* FileSystem.FileSystem
            const configPath = EffectPath.ops.join(
              root.value,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
            )
            const configContent = yield* fs.readFileString(configPath)
            const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
              configContent,
            )

            // Filter members
            const membersToRun = Option.match(member, {
              onNone: () => Object.keys(config.members),
              onSome: (m) => (m in config.members ? [m] : []),
            })

            if (membersToRun.length === 0) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_found',
                message: 'Member not found',
              })
              return
            }

            // Start exec with members
            tui.dispatch({
              _tag: 'Start',
              command: cmd,
              mode,
              verbose,
              members: membersToRun,
            })

            /** Run command in a single member */
            const runInMember = (name: string) =>
              Effect.gen(function* () {
                const memberPath = getMemberPath({ megarepoRoot: root.value, name })
                const exists = yield* fs.exists(memberPath)

                if (exists === false) {
                  tui.dispatch({
                    _tag: 'UpdateMember',
                    name,
                    status: 'skipped',
                    stderr: 'Member not synced',
                  })
                  return
                }

                // Mark as running
                tui.dispatch({
                  _tag: 'UpdateMember',
                  name,
                  status: 'running',
                })

                // Run the command
                yield* Effect.gen(function* () {
                  const shellCmd = Command.make('sh', '-c', cmd).pipe(
                    Command.workingDirectory(memberPath),
                  )
                  const output = yield* Command.string(shellCmd)
                  tui.dispatch({
                    _tag: 'UpdateMember',
                    name,
                    status: 'success',
                    exitCode: 0,
                    stdout: output,
                  })
                }).pipe(
                  Effect.catchAll((error) =>
                    Effect.sync(() => {
                      tui.dispatch({
                        _tag: 'UpdateMember',
                        name,
                        status: 'error',
                        exitCode: 1,
                        stderr: error instanceof Error ? error.message : String(error),
                      })
                    }),
                  ),
                )
              })

            if (mode === 'parallel') {
              // Run all commands in parallel
              yield* Effect.all(
                membersToRun.map((name) => runInMember(name)),
                { concurrency: 'unbounded' },
              )
            } else {
              // Run commands sequentially
              for (const name of membersToRun) {
                yield* runInMember(name)
              }
            }

            // Mark exec as complete
            tui.dispatch({ _tag: 'Complete' })
          }),
        { view: React.createElement(ExecView, { stateAtom: ExecApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/exec')),
).pipe(Cli.Command.withDescription('Execute a command in member directories'))
