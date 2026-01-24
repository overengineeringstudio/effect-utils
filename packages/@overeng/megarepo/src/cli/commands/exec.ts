/**
 * Exec Command
 *
 * Execute a command in member directories.
 */

import * as Cli from '@effect/cli'
import { Command, FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'
import { EffectPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, getMemberPath, MegarepoConfig } from '../../lib/config.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'

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
  },
  ({ command: cmd, json, member }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
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
          yield* Console.error(`${styled.red(symbols.cross)} Member not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      const results: Array<{ name: string; exitCode: number; stdout: string; stderr: string }> = []

      for (const name of membersToRun) {
        const memberPath = getMemberPath({ megarepoRoot: root.value, name })
        const exists = yield* fs.exists(memberPath)

        if (!exists) {
          results.push({ name, exitCode: -1, stdout: '', stderr: 'Member not synced' })
          continue
        }

        if (!json) {
          yield* Console.log(styled.bold(`\n${name}:`))
        }

        // Run the command
        const result = yield* Effect.gen(function* () {
          const shellCmd = Command.make('sh', '-c', cmd).pipe(Command.workingDirectory(memberPath))
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

        results.push(result)

        if (!json) {
          if (result.stdout) {
            console.log(result.stdout)
          }
          if (result.stderr) {
            console.error(styled.red(result.stderr))
          }
        }
      }

      if (json) {
        console.log(JSON.stringify({ results }))
      }
    }).pipe(Effect.withSpan('megarepo/exec')),
).pipe(Cli.Command.withDescription('Execute a command in member directories'))
