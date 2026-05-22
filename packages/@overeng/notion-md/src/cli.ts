#!/usr/bin/env bun

import { FetchHttpClient } from '@effect/platform'
import { NodeRuntime } from '@effect/platform-node'
import { Console, Effect, Layer, Redacted } from 'effect'

import { NotionConfigLive } from '@overeng/notion-effect-client'

import { NmdCliError, NmdTokenMissingError } from './errors.ts'
import { NotionMdGatewayLive } from './live.ts'
import { pullPage, pushPage, statusPage } from './sync.ts'

const usage = `notion-md <command>

Commands:
  pull <page-id> --out <file.nmd>
  status <file.nmd>
  push <file.nmd> [--force]

Environment:
  NOTION_TOKEN or NOTION_API_TOKEN
`

const argAfter = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

const requireArg = (value: string | undefined, message: string) =>
  value !== undefined && value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(new NmdCliError({ message }))

const resolveToken = Effect.sync(
  () => process.env.NOTION_TOKEN ?? process.env.NOTION_API_TOKEN,
).pipe(
  Effect.flatMap((token) =>
    token !== undefined && token.length > 0
      ? Effect.succeed(token)
      : Effect.fail(
          new NmdTokenMissingError({
            message: 'NOTION_TOKEN or NOTION_API_TOKEN is required',
          }),
        ),
  ),
)

const program = Effect.gen(function* () {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === undefined || command === '--help' || command === '-h') {
    yield* Console.log(usage)
    return
  }

  switch (command) {
    case 'pull': {
      const pageId = yield* requireArg(args[1], 'pull requires <page-id>')
      const outPath = yield* requireArg(argAfter(args, '--out'), 'pull requires --out <file.nmd>')
      const result = yield* pullPage({ pageId, outPath })
      yield* Console.log(JSON.stringify(result, null, 2))
      return
    }
    case 'status': {
      const path = yield* requireArg(args[1], 'status requires <file.nmd>')
      const result = yield* statusPage({ path })
      yield* Console.log(JSON.stringify(result, null, 2))
      return
    }
    case 'push': {
      const path = yield* requireArg(args[1], 'push requires <file.nmd>')
      const result = yield* pushPage({ path, force: args.includes('--force') })
      yield* Console.log(JSON.stringify(result, null, 2))
      return
    }
    default:
      return yield* new NmdCliError({ message: `Unknown command: ${command}` })
  }
})

const MainLayer = Layer.unwrapEffect(
  resolveToken.pipe(
    Effect.map((token) => {
      const baseLayer = Layer.mergeAll(
        NotionConfigLive({ authToken: Redacted.make(token) }),
        FetchHttpClient.layer,
      )

      return Layer.mergeAll(baseLayer, NotionMdGatewayLive.pipe(Layer.provide(baseLayer)))
    }),
  ),
)

program.pipe(
  Effect.provide(MainLayer),
  Effect.tapError((error) => Console.error(JSON.stringify(error, null, 2))),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
