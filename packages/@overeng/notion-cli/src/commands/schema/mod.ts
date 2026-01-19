/**
 * Schema subcommand - generate Effect schemas from Notion databases
 */

import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient, FileSystem } from '@effect/platform'
import { Console, Effect, Layer, Option, Redacted, Schema } from 'effect'

import { EffectPath } from '@overeng/effect-path'
import { NotionConfig, NotionDatabases } from '@overeng/notion-effect-client'

import { type GenerateOptions, generateApiCode, generateSchemaCode } from '../../codegen.ts'
import { loadConfig } from '../../config.ts'
import { computeDiff, formatDiff, hasDifferences, parseGeneratedFile } from '../../diff.ts'
import { introspectDatabase, type PropertyTransformConfig } from '../../introspect.ts'
import { formatCode, writeSchemaToFile } from '../../output.ts'

// -----------------------------------------------------------------------------
// Exported Errors
// -----------------------------------------------------------------------------

/** Error thrown when a generated schema file cannot be parsed for drift detection */
export class GeneratedSchemaFileParseError extends Schema.TaggedError<GeneratedSchemaFileParseError>()(
  'GeneratedSchemaFileParseError',
  {
    file: Schema.String,
    message: Schema.String,
  },
) {}

/** Error thrown when generated schema differs from existing file during check mode */
export class SchemaDriftDetectedError extends Schema.TaggedError<SchemaDriftDetectedError>()(
  'SchemaDriftDetectedError',
  {
    databaseId: Schema.String,
    file: Schema.String,
    message: Schema.String,
  },
) {}

// -----------------------------------------------------------------------------
// Common Options
// -----------------------------------------------------------------------------

const GeneratorPackageJsonSchema = Schema.Struct({ version: Schema.String })

class NotionTokenMissingError extends Schema.TaggedError<NotionTokenMissingError>()(
  'NotionTokenMissingError',
  {
    message: Schema.String,
  },
) {}

const getGeneratorVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pkgJsonPath = fileURLToPath(new URL('../../../package.json', import.meta.url))
  const content = yield* fs.readFileString(pkgJsonPath)
  const pkg = yield* Schema.decodeUnknown(Schema.parseJson(GeneratorPackageJsonSchema))(content)
  return pkg.version
}).pipe(Effect.orElseSucceed(() => 'unknown'))

/** Resolve the Notion API token from CLI option or `NOTION_TOKEN`. */
export const resolveNotionToken = (token: Option.Option<string>) =>
  Effect.sync(() => (Option.isSome(token) ? token.value : process.env.NOTION_TOKEN)).pipe(
    Effect.flatMap((t) =>
      t
        ? Effect.succeed(t)
        : Effect.fail(
            new NotionTokenMissingError({
              message: 'NOTION_TOKEN env var or --token is required',
            }),
          ),
    ),
  )

/** CLI option for providing a Notion API token (defaults to `NOTION_TOKEN`). */
export const tokenOption = Options.text('token').pipe(
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
  Options.withDescription(
    'Output file path for generated schema (recommend using .gen.ts suffix, e.g., schema.gen.ts)',
  ),
)

const nameOption = Options.text('name').pipe(
  Options.withAlias('n'),
  Options.withDescription('Name for the generated schema (defaults to database title)'),
  Options.optional,
)

