/**
 * Database subcommand - database operations including dump
 */

import { Args, Command, Options } from '@effect/cli'
import { FetchHttpClient, FileSystem, HttpClient } from '@effect/platform'
import type { Cause, Channel, Sink } from 'effect'
import { Effect, Layer, Option, Redacted, Schema, Stream } from 'effect'
import type { NodeInspectSymbol } from 'effect/Inspectable'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'
import { outputOption as tuiOutputOption, outputModeLayer } from '@overeng/tui-react/node'

import { DumpApp } from '../../renderers/DumpOutput/app.ts'
import { DumpView } from '../../renderers/DumpOutput/view.tsx'
import { InfoApp } from '../../renderers/InfoOutput/app.ts'
import { InfoView } from '../../renderers/InfoOutput/view.tsx'

/** Re-export internal types for TypeScript declaration emit */
export type { Cause, Channel, Sink, Stream } from 'effect'
export type { NodeInspectSymbol } from 'effect/Inspectable'
export type { PlatformError } from '@effect/platform/Error'

import {
  type BlockWithDepth,
  type DatabaseFilter,
  NotionBlocks,
  NotionConfig,
  NotionDatabases,
} from '@overeng/notion-effect-client'

import { generateSchemaCode } from '../../codegen.ts'
import { type DumpPage, encodeDumpPage } from '../../dump/schema.ts'
import { introspectDatabase } from '../../introspect.ts'
import { resolveNotionToken, tokenOption } from '../schema/mod.ts'

// -----------------------------------------------------------------------------
// Checkpoint Schema
// -----------------------------------------------------------------------------

/** Schema for dump checkpoint files */
const CheckpointData = Schema.Struct({
  lastDumpedAt: Schema.optional(Schema.String),
  pageCount: Schema.optional(Schema.Number),
  contentIncluded: Schema.optional(Schema.Boolean),
  assets: Schema.optional(
    Schema.Struct({
      count: Schema.Number,
      totalBytes: Schema.Number,
      directory: Schema.String,
    }),
  ),
  failures: Schema.optional(Schema.Array(Schema.Unknown)),
})

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
  Options.withDescription('Output file path for NDJSON data (schema file will be .schema.ts)'),
)

const contentOption = Options.boolean('content').pipe(
  Options.withDescription('Include page content blocks in the dump'),
  Options.withDefault(false),
)

const depthOption = Options.integer('depth').pipe(
  Options.withDescription('Maximum depth for nested content blocks (default: unlimited)'),
  Options.optional,
)

const assetsOption = Options.boolean('assets').pipe(
  Options.withDescription('Download file assets (PDFs, images, etc.) from content blocks'),
  Options.withDefault(false),
)

