/**
 * Generate Commands
 *
 * Commands for generating configuration files.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../../../lib/config.ts'
import { generateAll } from '../../../lib/generators/mod.ts'
import { generateSchema } from '../../../lib/generators/schema.ts'
import { generateVscode } from '../../../lib/generators/vscode.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../../context.ts'
import { GenerateError } from '../../errors.ts'
import { GenerateApp, GenerateView } from '../../renderers/GenerateOutput/mod.ts'

/** Generate VSCode workspace file */
const generateVscodeCommand = Cli.Command.make(
  'vscode',
  {
    output: outputOption,
    exclude: Cli.Options.text('exclude').pipe(
      Cli.Options.withDescription('Comma-separated list of members to exclude'),
      Cli.Options.optional,
    ),
  },
  ({ output, exclude }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      yield* run(
        GenerateApp,
        (tui) =>
          Effect.gen(function* () {
            if (Option.isNone(root) === true) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_found',
                message: 'Not in a megarepo',
              })
              return yield* new GenerateError({ message: 'Not in a megarepo' })
            }

            tui.dispatch({ _tag: 'Start', generator: 'vscode' })

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

            const excludeList = Option.map(exclude, (e) => e.split(',').map((s) => s.trim()))

            yield* generateVscode({
              megarepoRoot: root.value,
              config,
              ...(Option.isSome(excludeList) === true ? { exclude: excludeList.value } : {}),
            })

            tui.dispatch({
              _tag: 'SetSuccess',
              results: [{ generator: 'vscode', status: '.vscode/megarepo.code-workspace' }],
            })
          }),
        { view: React.createElement(GenerateView, { stateAtom: GenerateApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/generate/vscode')),
).pipe(Cli.Command.withDescription('Generate VS Code workspace file'))

/** Generate JSON Schema */
const generateSchemaCommand = Cli.Command.make(
  'schema',
  {
    output: outputOption,
    outputPath: Cli.Options.text('output-path').pipe(
      Cli.Options.withAlias('p'),
      Cli.Options.withDescription('Output path (relative to megarepo root)'),
      Cli.Options.withDefault('schema/megarepo.schema.json'),
    ),
  },
  ({ output, outputPath }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      yield* run(
        GenerateApp,
        (tui) =>
          Effect.gen(function* () {
            if (Option.isNone(root) === true) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_found',
                message: 'Not in a megarepo',
              })
              return yield* new GenerateError({ message: 'Not in a megarepo' })
            }

            tui.dispatch({ _tag: 'Start', generator: 'schema' })

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

            yield* generateSchema({
              megarepoRoot: root.value,
              config,
              outputPath,
            })

            tui.dispatch({
              _tag: 'SetSuccess',
              results: [{ generator: 'schema', status: outputPath }],
            })
          }),
        { view: React.createElement(GenerateView, { stateAtom: GenerateApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/generate/schema')),
).pipe(Cli.Command.withDescription('Generate JSON schema for megarepo.json'))

/** Generate all configured outputs */
const generateAllCommand = Cli.Command.make('all', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    yield* run(
      GenerateApp,
      (tui) =>
        Effect.gen(function* () {
          if (Option.isNone(root) === true) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_found',
              message: 'Not in a megarepo',
            })
            return yield* new GenerateError({ message: 'Not in a megarepo' })
          }

          tui.dispatch({ _tag: 'Start', generator: 'all' })

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

          const outputs = yield* generateAll({
            megarepoRoot: root.value,
            outermostRoot: root.value,
            config,
          })

          const results = outputs.flatMap((genOutput) => {
            switch (genOutput._tag) {
              case 'vscode':
                return [{ generator: 'vscode', status: '.vscode/megarepo.code-workspace' }]
              default:
                return []
            }
          })

          tui.dispatch({ _tag: 'SetSuccess', results })
        }),
      { view: React.createElement(GenerateView, { stateAtom: GenerateApp.stateAtom }) },
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.withSpan('megarepo/generate/all')),
).pipe(Cli.Command.withDescription('Generate all configured outputs'))

/** Generate subcommand group */
export const generateCommand = Cli.Command.make('generate', {}).pipe(
  Cli.Command.withSubcommands([generateAllCommand, generateSchemaCommand, generateVscodeCommand]),
  Cli.Command.withDescription('Generate configuration files'),
)
