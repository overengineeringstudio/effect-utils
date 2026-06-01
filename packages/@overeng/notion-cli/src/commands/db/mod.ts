/**
 * Database subcommand - database information plus Node-backed replica commands.
 */

import { Args, Command } from '@effect/cli'
import { FetchHttpClient } from '@effect/platform'
import { Effect, Layer, Redacted } from 'effect'
import type { Cause, Channel, Sink, Stream } from 'effect'
import type { NodeInspectSymbol } from 'effect/Inspectable'
import React from 'react'

import {
  makeDatasourceDbSubcommands,
  type DatasourceDbCommandHandler,
} from '@overeng/notion-datasource-sync/cli/effect-command'
import { outputOption as tuiOutputOption, outputModeLayer } from '@overeng/tui-react/node'

import { InfoApp } from '../../renderers/InfoOutput/app.ts'
import { InfoView } from '../../renderers/InfoOutput/view.tsx'

/** Re-export internal types for TypeScript declaration emit */
export type { Cause, Channel, Sink, Stream } from 'effect'
export type { NodeInspectSymbol } from 'effect/Inspectable'
export type { PlatformError } from '@effect/platform/Error'

import { NotionConfig, NotionDatabases, NotionDataSources } from '@overeng/notion-effect-client'
import { run } from '@overeng/tui-react'

import { resolveNotionToken, tokenOption } from '../schema/mod.ts'

const databaseIdArg = Args.text({ name: 'database-id' }).pipe(
  Args.withDescription('The Notion database ID to operate on'),
)

const runtimeUnavailableHandler: DatasourceDbCommandHandler = () =>
  Effect.sync(() => {
    process.stderr.write(
      'notion db sync/export/status commands require the packaged Nix/devenv Node-backed runtime because the SQLite sync implementation imports node:sqlite. Use `devenv shell` or the flake-built `notion` binary.\n',
    )
    process.exitCode = 1
  })

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

              // In API 2026-03-11, properties live on the data source.
              const dataSourceId = db.data_sources?.[0]?.id ?? databaseId
              const properties =
                db.data_sources?.[0]?.id !== undefined
                  ? (yield* NotionDataSources.retrieve({ dataSourceId })).properties
                  : (db.properties ?? {})
              const propertyList = Object.entries(properties).map(([propName, propValue]) => {
                const prop = propValue as { type: string; [key: string]: unknown }
                return { name: propName, type: prop.type }
              })
              const result = yield* NotionDatabases.query({
                dataSourceId,
                pageSize: 1,
              })

              tui.dispatch({
                _tag: 'SetResult',
                dbName: db.title.map((t) => t.plain_text).join(''),
                dbId: db.id,
                dbUrl: db.url,
                properties: propertyList,
                rowCount: result.hasMore === true ? '100+' : String(result.results.length),
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

/** Database operations subcommand. */
export const dbCommand = Command.make('db').pipe(
  Command.withSubcommands([infoCommand, ...makeDatasourceDbSubcommands(runtimeUnavailableHandler)]),
  Command.withDescription('Database operations and SQLite replica sync'),
)
