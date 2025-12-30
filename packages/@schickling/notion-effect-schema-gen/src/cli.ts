#!/usr/bin/env node

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient, FileSystem } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { NotionConfig, NotionDatabases } from '@schickling/notion-effect-client'
import { fileURLToPath } from 'node:url'
import { Console, Effect, Layer, Option, Schema } from 'effect'
import { type GenerateOptions, generateSchemaCode } from './codegen.ts'
import { loadConfig, mergeWithDefaults } from './config.ts'
import { introspectDatabase, type PropertyTransformConfig } from './introspect.ts'
import { formatCode, writeSchemaToFile } from './output.ts'

// -----------------------------------------------------------------------------
// Common Options
// -----------------------------------------------------------------------------

const GeneratorPackageJsonSchema = Schema.Struct({ version: Schema.String })

const getGeneratorVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pkgJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))
  const content = yield* fs.readFileString(pkgJsonPath)
  const pkg = yield* Schema.decodeUnknown(Schema.parseJson(GeneratorPackageJsonSchema))(content)
  return pkg.version
}).pipe(
  Effect.orElseSucceed(() => 'unknown'),
)

const resolveNotionToken = (token: Option.Option<string>, configToken?: string) =>
  Effect.sync(() => (Option.isSome(token) ? token.value : (configToken ?? process.env.NOTION_TOKEN))).pipe(
    Effect.flatMap((t) =>
      t ? Effect.succeed(t) : Effect.fail(new Error('NOTION_TOKEN env var, config token, or --token is required')),
    ),
  )

const tokenOption = Options.text('token').pipe(
  Options.withAlias('t'),
  Options.withDescription('Notion API token (defaults to NOTION_TOKEN env var)'),
  Options.optional,
)

// -----------------------------------------------------------------------------
// Generate Command
// -----------------------------------------------------------------------------

const generateDatabaseIdArg = Args.text({ name: 'database-id' }).pipe(
  Args.withDescription('The Notion database ID to generate schema from'),
)

const outputOption = Options.file('output').pipe(
  Options.withAlias('o'),
  Options.withDescription('Output file path for generated schema'),
)

const nameOption = Options.text('name').pipe(
  Options.withAlias('n'),
  Options.withDescription('Name for the generated schema (defaults to database title)'),
  Options.optional,
)

const transformOption = Options.keyValueMap('transform').pipe(
  Options.withDescription(
    'Property transform config: property=transform (e.g., Status=asOption, Title=asString)',
  ),
  Options.optional,
)

const dryRunOption = Options.boolean('dry-run').pipe(
  Options.withAlias('d'),
  Options.withDescription('Preview generated code without writing to file'),
  Options.withDefault(false),
)

const includeWriteOption = Options.boolean('include-write').pipe(
  Options.withAlias('w'),
  Options.withDescription('Include Write schemas for creating/updating pages'),
  Options.withDefault(false),
)

const typedOptionsOption = Options.boolean('typed-options').pipe(
  Options.withDescription('Generate typed literal unions for select/status options'),
  Options.withDefault(false),
)

const generateCommand = Command.make(
  'generate',
  {
    databaseId: generateDatabaseIdArg,
    output: outputOption,
    name: nameOption,
    token: tokenOption,
    transform: transformOption,
    dryRun: dryRunOption,
    includeWrite: includeWriteOption,
    typedOptions: typedOptionsOption,
  },
  ({ databaseId, output, name, token, transform, dryRun, includeWrite, typedOptions }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)
      const generatorVersion = yield* getGeneratorVersion

      // Build transform config from CLI options
      const transformConfig: PropertyTransformConfig = {}
      if (Option.isSome(transform)) {
        for (const [key, value] of transform.value) {
          transformConfig[key] = value
        }
      }

      // Build generate options
      const generateOptions: GenerateOptions = {
        transforms: transformConfig,
        includeWrite,
        typedOptions,
        generatorVersion,
      }

      const configLayer = Layer.succeed(NotionConfig, { authToken: resolvedToken })

      const program = Effect.gen(function* () {
        yield* Console.log(`Introspecting database ${databaseId}...`)
        const dbInfo = yield* introspectDatabase(databaseId)

        const schemaName = name._tag === 'Some' ? name.value : dbInfo.name
        yield* Console.log(`Generating schema "${schemaName}"...`)

        const rawCode = generateSchemaCode(dbInfo, schemaName, generateOptions)
        const code = yield* formatCode(rawCode)

        if (dryRun) {
          yield* Console.log('')
          yield* Console.log('--- Generated Code (dry-run) ---')
          yield* Console.log('')
          yield* Console.log(code)
          yield* Console.log('')
          yield* Console.log('--- End Generated Code ---')
          yield* Console.log('')
          yield* Console.log(`Would write to: ${output}`)
        } else {
          yield* Console.log(`Writing to ${output}...`)
          yield* writeSchemaToFile(code, output)
          yield* Console.log(`✓ Schema generated successfully!`)
        }
      })

      yield* program.pipe(Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)))
    }),
).pipe(Command.withDescription('Generate Effect schema from a Notion database'))

// -----------------------------------------------------------------------------
// Introspect Command
// -----------------------------------------------------------------------------

