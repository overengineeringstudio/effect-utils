import { createServer, type Socket } from 'node:net'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, Option, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/process'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'
import { Otelite } from '@overeng/utils-dev/otelite'

import { makeOtelCliLayer, type OtelDeliveryEvent, ServiceIdentity } from './otel.ts'

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'delivery-cli',
  namespace: 'overeng.test',
  version: '1.0.0',
})
const fixture = fileURLToPath(new URL('./fixtures/otel-delivery.ts', import.meta.url))

/** A TCP black hole, not a replacement OTLP collector: never acknowledges an export. */
const blackHole = Effect.acquireRelease(
  Effect.promise(() => {
    const { promise, resolve, reject } = Promise.withResolvers<{
      endpoint: string
      close: () => Promise<void>
    }>()
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      socket.resume()
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no TCP port'))
      resolve({
        endpoint: `http://127.0.0.1:${address.port}`,
        close: () => {
          const closed = Promise.withResolvers<void>()
          for (const socket of sockets) socket.destroy()
          server.close(() => closed.resolve())
          return closed.promise
        },
      })
    })
    return promise
  }),
  (server) => Effect.promise(server.close),
)

const runCli = (endpoint: string, shutdownTimeout: number, fail = false) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const child = yield* spawner.spawn(
        ChildProcess.make('bun', [
          fixture,
          endpoint,
          String(shutdownTimeout),
          fail ? 'fail' : 'ok',
        ]),
      )
      return yield* Effect.all(
        {
          stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
          code: child.exitCode,
        },
        { concurrency: 'unbounded' },
      )
    }),
  )

Vitest.describe('makeOtelCliLayer delivery outcomes', () => {
  Vitest.it.effect('flushes the real final batch and reports healthy shutdown', () =>
    Effect.gen(function* () {
      const collector = yield* Otelite
      const cap = yield* collector.capture({})
      const events: OtelDeliveryEvent[] = []
      const result = yield* Effect.succeed('domain result').pipe(
        Effect.withSpan('delivery-root', { root: true, attributes: { 'span.label': 'delivery' } }),
        Effect.provide(
          makeOtelCliLayer({
            identity,
            endpoint: Option.some(cap.endpoints.http),
            exportInterval: 60_000,
            shutdownTimeout: 4000,
            onDeliveryEvent: (event) => events.push(event),
          }),
        ),
      )
      expect(result).toBe('domain result')
      expect(events).toContainEqual({ _tag: 'BatchSucceeded', signal: 'traces' })
      expect(events.some((event) => event._tag === 'BatchFailed')).toBe(false)
      expect(events.filter((event) => event._tag === 'Shutdown')).toHaveLength(3)
      expect(events.some((event) => event._tag === 'Shutdown' && event.timedOut)).toBe(false)
      expect(yield* cap.inspect({ signal: 'traces', name: 'delivery-root' })).toHaveLength(1)
    }).pipe(Effect.provide(Layer.provideMerge(Otelite.layer, NodeServices.layer))),
  )

  Vitest.it.effect('keeps stdout and the domain exit code when the collector is unavailable', () =>
    Effect.gen(function* () {
      const collector = yield* Otelite
      // Obtain a real collector endpoint, then stop that collector before sending.
      const endpoint = yield* Effect.scoped(
        collector.capture({}).pipe(Effect.map((cap) => cap.endpoints.http)),
      )
      for (const fail of [false, true]) {
        const result = yield* runCli(`${endpoint}/private-token`, 5000, fail)
        expect(result.stdout).toBe('{"ok":true}\n')
        expect(result.code).toBe(fail ? 1 : 0)
        expect(result.stderr).toContain('OTEL warning: traces batch lost (Transport).')
        expect(result.stderr).not.toContain('private-token')
        expect(result.stderr).not.toContain(endpoint)
      }
    }).pipe(Effect.provide(Layer.provideMerge(Otelite.layer, NodeServices.layer))),
  )

  Vitest.it.effect(
    'reports a real shutdown timeout without changing stdout or successful exit',
    () =>
      Effect.gen(function* () {
        const server = yield* blackHole
        const result = yield* runCli(`${server.endpoint}/private-token`, 100).pipe(
          Effect.timeout('10 seconds'),
        )
        expect(result.stdout).toBe('{"ok":true}\n')
        expect(result.code).toBe(0)
        expect(result.stderr).toContain(
          'OTEL warning: traces shutdown timed out; telemetry may be lost.',
        )
        expect(result.stderr).not.toContain('private-token')
        expect(result.stderr).not.toContain(server.endpoint)
      }).pipe(Effect.provide(NodeServices.layer)),
  )
})
