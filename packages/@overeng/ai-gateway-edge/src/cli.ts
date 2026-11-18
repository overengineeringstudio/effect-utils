#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import * as Http from 'node:http'

import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Cause, Effect, Layer } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

import { CliVersion, resolveCliBuildIdentity } from '@overeng/utils/node/cli-version'

import packageJson from '../package.json' with { type: 'json' }
import { loadConfig } from './Config.ts'
import { makeRoutes } from './Proxy.ts'

const cliIdentity = resolveCliBuildIdentity({
  baseVersion: packageJson.version,
  buildStamp: '__CLI_BUILD_STAMP__',
})

const usage = `Usage: ai-gateway-edge serve --config <path> --bind <host:port> [--metrics-bind <host:port>]
       ai-gateway-edge hash-token (token from stdin)
       ai-gateway-edge --version`
const option = (flag: string) => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const bind = (value: string) => {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value)
  if (match === null || Number(match[2]) > 65535) throw new Error(`Invalid bind address: ${value}`)
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port: Number(match[2]) }
}

const main = Effect.gen(function* () {
  if (process.argv.length === 3 && process.argv[2] === '--version') {
    console.log(cliIdentity.displayVersion)
    return
  }
  if (process.argv.includes('--help') === true || process.argv.includes('-h') === true) {
    console.log(usage)
    return
  }
  const command = process.argv[2]
  if (command === 'hash-token') {
    const token = (yield* Effect.promise(async () => {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    })).replace(/\r?\n$/, '')
    console.log(createHash('sha256').update(token).digest('hex'))
    return
  }
  if (
    command !== 'serve' ||
    option('--config') === undefined ||
    option('--config') === '' ||
    option('--bind') === undefined ||
    option('--bind') === ''
  ) {
    const suffix = yield* CliVersion.suffix
    console.error(`${usage}${suffix}`)
    process.exitCode = 2
    return
  }
  const config = yield* loadConfig(option('--config')!)
  const { router, metrics } = makeRoutes({ config: config })
  const address = bind(option('--bind')!)
  const app = HttpRouter.serve(router, { disableLogger: true, disableListenLog: true }).pipe(
    Layer.provide(NodeHttpServer.layer(() => Http.createServer(), address)),
  )
  const metricsAddress = option('--metrics-bind')
  const metricsLayer =
    metricsAddress === undefined
      ? Layer.empty
      : HttpRouter.serve(
          HttpRouter.addAll([
            HttpRouter.route(
              'GET',
              '/metrics',
              Effect.sync(() =>
                HttpServerResponse.text(metrics.render(), {
                  contentType: 'text/plain; version=0.0.4; charset=utf-8',
                }),
              ),
            ),
          ]),
          { disableLogger: true, disableListenLog: true },
        ).pipe(Layer.provide(NodeHttpServer.layer(() => Http.createServer(), bind(metricsAddress))))
  yield* Effect.log(`ai-gateway-edge listening on ${option('--bind')}`)
  return yield* Layer.launch(Layer.mergeAll(app, metricsLayer))
})

main.pipe(
  Effect.tapCause((cause) =>
    Cause.hasInterruptsOnly(cause) === true
      ? Effect.void
      : Effect.gen(function* () {
          const suffix = yield* CliVersion.suffix
          yield* Effect.logError(cause, suffix)
        }),
  ),
  Effect.provideService(CliVersion, {
    name: 'ai-gateway-edge',
    version: cliIdentity.displayVersion,
  }),
  Effect.provide(NodeServices.layer),
  Effect.annotateLogs({ 'service.version': cliIdentity.machineVersion }),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