const introspectDatabaseIdArg = Args.text({ name: 'database-id' }).pipe(
  Args.withDescription('The Notion database ID to introspect'),
)

const introspectCommand = Command.make(
  'introspect',
  { databaseId: introspectDatabaseIdArg, token: tokenOption },
  ({ databaseId, token }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)

      const configLayer = Layer.succeed(NotionConfig, { authToken: resolvedToken })

      const program = Effect.gen(function* () {
        const db = yield* NotionDatabases.retrieve({ databaseId })

        yield* Console.log(`Database: ${db.title.map((t) => t.plain_text).join('')}`)
        yield* Console.log(`ID: ${db.id}`)
        yield* Console.log(`URL: ${db.url}`)
        yield* Console.log('')
        yield* Console.log('Properties:')

        const properties = db.properties ?? {}
        for (const [propName, propValue] of Object.entries(properties)) {
          const prop = propValue as { type: string; [key: string]: unknown }
          yield* Console.log(`  - ${propName}: ${prop.type}`)

          // Show additional info for select/multi-select/status
          if (prop.type === 'select' || prop.type === 'multi_select') {
            const options = (prop[prop.type] as { options?: Array<{ name: string }> })?.options
            if (options && options.length > 0) {
              yield* Console.log(`      options: ${options.map((o) => o.name).join(', ')}`)
            }
          }
          if (prop.type === 'status') {
            const statusConfig = prop.status as {
              options?: Array<{ name: string }>
              groups?: Array<{ name: string }>
            }
            if (statusConfig?.options && statusConfig.options.length > 0) {
              yield* Console.log(
                `      options: ${statusConfig.options.map((o) => o.name).join(', ')}`,
              )
            }
            if (statusConfig?.groups && statusConfig.groups.length > 0) {
              yield* Console.log(
                `      groups: ${statusConfig.groups.map((g) => g.name).join(', ')}`,
              )
            }
          }
          if (prop.type === 'relation') {
            const relationConfig = prop.relation as { database_id?: string }
            if (relationConfig?.database_id) {
              yield* Console.log(`      database: ${relationConfig.database_id}`)
            }
          }
        }
      })

      yield* program.pipe(Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)))
    }),
).pipe(Command.withDescription('Introspect a Notion database and display its schema'))

// -----------------------------------------------------------------------------
// Generate From Config Command
// -----------------------------------------------------------------------------

const configOption = Options.file('config').pipe(
  Options.withAlias('c'),
  Options.withDescription(
    'Path to config file (defaults to searching for .notion-schema-gen.json in current/parent dirs)',
  ),
  Options.optional,
)

const generateFromConfigCommand = Command.make(
  'generate-config',
  { config: configOption, token: tokenOption, dryRun: dryRunOption },
  ({ config, token, dryRun }) =>
    Effect.gen(function* () {
      const { config: schemaConfig, path: resolvedConfigPath } = yield* loadConfig(
        Option.isSome(config) ? config.value : undefined,
      )

      const resolvedToken = yield* resolveNotionToken(token, schemaConfig.token)
      const generatorVersion = yield* getGeneratorVersion

      const configLayer = Layer.succeed(NotionConfig, { authToken: resolvedToken })

      const program = Effect.gen(function* () {
        yield* Console.log(`Using config: ${resolvedConfigPath}`)
        yield* Console.log(`Generating ${schemaConfig.databases.length} schema(s)...`)

        for (const dbConfig of schemaConfig.databases) {
          const merged = mergeWithDefaults(dbConfig, schemaConfig.defaults)

          yield* Console.log('')
          yield* Console.log(`Introspecting database ${merged.id}...`)
          const dbInfo = yield* introspectDatabase(merged.id)

          const schemaName = merged.name ?? dbInfo.name
          yield* Console.log(`Generating schema "${schemaName}"...`)

          const rawCode = generateSchemaCode(dbInfo, schemaName, {
            transforms: merged.transforms ?? {},
            includeWrite: merged.includeWrite ?? false,
            typedOptions: merged.typedOptions ?? false,
            generatorVersion,
          })
          const code = yield* formatCode(rawCode)

          if (dryRun) {
            yield* Console.log('')
            yield* Console.log('--- Generated Code (dry-run) ---')
            yield* Console.log('')
            yield* Console.log(code)
            yield* Console.log('')
            yield* Console.log('--- End Generated Code ---')
            yield* Console.log('')
            yield* Console.log(`Would write to: ${merged.output}`)
          } else {
            yield* Console.log(`Writing to ${merged.output}...`)
            yield* writeSchemaToFile(code, merged.output)
            yield* Console.log(`✓ Schema generated successfully!`)
          }
        }
      })

      yield* program.pipe(Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)))
    }),
).pipe(Command.withDescription('Generate schemas for all databases in a config file'))

// -----------------------------------------------------------------------------
// Main CLI
// -----------------------------------------------------------------------------

const command = Command.make('notion-effect-schema-gen').pipe(
  Command.withSubcommands([generateCommand, introspectCommand, generateFromConfigCommand]),
  Command.withDescription('Generate Effect schemas from Notion databases'),
)

const cli = Command.run(command, {
  name: 'notion-effect-schema-gen',
  version: '0.1.0',
})

cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