const transformOption = Options.keyValueMap('transform').pipe(
  Options.withDescription(
    'Property transform config: property=transform (e.g., Status=asName, Title=asString)',
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
  Options.withDescription(
    'Generate typed literal unions for select/status/multi_select options and use typed property transforms by default',
  ),
  Options.withDefault(false),
)

const schemaMetaOption = Options.boolean('schema-meta').pipe(
  Options.withDescription('Include Notion property metadata annotations in the generated schema'),
  Options.withDefault(true),
)

const noSchemaMetaOption = Options.boolean('no-schema-meta').pipe(
  Options.withDescription('Disable Notion property metadata annotations'),
  Options.withDefault(false),
)

const includeApiOption = Options.boolean('include-api').pipe(
  Options.withAlias('a'),
  Options.withDescription('Generate a typed database API wrapper alongside the schema'),
  Options.withDefault(false),
)

const writableOption = Options.boolean('writable').pipe(
  Options.withDescription(
    'Keep generated files writable (default: false, files are made read-only to discourage manual edits)',
  ),
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
    schemaMeta: schemaMetaOption,
    noSchemaMeta: noSchemaMetaOption,
    includeApi: includeApiOption,
    writable: writableOption,
  },
  ({
    databaseId,
    output,
    name,
    token,
    transform,
    dryRun,
    includeWrite,
    typedOptions,
    schemaMeta,
    noSchemaMeta,
    includeApi,
    writable,
  }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)
      const generatorVersion = yield* getGeneratorVersion

      const transformConfig: PropertyTransformConfig = {}
      if (Option.isSome(transform)) {
        for (const [key, value] of transform.value) {
          transformConfig[key] = value
        }
      }

      const generateOptions: GenerateOptions = {
        transforms: transformConfig,
        includeWrite,
        typedOptions,
        schemaMeta: noSchemaMeta ? false : schemaMeta,
        includeApi,
        generatorVersion,
        ...(Option.isSome(name) ? { schemaNameOverride: name.value } : {}),
      }

      const configLayer = Layer.succeed(NotionConfig, { authToken: Redacted.make(resolvedToken) })

      const program = Effect.gen(function* () {
        yield* Console.log(`Introspecting database ${databaseId}...`)
        const dbInfo = yield* introspectDatabase(databaseId)

        const schemaName = name._tag === 'Some' ? name.value : dbInfo.name
        yield* Console.log(`Generating schema "${schemaName}"...`)

        const rawCode = generateSchemaCode({ dbInfo, schemaName, options: generateOptions })
        const code = yield* formatCode(rawCode)

        if (dryRun) {
          yield* Console.log('')
          yield* Console.log('--- Generated Schema Code (dry-run) ---')
          yield* Console.log('')
          yield* Console.log(code)
          yield* Console.log('')
          yield* Console.log('--- End Generated Schema Code ---')
          yield* Console.log('')
          yield* Console.log(`Would write to: ${output}`)

          if (includeApi) {
            const schemaFileName = basename(output)
            const rawApiCode = generateApiCode({
              dbInfo,
              schemaName,
              schemaFileName,
              options: generateOptions,
            })
            const apiCode = yield* formatCode(rawApiCode)
            const apiOutput = output.replace(/\.ts$/, '.api.ts')

            yield* Console.log('')
            yield* Console.log('--- Generated API Code (dry-run) ---')
            yield* Console.log('')
            yield* Console.log(apiCode)
            yield* Console.log('')
            yield* Console.log('--- End Generated API Code ---')
            yield* Console.log('')
            yield* Console.log(`Would write to: ${apiOutput}`)
          }
        } else {
          yield* Console.log(`Writing to ${output}...`)
          yield* writeSchemaToFile({
            code,
            outputPath: EffectPath.unsafe.absoluteFile(output),
            writable,
          })
          yield* Console.log(`Done${writable ? '' : ' (read-only)'}`)

          if (includeApi) {
            const schemaFileName = basename(output)
            const rawApiCode = generateApiCode({
              dbInfo,
              schemaName,
              schemaFileName,
              options: generateOptions,
            })
            const apiCode = yield* formatCode(rawApiCode)
            const apiOutput = output.replace(/\.ts$/, '.api.ts')

            yield* Console.log(`Writing API to ${apiOutput}...`)
            yield* writeSchemaToFile({
              code: apiCode,
              outputPath: EffectPath.unsafe.absoluteFile(apiOutput),
              writable,
            })
            yield* Console.log(`Done${writable ? '' : ' (read-only)'}`)
          }
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

      const configLayer = Layer.succeed(NotionConfig, { authToken: Redacted.make(resolvedToken) })

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
    'Path to config file (defaults to searching for notion-schema-gen.config.ts in current/parent dirs)',
  ),
  Options.optional,
)

const generateFromConfigCommand = Command.make(
  'generate-config',
  { config: configOption, token: tokenOption, dryRun: dryRunOption, writable: writableOption },
  ({ config, token, dryRun, writable }) =>
    Effect.gen(function* () {
      const { config: resolvedConfig, path: resolvedConfigPath } = yield* loadConfig(
        Option.isSome(config) ? config.value : undefined,
      )

      const resolvedToken = yield* resolveNotionToken(token)
      const generatorVersion = yield* getGeneratorVersion

      const configLayer = Layer.succeed(NotionConfig, { authToken: Redacted.make(resolvedToken) })

      const program = Effect.gen(function* () {
        yield* Console.log(`Using config: ${resolvedConfigPath}`)
        yield* Console.log(`Generating ${resolvedConfig.databases.length} schema(s)...`)

        for (const dbConfig of resolvedConfig.databases) {
          yield* Console.log('')
          yield* Console.log(`Introspecting database ${dbConfig.id}...`)
          const dbInfo = yield* introspectDatabase(dbConfig.id)

          const schemaName = dbConfig.name ?? dbInfo.name
          yield* Console.log(`Generating schema "${schemaName}"...`)

          const generateOptions: GenerateOptions = {
            transforms: dbConfig.transforms ?? {},
            includeWrite: dbConfig.includeWrite ?? false,
            typedOptions: dbConfig.typedOptions ?? false,
            schemaMeta: dbConfig.schemaMeta ?? true,
            includeApi: dbConfig.includeApi ?? false,
            generatorVersion,
            ...(dbConfig.name !== undefined ? { schemaNameOverride: dbConfig.name } : {}),
          }

          const rawCode = generateSchemaCode({ dbInfo, schemaName, options: generateOptions })
          const code = yield* formatCode(rawCode)

          if (dryRun) {
            yield* Console.log('')
            yield* Console.log('--- Generated Schema Code (dry-run) ---')
            yield* Console.log('')
            yield* Console.log(code)
            yield* Console.log('')
            yield* Console.log('--- End Generated Schema Code ---')
            yield* Console.log('')
            yield* Console.log(`Would write to: ${dbConfig.output}`)

            if (generateOptions.includeApi) {
              const schemaFileName = basename(dbConfig.output)
              const rawApiCode = generateApiCode({
                dbInfo,
                schemaName,
                schemaFileName,
                options: generateOptions,
              })
              const apiCode = yield* formatCode(rawApiCode)
              const apiOutput = dbConfig.output.replace(/\.ts$/, '.api.ts')

              yield* Console.log('')
              yield* Console.log('--- Generated API Code (dry-run) ---')
              yield* Console.log('')
              yield* Console.log(apiCode)
              yield* Console.log('')
              yield* Console.log('--- End Generated API Code ---')
              yield* Console.log('')
              yield* Console.log(`Would write to: ${apiOutput}`)
            }
          } else {
            yield* Console.log(`Writing to ${dbConfig.output}...`)
            yield* writeSchemaToFile({
              code,
              outputPath: EffectPath.unsafe.absoluteFile(dbConfig.output),
              writable,
            })
            yield* Console.log(`Done${writable ? '' : ' (read-only)'}`)

            if (generateOptions.includeApi) {
              const schemaFileName = basename(dbConfig.output)
              const rawApiCode = generateApiCode({
                dbInfo,
                schemaName,
                schemaFileName,
                options: generateOptions,
              })
              const apiCode = yield* formatCode(rawApiCode)
              const apiOutput = dbConfig.output.replace(/\.ts$/, '.api.ts')

              yield* Console.log(`Writing API to ${apiOutput}...`)
              yield* writeSchemaToFile({
                code: apiCode,
                outputPath: EffectPath.unsafe.absoluteFile(apiOutput),
                writable,
              })
              yield* Console.log(`Done${writable ? '' : ' (read-only)'}`)
            }
          }
        }
      })

      yield* program.pipe(Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)))
    }),
).pipe(Command.withDescription('Generate schemas for all databases in a config file'))

