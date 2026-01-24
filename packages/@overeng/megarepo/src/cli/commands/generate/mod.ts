/**
 * Generate Commands
 *
 * Commands for generating configuration files.
 */

import * as Cli from '@effect/cli'
import type { CommandExecutor} from '@effect/platform';
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Console, Effect, Option, type ParseResult, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'
import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, getMemberPath, MegarepoConfig } from '../../../lib/config.ts'
import { generateAll } from '../../../lib/generators/mod.ts'
import { generateNix, type NixGeneratorError } from '../../../lib/generators/nix/mod.ts'
import { generateSchema } from '../../../lib/generators/schema.ts'
import { generateVscode } from '../../../lib/generators/vscode.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../../context.ts'

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
  json: boolean
  depth: number
  visited: Set<string>
}

const generateNixForRoot: (
  params: GenerateNixForRootParams,
) => Effect.Effect<
  Option.Option<NixGenerateTree>,
  NixGeneratorError | PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> = Effect.fn('megarepo/generate/nix/root')((params: GenerateNixForRootParams) =>
  Effect.gen(function* () {
    const { outermostRoot, currentRoot, deep, json, depth, visited } = params
    const rootKey = currentRoot.replace(/\/$/, '')
    if (visited.has(rootKey)) {
      return Option.none<NixGenerateTree>()
    }
    visited.add(rootKey)

    const indent = '  '.repeat(depth)
    const fs = yield* FileSystem.FileSystem
    const configPath = EffectPath.ops.join(
      currentRoot,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    if (!json && depth > 0) {
      yield* Console.log(`${indent}${styled.dim(`Generating ${currentRoot}...`)}`)
    }

    const result = yield* generateNix({
      megarepoRootOutermost: outermostRoot,
      megarepoRootNearest: currentRoot,
      config,
    })

    if (!json) {
      yield* Console.log(
        `${indent}${styled.green(symbols.check)} Generated ${styled.bold('.envrc.generated.megarepo')}`,
      )
      yield* Console.log(
        `${indent}${styled.green(symbols.check)} Generated ${styled.bold('.direnv/megarepo-nix/workspace')}`,
      )
    }

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

      if (nestedRoots.length > 0 && !json) {
        yield* Console.log('')
        yield* Console.log(`${indent}${styled.bold('Generating nested megarepos...')}`)
      }

      for (const nestedRoot of nestedRoots) {
        const nestedResult = yield* generateNixForRoot({
          outermostRoot,
          currentRoot: nestedRoot,
          deep,
          json,
          depth: depth + 1,
          visited,
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
    json: jsonOption,
    deep: Cli.Options.boolean('deep').pipe(
      Cli.Options.withDescription('Recursively generate nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, deep }) =>
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
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const result = yield* generateNixForRoot({
        outermostRoot: root.value,
        currentRoot: root.value,
        deep,
        json,
        depth: 0,
        visited: new Set(),
      })

      if (Option.isNone(result)) return

      if (json) {
        console.log(
          JSON.stringify({
            status: 'generated',
            results: flattenNixGenerateTree(result.value),
          }),
        )
      }
    }).pipe(Effect.withSpan('megarepo/generate/nix')),
).pipe(Cli.Command.withDescription('Generate local Nix workspace'))

/** Generate VSCode workspace file */
const generateVscodeCommand = Cli.Command.make(
  'vscode',
  {
    json: jsonOption,
    exclude: Cli.Options.text('exclude').pipe(
      Cli.Options.withDescription('Comma-separated list of members to exclude'),
      Cli.Options.optional,
    ),
  },
  ({ json, exclude }) =>
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

      const excludeList = Option.map(exclude, (e) => e.split(',').map((s) => s.trim()))

      const result = yield* generateVscode({
        megarepoRoot: root.value,
        config,
        ...(Option.isSome(excludeList) ? { exclude: excludeList.value } : {}),
      })

      if (json) {
        console.log(JSON.stringify({ status: 'generated', path: result.path }))
      } else {
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.vscode/megarepo.code-workspace')}`,
        )
      }
    }).pipe(Effect.withSpan('megarepo/generate/vscode')),
).pipe(Cli.Command.withDescription('Generate VS Code workspace file'))

/** Generate JSON Schema */
const generateSchemaCommand = Cli.Command.make(
  'schema',
  {
    json: jsonOption,
    output: Cli.Options.text('output').pipe(
      Cli.Options.withAlias('o'),
      Cli.Options.withDescription('Output path (relative to megarepo root)'),
      Cli.Options.withDefault('schema/megarepo.schema.json'),
    ),
  },
  ({ json, output }) =>
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

      const result = yield* generateSchema({
        megarepoRoot: root.value,
        config,
        outputPath: output,
      })

      if (json) {
        console.log(JSON.stringify({ status: 'generated', path: result.path }))
      } else {
        yield* Console.log(`${styled.green(symbols.check)} Generated ${styled.bold(output)}`)
      }
    }).pipe(Effect.withSpan('megarepo/generate/schema')),
).pipe(Cli.Command.withDescription('Generate JSON schema for megarepo.json'))

/** Generate all configured outputs */
const generateAllCommand = Cli.Command.make('all', { json: jsonOption }, ({ json }) =>
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

    const outputs = yield* generateAll({
      megarepoRoot: root.value,
      outermostRoot: root.value,
      config,
    })

    const results = outputs.map((output) =>
      output._tag === 'nix'
        ? { generator: output._tag, path: output.workspaceRoot }
        : { generator: output._tag, path: output.path },
    )

    if (json) {
      console.log(JSON.stringify({ status: 'generated', results }))
      return
    }

    for (const output of outputs) {
      switch (output._tag) {
        case 'nix':
          yield* Console.log(
            `${styled.green(symbols.check)} Generated ${styled.bold('.envrc.generated.megarepo')}`,
          )
          yield* Console.log(
            `${styled.green(symbols.check)} Generated ${styled.bold('.direnv/megarepo-nix/workspace')}`,
          )
          break
        case 'vscode':
          yield* Console.log(
            `${styled.green(symbols.check)} Generated ${styled.bold('.vscode/megarepo.code-workspace')}`,
          )
          break
        case 'schema':
          yield* Console.log(
            `${styled.green(symbols.check)} Generated ${styled.bold('schema/megarepo.schema.json')}`,
          )
          break
      }
    }

    yield* Console.log('')
    yield* Console.log(styled.dim(`Generated ${results.length} file(s)`))
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
