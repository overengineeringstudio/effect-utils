/**
 * Generate Commands
 *
 * Commands for generating configuration files.
 */

import * as Cli from '@effect/cli'
import type { CommandExecutor } from '@effect/platform'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option, type ParseResult, Schema } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, getMemberPath, MegarepoConfig } from '../../../lib/config.ts'
import { generateAll } from '../../../lib/generators/mod.ts'
import { generateNix, type NixGeneratorError } from '../../../lib/generators/nix/mod.ts'
import { generateSchema } from '../../../lib/generators/schema.ts'
import { generateVscode } from '../../../lib/generators/vscode.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../../context.ts'
import { GenerateError } from '../../errors.ts'
import {
  GenerateApp,
  GenerateView,
  type GenerateActionType,
} from '../../renderers/GenerateOutput/mod.ts'

/** Generate Nix workspace */
interface NixGenerateTree {
  readonly root: AbsoluteDirPath
  readonly result: {
    readonly workspaceRoot: AbsoluteDirPath
    readonly flakePath: AbsoluteFilePath
    readonly envrcPath: AbsoluteFilePath
  }
  readonly nested: readonly NixGenerateTree[]
}

const flattenNixGenerateTree = (
  tree: NixGenerateTree,
): Array<NixGenerateTree['result'] & { root: AbsoluteDirPath }> => [
  { root: tree.root, ...tree.result },
  ...tree.nested.flatMap(flattenNixGenerateTree),
]

type GenerateNixForRootParams = {
  outermostRoot: AbsoluteDirPath
  currentRoot: AbsoluteDirPath
  deep: boolean
  depth: number
  visited: Set<string>
  tui: { dispatch: (action: GenerateActionType) => void }
}

const generateNixForRoot: (
  params: GenerateNixForRootParams,
) => Effect.Effect<
  Option.Option<NixGenerateTree>,
  NixGeneratorError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> = Effect.fn('megarepo/generate/nix/root')((params: GenerateNixForRootParams) =>
  Effect.gen(function* () {
    const { outermostRoot, currentRoot, deep, depth, visited, tui } = params
    const rootKey = currentRoot.replace(/\/$/, '')
    if (visited.has(rootKey)) {
      return Option.none<NixGenerateTree>()
    }
    visited.add(rootKey)

    const fs = yield* FileSystem.FileSystem
    const configPath = EffectPath.ops.join(
      currentRoot,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    if (depth > 0) {
      tui.dispatch({
        _tag: 'SetProgress',
        generator: 'nix',
        progress: `Generating ${currentRoot}...`,
      })
    }

    const result = yield* generateNix({
      megarepoRootOutermost: outermostRoot,
      megarepoRootNearest: currentRoot,
      config,
    })

    const nested: NixGenerateTree[] = []
    if (deep) {
      const nestedRoots: AbsoluteDirPath[] = []
      for (const [name] of Object.entries(config.members)) {
        const memberPath = getMemberPath({ megarepoRoot: currentRoot, name })
        const nestedConfigPath = EffectPath.ops.join(
          memberPath,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const hasNestedConfig = yield* fs
          .exists(nestedConfigPath)
          .pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (hasNestedConfig) {
          nestedRoots.push(
            EffectPath.unsafe.absoluteDir(memberPath.endsWith('/') ? memberPath : `${memberPath}/`),
          )
        }
      }

      if (nestedRoots.length > 0) {
        tui.dispatch({
          _tag: 'SetProgress',
          generator: 'nix',
          progress: 'Generating nested megarepos...',
        })
      }

      for (const nestedRoot of nestedRoots) {
        const nestedResult = yield* generateNixForRoot({
          outermostRoot,
          currentRoot: nestedRoot,
          deep,
          depth: depth + 1,
          visited,
          tui,
        })
        if (Option.isSome(nestedResult)) {
          nested.push(nestedResult.value)
        }
      }
    }

    return Option.some({
      root: currentRoot,
      result,
      nested,
    })
  }),
)

const generateNixCommand = Cli.Command.make(
  'nix',
  {
    output: outputOption,
    deep: Cli.Options.boolean('deep').pipe(
      Cli.Options.withDescription('Recursively generate nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, deep }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* GenerateApp.run(
            React.createElement(GenerateView, { stateAtom: GenerateApp.stateAtom }),
          )

          if (Option.isNone(root)) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_found',
              message: 'Not in a megarepo',
            })
            return yield* new GenerateError({ message: 'Not in a megarepo' })
          }

          tui.dispatch({ _tag: 'Start', generator: 'nix' })

          const result = yield* generateNixForRoot({
            outermostRoot: root.value,
            currentRoot: root.value,
            deep,
            depth: 0,
            visited: new Set(),
            tui,
          })

          if (Option.isNone(result)) {
            tui.dispatch({ _tag: 'SetSuccess', results: [] })
            return
          }

          const flatResults = flattenNixGenerateTree(result.value)
          const results = flatResults.flatMap((r) => [
            { generator: 'nix', status: '.envrc.generated.megarepo' },
            { generator: 'nix', status: '.direnv/megarepo-nix/workspace' },
          ])

          tui.dispatch({ _tag: 'SetSuccess', results })
        }),
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/generate/nix')),
).pipe(Cli.Command.withDescription('Generate local Nix workspace'))

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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* GenerateApp.run(
            React.createElement(GenerateView, { stateAtom: GenerateApp.stateAtom }),
          )

          if (Option.isNone(root)) {
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
            ...(Option.isSome(excludeList) ? { exclude: excludeList.value } : {}),
          })

          tui.dispatch({
            _tag: 'SetSuccess',
            results: [{ generator: 'vscode', status: '.vscode/megarepo.code-workspace' }],
          })
        }),
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* GenerateApp.run(
            React.createElement(GenerateView, { stateAtom: GenerateApp.stateAtom }),
          )

          if (Option.isNone(root)) {
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
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/generate/schema')),
).pipe(Cli.Command.withDescription('Generate JSON schema for megarepo.json'))

/** Generate all configured outputs */
const generateAllCommand = Cli.Command.make('all', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    yield* Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* GenerateApp.run(
          React.createElement(GenerateView, { stateAtom: GenerateApp.stateAtom }),
        )

        if (Option.isNone(root)) {
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
        const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

        const outputs = yield* generateAll({
          megarepoRoot: root.value,
          outermostRoot: root.value,
          config,
        })

        const results = outputs.flatMap((genOutput) => {
          switch (genOutput._tag) {
            case 'nix':
              return [
                { generator: 'nix', status: '.envrc.generated.megarepo' },
                { generator: 'nix', status: '.direnv/megarepo-nix/workspace' },
              ]
            case 'vscode':
              return [{ generator: 'vscode', status: '.vscode/megarepo.code-workspace' }]
            default:
              return []
          }
        })

        tui.dispatch({ _tag: 'SetSuccess', results })
      }),
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.withSpan('megarepo/generate/all')),
).pipe(Cli.Command.withDescription('Generate all configured outputs'))

/** Generate subcommand group */
export const generateCommand = Cli.Command.make('generate', {}).pipe(
  Cli.Command.withSubcommands([
    generateAllCommand,
    generateNixCommand,
    generateSchemaCommand,
    generateVscodeCommand,
  ]),
  Cli.Command.withDescription('Generate configuration files'),
)
