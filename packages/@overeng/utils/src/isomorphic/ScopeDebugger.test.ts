import { Chunk, Effect, Layer, Logger, LogLevel, Ref, Runtime } from 'effect'
import { describe, expect, it } from 'vitest'

import { addTracedFinalizer, withScopeDebug, withTracedScope } from './ScopeDebugger.ts'

/** Test logger that captures log messages at all levels */
const makeTestLogger = () =>
  Effect.gen(function* () {
    const logs = yield* Ref.make<Chunk.Chunk<string>>(Chunk.empty())
    const runtime = yield* Effect.runtime<never>()

    const logger = Logger.make<unknown, void>(({ message }) => {
      const msg = Array.isArray(message) ? message.join(' ') : String(message)
      Runtime.runSync(runtime)(Ref.update(logs, Chunk.append(msg)))
    })

    const getLogs = Ref.get(logs).pipe(Effect.map(Chunk.toArray))

    // Combine the custom logger with enabling all log levels
    const loggerLayer = Layer.merge(
      Logger.replace(Logger.defaultLogger, logger),
      Logger.minimumLogLevel(LogLevel.All),
    )

    return { logger, getLogs, loggerLayer } as const
  })

describe('ScopeDebugger', () => {
  describe('addTracedFinalizer', () => {
    it('logs finalizer registration and execution when debugging enabled', async () => {
      const program = Effect.gen(function* () {
        const { getLogs, loggerLayer } = yield* makeTestLogger()

        yield* withScopeDebug(
          Effect.gen(function* () {
            yield* addTracedFinalizer('test-cleanup', Effect.log('Cleaning up'))
            yield* Effect.log('Doing work')
          }).pipe(Effect.scoped),
        ).pipe(Effect.provide(loggerLayer))

        return yield* getLogs
      })

      const logs = await Effect.runPromise(program)

      expect(logs.some((l) => l.includes('Finalizer registered: test-cleanup'))).toBe(true)
      expect(logs.some((l) => l.includes('Finalizer starting: test-cleanup'))).toBe(true)
      expect(logs.some((l) => l.includes('Finalizer completed: test-cleanup'))).toBe(true)
    })

    it('does not log when debugging disabled', async () => {
      const program = Effect.gen(function* () {
        const { getLogs, loggerLayer } = yield* makeTestLogger()

        yield* Effect.gen(function* () {
          yield* addTracedFinalizer('test-cleanup', Effect.log('Cleaning up'))
          yield* Effect.log('Doing work')
        }).pipe(
          // Note: no withScopeDebug()
          Effect.scoped,
          Effect.provide(loggerLayer),
        )

        return yield* getLogs
      })

      const logs = await Effect.runPromise(program)

      expect(logs.some((l) => l.includes('Finalizer registered'))).toBe(false)
      expect(logs.some((l) => l.includes('Finalizer starting'))).toBe(false)
      // But the actual finalizer still runs
      expect(logs.some((l) => l.includes('Cleaning up'))).toBe(true)
    })

    it('executes finalizers in reverse registration order', async () => {
      const program = Effect.gen(function* () {
        const order = yield* Ref.make<string[]>([])

        yield* withScopeDebug(
          Effect.gen(function* () {
            yield* addTracedFinalizer(
              'first',
              Ref.update(order, (arr) => [...arr, 'first']),
            )
            yield* addTracedFinalizer(
              'second',
              Ref.update(order, (arr) => [...arr, 'second']),
            )
            yield* addTracedFinalizer(
              'third',
              Ref.update(order, (arr) => [...arr, 'third']),
            )
          }).pipe(Effect.scoped),
        )

        return yield* Ref.get(order)
      })

      const order = await Effect.runPromise(program)

      // Finalizers run in reverse order (LIFO)
      expect(order).toEqual(['third', 'second', 'first'])
    })
  })

  describe('withTracedScope', () => {
    it('logs scope lifecycle', async () => {
      const program = Effect.gen(function* () {
        const { getLogs, loggerLayer } = yield* makeTestLogger()

        yield* withTracedScope('my-scope')(Effect.log('Inside scope')).pipe(
          Effect.provide(loggerLayer),
        )

        return yield* getLogs
      })

      const logs = await Effect.runPromise(program)

      expect(logs.some((l) => l.includes('Traced scope starting: my-scope'))).toBe(true)
      expect(logs.some((l) => l.includes('Inside scope'))).toBe(true)
      expect(logs.some((l) => l.includes('Traced scope closing: my-scope'))).toBe(true)
    })
  })
})