const assetsDirOption = Options.directory('assets-dir').pipe(
  Options.withDescription('Directory for downloaded assets (default: <output-dir>/assets)'),
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

// -----------------------------------------------------------------------------
// Content & Asset Helpers
// -----------------------------------------------------------------------------

/** Block types that can contain file assets */
const ASSET_BLOCK_TYPES = new Set(['image', 'video', 'audio', 'file', 'pdf'])

/** Info about an asset to download */
interface AssetInfo {
  readonly blockId: string
  readonly blockType: string
  readonly url: string
  readonly name: string
  readonly isNotionHosted: boolean
  readonly expiryTime: string | undefined
}

/** Extract asset info from a block if it contains downloadable files */
const extractAssetFromBlock = (block: BlockWithDepth['block']): AssetInfo | undefined => {
  if (ASSET_BLOCK_TYPES.has(block.type) === false) return undefined

  const blockData = block[block.type] as
    | {
        type?: string
        file?: { url: string; expiry_time?: string }
        external?: { url: string }
        name?: string
        caption?: unknown[]
      }
    | undefined

  if (!blockData) return undefined

  if (blockData.type === 'file' && blockData.file) {
    const fileName = blockData.name ?? `${block.type}-${block.id}`
    return {
      blockId: block.id,
      blockType: block.type,
      url: blockData.file.url,
      name: fileName,
      isNotionHosted: true,
      expiryTime: blockData.file.expiry_time,
    }
  }

  if (blockData.type === 'external' && blockData.external) {
    const urlPath = blockData.external.url.split('/').pop() ?? ''
    const fileName = blockData.name ?? (urlPath || `${block.type}-${block.id}`)
    return {
      blockId: block.id,
      blockType: block.type,
      url: blockData.external.url,
      name: fileName,
      isNotionHosted: false,
      expiryTime: undefined,
    }
  }

  return undefined
}

/** Extract all assets from a list of blocks */
const extractAssetsFromBlocks = (blocks: readonly BlockWithDepth[]): readonly AssetInfo[] =>
  blocks.flatMap((b) => {
    const asset = extractAssetFromBlock(b.block)
    return asset ? [asset] : []
  })

/** Download a single asset to the filesystem */
const downloadAsset = (args: { asset: AssetInfo; pageId: string; assetsDir: AbsoluteDirPath }) =>
  Effect.gen(function* () {
    const { asset, pageId, assetsDir } = args
    const fs = yield* FileSystem.FileSystem
    const http = yield* HttpClient.HttpClient

    const pageDir = EffectPath.ops.join(assetsDir, EffectPath.unsafe.relativeDir(`${pageId}/`))
    const dirExists = yield* fs.exists(pageDir)
    if (!dirExists) {
      yield* fs.makeDirectory(pageDir, { recursive: true })
    }

    const sanitizedName = asset.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const fileName = `${asset.blockId}-${sanitizedName}`
    const filePath = EffectPath.ops.join(pageDir, EffectPath.unsafe.relativeFile(fileName))

    const response = yield* http.get(asset.url)
    const body = yield* response.arrayBuffer
    yield* fs.writeFile(filePath, new Uint8Array(body))

    return { filePath, size: body.byteLength }
  }).pipe(
    Effect.withSpan('downloadAsset', {
      attributes: {
        'asset.blockId': args.asset.blockId,
        'asset.type': args.asset.blockType,
      },
    }),
  )

const dumpCommand = Command.make(
  'dump',
  {
    databaseId: databaseIdArg,
    output: outputOption,
    token: tokenOption,
    content: contentOption,
    depth: depthOption,
    assets: assetsOption,
    assetsDir: assetsDirOption,
    since: sinceOption,
    sinceLast: sinceLastOption,
    checkpoint: checkpointOption,
    filter: filterOption,
    tuiOutput: tuiOutputOption,
  },
  ({
    databaseId,
    output,
    token,
    content,
    depth,
    assets,
    assetsDir,
    since,
    sinceLast,
    checkpoint,
    filter,
    tuiOutput,
  }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)
      const fs = yield* FileSystem.FileSystem

      const configLayer = Layer.succeed(NotionConfig, {
        authToken: Redacted.make(resolvedToken),
      })

      yield* run(
        DumpApp,
        (tui) =>
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              tui.dispatch({ _tag: 'SetIntrospecting', databaseId })

              // Introspect database for schema
              const dbInfo = yield* introspectDatabase(databaseId)

              // Determine output paths
              const outputPath = output
              const schemaPath = output.replace(/\.ndjson$/, '') + '.schema.ts'
              const checkpointPath = Option.isSome(checkpoint) === true
                ? checkpoint.value
                : output.replace(/\.ndjson$/, '') + '.checkpoint.json'

              // Handle incremental dump
              let lastEditedFilter: string | undefined
              if (sinceLast) {
                const checkpointExists = yield* fs.exists(checkpointPath)
                if (checkpointExists) {
                  const checkpointContent = yield* fs.readFileString(checkpointPath)
                  const checkpointData = yield* Schema.decodeUnknown(
                    Schema.parseJson(CheckpointData),
                  )(checkpointContent)
                  lastEditedFilter = checkpointData.lastDumpedAt
                }
              } else if (Option.isSome(since) === true) {
                lastEditedFilter = since.value
              }

              // Build query options
              const queryFilter = Option.isSome(filter) === true
                ? parseSimpleFilter(filter.value)
                : undefined

              // Create combined filter if we have both time and property filters
              let combinedFilter: DatabaseFilter | undefined
              if (lastEditedFilter && queryFilter) {
                combinedFilter = {
                  and: [
                    {
                      timestamp: 'last_edited_time',
                      last_edited_time: { after: lastEditedFilter },
                    },
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

              // Generate TypeScript schema using existing codegen
              const dumpedAt = new Date().toISOString()
              const schemaCode = generateSchemaCode({
                dbInfo,
                schemaName: dbInfo.name,
                options: {
                  typedOptions: true,
                  schemaMeta: true,
                },
              })

              // Add dump metadata as export
              const schemaWithMeta = `${schemaCode}

// -----------------------------------------------------------------------------
// Dump Metadata
// -----------------------------------------------------------------------------

/** Metadata about when this dump was created */
export const DUMP_META = {
  databaseId: '${databaseId}',
  databaseName: '${dbInfo.name.replace(/'/g, "\\'")}',
  dumpedAt: '${dumpedAt}',
  options: {
    includeContent: ${content},
    contentDepth: ${Option.isSome(depth) === true ? depth.value : 'undefined'},
    includeAssets: ${assets},
  },
} as const
`

              yield* fs.writeFileString(schemaPath, schemaWithMeta)

              tui.dispatch({ _tag: 'SetFetching', dbName: dbInfo.name, outputPath })

              const outputFile = EffectPath.unsafe.absoluteFile(outputPath)
              const outputDir = EffectPath.ops.parent(outputFile)
              const resolvedAssetsDir: AbsoluteDirPath = Option.isSome(assetsDir) === true
                ? EffectPath.unsafe.absoluteDir(assetsDir.value)
                : EffectPath.ops.join(outputDir, EffectPath.unsafe.relativeDir('assets/'))

              // Ensure output directory exists
              const dirExists = yield* fs.exists(outputDir)
              if (!dirExists) {
                yield* fs.makeDirectory(outputDir, { recursive: true })
              }

              // Track statistics
              const lines: string[] = []
              let pageCount = 0
              let totalAssetsDownloaded = 0
              let totalAssetBytes = 0
              let totalAssetsSkipped = 0
              const failures: { pageId: string; blockId?: string; error: string }[] = []
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

                  // Fetch content blocks if --content flag is set
                  let contentBlocks: (typeof DumpPage.Type)['content'] = undefined
                  if (content) {
                    const blocksStream = NotionBlocks.retrieveAllNested({
                      blockId: page.id,
                      ...(Option.isSome(depth) === true ? { maxDepth: depth.value } : {}),
                      concurrency: 3,
                    })

                    const blocks = yield* Stream.runCollect(blocksStream).pipe(
                      Effect.map((chunk) => [...chunk]),
                      Effect.catchAll((error) => {
                        failures.push({ pageId: page.id, error: String(error) })
                        return Effect.succeed([] as BlockWithDepth[])
                      }),
                    )

                    // Convert to dump format
                    contentBlocks = blocks.map((b) => ({
                      block: b.block as Record<string, unknown>,
                      depth: b.depth,
                      parentId: b.parentId,
                    }))

                    // Handle assets
                    const pageAssets = extractAssetsFromBlocks(blocks)
                    if (pageAssets.length > 0) {
                      if (assets) {
                        // Download assets
                        for (const asset of pageAssets) {
                          const downloadResult = yield* downloadAsset({
                            asset,
                            pageId: page.id,
                            assetsDir: resolvedAssetsDir,
                          }).pipe(
                            Effect.map((r) => ({ success: true as const, ...r })),
                            Effect.catchAll((error) =>
                              Effect.succeed({
                                success: false as const,
                                error: String(error),
                                blockId: asset.blockId,
                              }),
                            ),
                          )

                          if (downloadResult.success) {
                            totalAssetsDownloaded++
                            totalAssetBytes += downloadResult.size
                          } else {
                            failures.push({
                              pageId: page.id,
                              blockId: downloadResult.blockId,
                              error: downloadResult.error,
                            })
                          }
                        }
                      } else {
                        // Track skipped assets
                        totalAssetsSkipped += pageAssets.length
                      }
                    }
                  }

                  const dumpPage: typeof DumpPage.Type = {
                    id: page.id,
                    url: page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`,
                    createdTime: page.created_time,
                    lastEditedTime: page.last_edited_time,
                    properties,
                    content: contentBlocks,
                  }

                  lines.push(encodeDumpPage(dumpPage))
                  pageCount++
                }

                // Dispatch page count update after each batch
                tui.dispatch({ _tag: 'AddPages', count: result.results.length })

                if (!result.hasMore || Option.isNone(result.nextCursor) === true) {
                  break
                }
                startCursor = result.nextCursor.value
              }

              // Write all lines to file
              yield* fs.writeFileString(
                outputPath,
                lines.join('\n') + (lines.length > 0 ? '\n' : ''),
              )

              // Write checkpoint with extended info
              const checkpointData = {
                lastDumpedAt: dumpedAt,
                pageCount,
                contentIncluded: content,
                ...(assets
                  ? {
                      assets: {
                        count: totalAssetsDownloaded,
                        totalBytes: totalAssetBytes,
                        directory: resolvedAssetsDir,
                      },
                    }
                  : {}),
                ...(failures.length > 0 ? { failures } : {}),
              }
              const checkpointJson = yield* Schema.encode(
                Schema.parseJson(CheckpointData, { space: 2 }),
              )(checkpointData)
              yield* fs.writeFileString(checkpointPath, checkpointJson)

              tui.dispatch({
                _tag: 'SetDone',
                assetsDownloaded: totalAssetsDownloaded,
                assetBytes: totalAssetBytes,
                assetsSkipped: totalAssetsSkipped,
                failures: failures.length,
              })
            })

            yield* program.pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  tui.dispatch({ _tag: 'SetError', message: String(error) })
                }),
              ),
              Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)),
            )
          }),
        { view: React.createElement(DumpView, { stateAtom: DumpApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(tuiOutput)))
    }),
).pipe(Command.withDescription('Dump a Notion database to NDJSON format with TypeScript schema'))

// -----------------------------------------------------------------------------
// Info Command
// -----------------------------------------------------------------------------

const infoCommand = Command.make(
  'info',
  { databaseId: databaseIdArg, token: tokenOption, output: tuiOutputOption },
  ({ databaseId, token, output }) =>
    Effect.gen(function* () {
      const resolvedToken = yield* resolveNotionToken(token)

      const configLayer = Layer.succeed(NotionConfig, {
        authToken: Redacted.make(resolvedToken),
      })

      yield* run(
        InfoApp,
        (tui) =>
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              const db = yield* NotionDatabases.retrieve({ databaseId })

              const properties = db.properties ?? {}
              const propertyList = Object.entries(properties).map(([propName, propValue]) => {
                const prop = propValue as { type: string; [key: string]: unknown }
                return { name: propName, type: prop.type }
              })

              // Get row count
              const result = yield* NotionDatabases.query({
                databaseId,
                pageSize: 1,
              })

              tui.dispatch({
                _tag: 'SetResult',
                dbName: db.title.map((t) => t.plain_text).join(''),
                dbId: db.id,
                dbUrl: db.url,
                properties: propertyList,
                rowCount: result.hasMore ? '100+' : String(result.results.length),
              })
            })

            yield* program.pipe(
              Effect.catchAll((error) =>
                Effect.sync(() => {
                  tui.dispatch({ _tag: 'SetError', message: String(error) })
                }),
              ),
              Effect.provide(Layer.merge(configLayer, FetchHttpClient.layer)),
            )
          }),
        { view: React.createElement(InfoView, { stateAtom: InfoApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
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
