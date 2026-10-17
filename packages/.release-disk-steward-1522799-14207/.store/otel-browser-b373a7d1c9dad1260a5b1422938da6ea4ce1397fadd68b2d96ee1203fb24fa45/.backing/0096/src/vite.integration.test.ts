import { Effect } from 'effect'
import { createServer } from 'vite'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { otlpDevProxy } from './vite.ts'

Vitest.describe('OTLP development proxy', () => {
  Vitest.it.live('forwards OTLP to the collector without application cookies', () =>
    Effect.gen(function* () {
      const received: Array<{
        path: string
        cookie: string | null
        contentType: string | null
        body: string
      }> = []
      const collector = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            async fetch(request) {
              received.push({
                path: new URL(request.url).pathname,
                cookie: request.headers.get('cookie'),
                contentType: request.headers.get('content-type'),
                body: await request.text(),
              })
              return new Response(null, { status: 202 })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const proxy = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = await createServer({
            configFile: false,
            // This server exercises HTTP relay only; it has no client modules to optimize.
            optimizeDeps: { noDiscovery: true, include: [] },
            plugins: [otlpDevProxy({ target: collector.url.toString() })],
            server: { host: '127.0.0.1', port: 0 },
          })
          await server.listen()
          return server
        }),
        (server) => Effect.promise(() => server.close()),
      )
      const address = proxy.httpServer?.address()
      if (address === undefined || address === null || typeof address === 'string') {
        return yield* Effect.die('Vite did not bind a TCP port')
      }
      const body = '{"resourceSpans":[]}'
      const response = yield* Effect.promise(() =>
        fetch(`http://127.0.0.1:${address.port}/otlp/v1/traces`, {
          method: 'POST',
          headers: { cookie: 'app_session=private', 'content-type': 'application/json' },
          body,
        }),
      )
      Vitest.expect(response.status).toBe(202)
      Vitest.expect(received).toEqual([
        { path: '/v1/traces', cookie: null, contentType: 'application/json', body },
      ])
    }).pipe(Effect.scoped),
  )
})
