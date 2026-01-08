/**
 * Database subcommand - database operations including dump
 */

import * as path from 'node:path'

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient, FileSystem } from '@effect/platform'
import type { Cause, Channel, Sink, Stream } from 'effect'
import { Console, Effect, Layer, Option } from 'effect'
import type { NodeInspectSymbol } from 'effect/Inspectable'

/** Re-export internal types for TypeScript declaration emit */
export type { Cause, Channel, Sink, Stream } from 'effect'
export type { NodeInspectSymbol } from 'effect/Inspectable'

import { type DatabaseFilter, NotionConfig, NotionDatabases } from '@overeng/notion-effect-client'

import { DumpPage, DumpSchemaFile, encodeDumpPage } from '../../dump/schema.ts'
import { introspectDatabase } from '../../introspect.ts'
import { resolveNotionToken, tokenOption } from '../schema/mod.ts'

// -----------------------------------------------------------------------------
// Common Options
// -----------------------------------------------------------------------------

const databaseIdArg = Args.text({ name: 'database-id' }).pipe(
  Args.withDescription('The Notion database ID to operate on'),
)

// -----------------------------------------------------------------------------
// Dump Command
// -----------------------------------------------------------------------------

const outputOption = Options.file('output').pipe(
  Options.withAlias('o'),
  Options.withDescription('Output file path for NDJSON data (schema file will be .schema.json)'),
)

const contentOption = Options.boolean('content').pipe(
  Options.withDescription('Include page content blocks in the dump'),
  Options.withDefault(false),
)

const depthOption = Options.integer('depth').pipe(
  Options.withDescription('Maximum depth for nested content blocks (default: unlimited)'),
  Options.optional,
)

const sinceOption = Options.text('since').pipe(
  Options.withDescription('Only include pages modified since this ISO date (e.g., 2024-01-01)'),
  Options.optional,
)

const sinceLastOption = Options.boolean('since-last').pipe(
  Options.withDescription('Only include pages modified since last dump (reads checkpoint file)'),
  Options.withDefault(false),
)

const checkpointOption = Options.file('checkpoint').pipe(
  Options.withDescription(
    'Checkpoint file path for incremental dumps (default: <output>.checkpoint.json)',
  ),
  Options.optional,
)

const filterOption = Options.text('filter').pipe(
  Options.withDescription('Filter pages by property value (e.g., "Status=Done")'),
  Options.optional,
)

const verboseOption = Options.boolean('verbose').pipe(
  Options.withAlias('v'),
  Options.withDescription('Show verbose output'),
  Options.withDefault(false),
)

const quietOption = Options.boolean('quiet').pipe(
  Options.withAlias('q'),
  Options.withDescription('Suppress all output except errors'),
  Options.withDefault(false),
)

/** Parse a simple filter string like "Status=Done" into a Notion filter */
const parseSimpleFilter = (
  filterStr: string,
): { property: string; [key: string]: unknown } | undefined => {
  const match = filterStr.match(/^([^=]+)=(.+)$/)
  if (!match) return undefined

  const [, property, value] = match
  if (!property || !value) return undefined

  // For now, assume it's a select/status property
  // TODO: Support more property types based on introspection
  return {
    property,
    select: { equals: value },
  }
}