// -----------------------------------------------------------------------------
// Diff Command
// -----------------------------------------------------------------------------

const diffDatabaseIdArg = Args.text({ name: 'database-id' }).pipe(
  Args.withDescription('The Notion database ID to compare against'),
)

const diffFileOption = Options.file('file').pipe(
  Options.withAlias('f'),
  Options.withDescription('Path to the existing generated schema file'),
)

const exitCodeOption = Options.boolean('exit-code').pipe(
  Options.withDescription('Exit with code 1 if differences are found (for CI)'),
  Options.withDefault(false),
)

const diffCommand = Command.make(
  'diff',
  {
    databaseId: diffDatabaseIdArg,
    file: diffFileOption,
    token: tokenOption,
    exitCode: exitCodeOption,
  },
  ({ databaseId, file, token, exitCode }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)
      const fs = yield* FileSystem.FileSystem

      const configLayer = Layer.succeed(NotionConfig, { authToken: Redacted.make(resolvedToken) })

      const program = Effect.gen(function* () {
        const fileContent = yield* fs.readFileString(file)
        const parsedSchema = parseGeneratedFile(fileContent)
        if (!parsedSchema.readSchemaFound) {
          return yield* new GeneratedSchemaFileParseError({
            file,
            message:
              'Could not find a "*PageProperties = Schema.Struct({ ... })" read schema in file',
          })
        }

        yield* Console.log(`Introspecting database ${databaseId}...`)
        const dbInfo = yield* introspectDatabase(databaseId)

        const diff = computeDiff({ live: dbInfo, generated: parsedSchema })

        const lines = formatDiff({ diff, databaseId, filePath: file })
        for (const line of lines) {
          yield* Console.log(line)
        }

        if (exitCode && hasDifferences(diff)) {
          return yield* new SchemaDriftDetectedError({
            databaseId,
            file,
            message: 'Schema drift detected',
          })
        }
      })

      yield* program.pipe(Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)))
    }),
).pipe(
  Command.withDescription('Compare a Notion database schema with a generated file to detect drift'),
)

// -----------------------------------------------------------------------------
// Schema Subcommand
// -----------------------------------------------------------------------------

/** Schema command with subcommands for generation and drift detection. */
export const schemaCommand = Command.make('schema').pipe(
  Command.withSubcommands([
    generateCommand,
    introspectCommand,
    generateFromConfigCommand,
    diffCommand,
  ]),
  Command.withDescription('Schema generation commands'),
)
