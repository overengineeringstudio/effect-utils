#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import * as Http from 'node:http'

import { NodeHttpServer, NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { HttpRouter, HttpServerResponse } from 'effect/http'

import { loadConfig } from './Config.ts'
import { makeRoutes } from './Proxy.ts'

const usage = `Usage: ai-gateway-edge serve --config <path> --bind <host:port> [--metrics-bind <host:port>]
       ai-gateway-edge hash-token (token from stdin)`
const option = (flag: string) => {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

const bind = (value: string) => {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value)
  if (!match || Number(match[2]) > 65535) throw new Error(`Invalid bind address: ${value}`)
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port: Number(match[2]) }
}

const main = Effect.gen(function* () {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
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
  if (command !== 'serve' || !option('--config') || !option('--bind')) {
    console.error(usage)
    process.exitCode = 2
    return
  }
  const config = yield* loadConfig(option('--config')!)
  const { router, metrics } = makeRoutes(config)
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

main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