const dumpCommand = Command.make(
  'dump',
  {
    databaseId: databaseIdArg,
    output: outputOption,
    token: tokenOption,
    content: contentOption,
    depth: depthOption,
    since: sinceOption,
    sinceLast: sinceLastOption,
    checkpoint: checkpointOption,
    filter: filterOption,
    verbose: verboseOption,
    quiet: quietOption,
  },
  ({
    databaseId,
    output,
    token,
    content,
    depth,
    since,
    sinceLast,
    checkpoint,
    filter,
    verbose,
    quiet,
  }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)
      const fs = yield* FileSystem.FileSystem

      const configLayer = Layer.succeed(NotionConfig, { authToken: resolvedToken })

      const log = (msg: string) => (quiet ? Effect.void : Console.log(msg))
      const logVerbose = (msg: string) => (verbose && !quiet ? Console.log(msg) : Effect.void)

      const program = Effect.gen(function* () {
        yield* log(`Dumping database ${databaseId}...`)

        // Introspect database for schema
        const dbInfo = yield* introspectDatabase(databaseId)
        yield* logVerbose(`Database: ${dbInfo.name}`)
        yield* logVerbose(`Properties: ${dbInfo.properties.length}`)

        // Determine output paths
        const outputPath = output
        const schemaPath = output.replace(/\.ndjson$/, '') + '.schema.json'
        const checkpointPath = Option.isSome(checkpoint)
          ? checkpoint.value
          : output.replace(/\.ndjson$/, '') + '.checkpoint.json'

        // Handle incremental dump
        let lastEditedFilter: string | undefined
        if (sinceLast) {
          const checkpointExists = yield* fs.exists(checkpointPath)
          if (checkpointExists) {
            const checkpointContent = yield* fs.readFileString(checkpointPath)
            const checkpointData = JSON.parse(checkpointContent) as { lastDumpedAt?: string }
            lastEditedFilter = checkpointData.lastDumpedAt
            yield* log(`Incremental dump since ${lastEditedFilter}`)
          } else {
            yield* log('No checkpoint found, performing full dump')
          }
        } else if (Option.isSome(since)) {
          lastEditedFilter = since.value
          yield* log(`Filtering pages modified since ${lastEditedFilter}`)
        }

        // Build query options
        const queryFilter = Option.isSome(filter) ? parseSimpleFilter(filter.value) : undefined

        // Create combined filter if we have both time and property filters
        let combinedFilter: DatabaseFilter | undefined
        if (lastEditedFilter && queryFilter) {
          combinedFilter = {
            and: [
              { timestamp: 'last_edited_time', last_edited_time: { after: lastEditedFilter } },
              queryFilter,
            ],
          }
        } else if (lastEditedFilter) {
          combinedFilter = {
            timestamp: 'last_edited_time',
            last_edited_time: { after: lastEditedFilter },
          }
        } else if (queryFilter) {
          combinedFilter = queryFilter
        }

        // Write schema file
        const schemaFile: typeof DumpSchemaFile.Type = {
          version: '1',
          databaseId,
          databaseName: dbInfo.name,
          dumpedAt: new Date().toISOString(),
          properties: dbInfo.properties.map((p) => ({
            name: p.name,
            type: p.type,
            config: p.select ?? p.status ?? p.relation ?? undefined,
          })),
          options: {
            includeContent: content,
            contentDepth: Option.isSome(depth) ? depth.value : undefined,
          },
        }

        yield* logVerbose(`Writing schema to ${schemaPath}...`)
        yield* fs.writeFileString(schemaPath, JSON.stringify(schemaFile, null, 2))

        // Query pages with pagination
        yield* log(`Fetching pages to ${outputPath}...`)

        const outputDir = path.dirname(outputPath)

        // Ensure output directory exists
        const dirExists = yield* fs.exists(outputDir)
        if (!dirExists) {
          yield* fs.makeDirectory(outputDir, { recursive: true })
        }

        // Fetch all pages using pagination
        const lines: string[] = []
        let pageCount = 0
        let startCursor: string | undefined

        while (true) {
          const result = yield* NotionDatabases.query({
            databaseId,
            ...(combinedFilter !== undefined ? { filter: combinedFilter } : {}),
            ...(startCursor !== undefined ? { startCursor } : {}),
            pageSize: 100,
          })

          for (const page of result.results) {
            // Extract properties
            const properties: Record<string, unknown> = {}
            for (const [key, value] of Object.entries(page.properties ?? {})) {
              properties[key] = value
            }

            // TODO: Fetch content blocks if --content flag is set
            // This requires the ContentFetcher service which will be added in a follow-up

            const dumpPage: typeof DumpPage.Type = {
              id: page.id,
              url: page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`,
              createdTime: page.created_time,
              lastEditedTime: page.last_edited_time,
              properties,
              content: content ? [] : undefined, // Placeholder for now
            }

            lines.push(encodeDumpPage(dumpPage))
            pageCount++

            if (verbose && pageCount % 10 === 0) {
              yield* logVerbose(`  ${pageCount} pages...`)
            }
          }

          if (!result.hasMore || Option.isNone(result.nextCursor)) {
            break
          }
          startCursor = result.nextCursor.value
        }

        // Write all lines to file
        yield* fs.writeFileString(outputPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''))

        yield* log(`Dumped ${pageCount} pages`)

        // Write checkpoint
        yield* logVerbose(`Writing checkpoint to ${checkpointPath}...`)
        yield* fs.writeFileString(
          checkpointPath,
          JSON.stringify({ lastDumpedAt: schemaFile.dumpedAt, pageCount }, null, 2),
        )

        yield* log('Done')
      })

      yield* program.pipe(Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)))
    }),
).pipe(Command.withDescription('Dump a Notion database to NDJSON format for backup or migration'))

// -----------------------------------------------------------------------------
// Info Command
// -----------------------------------------------------------------------------

const infoCommand = Command.make(
  'info',
  { databaseId: databaseIdArg, token: tokenOption },
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
        }

        // Get row count
        const result = yield* NotionDatabases.query({ databaseId, pageSize: 1 })
        yield* Console.log('')
        yield* Console.log(`Rows: ${result.hasMore ? '100+' : result.results.length}`)
      })

      yield* program.pipe(Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)))
    }),
).pipe(Command.withDescription('Display information about a Notion database'))

// -----------------------------------------------------------------------------
// DB Subcommand
// -----------------------------------------------------------------------------

/** Database operations subcommand */
export const dbCommand = Command.make('db').pipe(
  Command.withSubcommands([dumpCommand, infoCommand]),
  Command.withDescription('Database operations'),
)
