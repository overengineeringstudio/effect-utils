/**
 * Tests for LogCapture - automatic log capture for progressive-visual TUI modes.
 */

import { it } from '@effect/vitest'
import { Chunk, Effect, Fiber, Stream } from 'effect'
import { describe, expect, beforeEach, afterEach } from 'vitest'

import { createLogCapture } from '../../src/effect/LogCapture.ts'
import type { LogCaptureHandle } from '../../src/effect/LogCapture.ts'
import { testModeLayer } from '../../src/effect/testing.tsx'
import type { TuiLogEntry } from '../../src/effect/TuiLogger.ts'
import { createTuiApp } from '../../src/mod.tsx'

/**
 * Wait for captured logs to satisfy a predicate by subscribing to ref.changes.
 * Deterministic — completes as soon as the condition is met, no sleeps.
 */
const awaitLogs = (
  handle: LogCaptureHandle,
  predicate: (logs: readonly TuiLogEntry[]) => boolean,
): Effect.Effect<readonly TuiLogEntry[]> =>
  handle.logsRef.changes.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runCollect,
    Effect.map((chunk) => Chunk.unsafeGet(chunk, 0)),
  )

// =============================================================================
// createLogCapture Tests
// =============================================================================

describe('createLogCapture', () => {
  let originalLog: typeof console.log
  let originalError: typeof console.error
  let originalWarn: typeof console.warn
  let originalInfo: typeof console.info
  let originalDebug: typeof console.debug

  beforeEach(() => {
    originalLog = console.log
    originalError = console.error
    originalWarn = console.warn
    originalInfo = console.info
    originalDebug = console.debug
  })

  afterEach(() => {
    // Ensure console methods are restored even if a test fails
    console.log = originalLog
    console.error = originalError
    console.warn = originalWarn
    console.info = originalInfo
    console.debug = originalDebug
  })

  it.live('captures Effect.log output', () =>
    Effect.gen(function* () {
      const { handle, loggerLayer } = yield* createLogCapture()

      const fiber = yield* Effect.fork(awaitLogs(handle, (logs) => logs.length >= 1))

      yield* Effect.log('hello from effect').pipe(Effect.provide(loggerLayer))

      const logs = yield* Fiber.join(fiber)
      expect(logs).toHaveLength(1)
      expect(logs[0]!.message).toBe('hello from effect')
      expect(logs[0]!.level).toBe('INFO')
    }).pipe(Effect.scoped),
  )

  it.live('captures console.log', () =>
    Effect.gen(function* () {
      const { handle } = yield* createLogCapture()

      const fiber = yield* Effect.fork(
        awaitLogs(handle, (logs) => logs.some((l) => l.message === 'hello from console')),
      )

      console.log('hello from console')

      const logs = yield* Fiber.join(fiber)
      expect(logs.some((l) => l.message === 'hello from console')).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.live('captures console.error', () =>
    Effect.gen(function* () {
      const { handle } = yield* createLogCapture()

      const fiber = yield* Effect.fork(
        awaitLogs(handle, (logs) => logs.some((l) => l.message === 'error message')),
      )

      console.error('error message')

      const logs = yield* Fiber.join(fiber)
      const errorLog = logs.find((l) => l.message === 'error message')
      expect(errorLog).toBeDefined()
      expect(errorLog!.level).toBe('ERROR')
    }).pipe(Effect.scoped),
  )

  it.live('captures console.warn', () =>
    Effect.gen(function* () {
      const { handle } = yield* createLogCapture()

      const fiber = yield* Effect.fork(
        awaitLogs(handle, (logs) => logs.some((l) => l.message === 'warning message')),
      )

      console.warn('warning message')

      const logs = yield* Fiber.join(fiber)
      const warnLog = logs.find((l) => l.message === 'warning message')
      expect(warnLog).toBeDefined()
      expect(warnLog!.level).toBe('WARNING')
    }).pipe(Effect.scoped),
  )

  it.live('captures console.info and console.debug', () =>
    Effect.gen(function* () {
      const { handle } = yield* createLogCapture()

      const fiber = yield* Effect.fork(
        awaitLogs(
          handle,
          (logs) =>
            logs.some((l) => l.message === 'info message') &&
            logs.some((l) => l.message === 'debug message'),
        ),
      )

      console.info('info message')
      console.debug('debug message')

      const logs = yield* Fiber.join(fiber)
      expect(logs.some((l) => l.message === 'info message' && l.level === 'INFO')).toBe(true)
      expect(logs.some((l) => l.message === 'debug message' && l.level === 'DEBUG')).toBe(true)
    }).pipe(Effect.scoped),
  )

  it.live('restores console methods after scope closes', () =>
    Effect.gen(function* () {
      const beforeLog = console.log

      yield* Effect.gen(function* () {
        yield* createLogCapture()
        // console.log is now the capturing version
        expect(console.log).not.toBe(beforeLog)
      }).pipe(Effect.scoped)

      // After scope closes, console.log should be restored
      expect(console.log).toBe(beforeLog)
    }),
  )

  it.live('respects maxEntries limit', () =>
    Effect.gen(function* () {
      const { handle } = yield* createLogCapture({ maxEntries: 3 })

      const fiber = yield* Effect.fork(
        awaitLogs(handle, (logs) => logs.some((l) => l.message === 'five')),
      )

      console.log('one')
      console.log('two')
      console.log('three')
      console.log('four')
      console.log('five')

      const logs = yield* Fiber.join(fiber)
      expect(logs.length).toBeLessThanOrEqual(3)
      // Most recent entries should be kept
      const messages = logs.map((l) => l.message)
      expect(messages).toContain('five')
    }).pipe(Effect.scoped),
  )

  it.live('does not print captured Effect.log to stdout', () => {
    const printed: string[] = []

    return Effect.gen(function* () {
      const { handle, loggerLayer } = yield* createLogCapture()

      // Replace console.log with a tracker (after capture has already replaced it)
      const capturedConsoleLog = console.log
      console.log = (...args: unknown[]) => {
        printed.push(args.map(String).join(' '))
        capturedConsoleLog(...args)
      }

      const fiber = yield* Effect.fork(
        awaitLogs(handle, (logs) => logs.some((l) => l.message === 'should not print')),
      )

      yield* Effect.log('should not print').pipe(Effect.provide(loggerLayer))
      yield* Fiber.join(fiber)
    })
      .pipe(Effect.scoped)
      .pipe(
        Effect.andThen(() => {
          // The Effect.log message should not appear as direct stdout output
          expect(printed.filter((p) => p.includes('should not print'))).toHaveLength(0)
        }),
      )
  })
})

// =============================================================================
// Integration with outputModeLayer
// =============================================================================

describe('log capture integration', () => {
  let originalLog: typeof console.log
  let capturedOutput: string[]

  beforeEach(() => {
    originalLog = console.log
    capturedOutput = []
    console.log = (msg: string) => {
      capturedOutput.push(msg)
    }
  })

  afterEach(() => {
    console.log = originalLog
  })

  it.effect('json mode is unaffected by log capture', () =>
    Effect.gen(function* () {
      const Schema = yield* Effect.promise(() => import('effect').then((m) => m.Schema))
      const App = createTuiApp({
        stateSchema: Schema.Struct({ count: Schema.Number }),
        actionSchema: Schema.Union(Schema.TaggedStruct('Inc', {})),
        initial: { count: 0 },
        reducer: ({ state, action }) => {
          switch (action._tag) {
            case 'Inc':
              return { count: state.count + 1 }
          }
        },
      })

      const tui = yield* App.run()
      tui.dispatch({ _tag: 'Inc' })
    }).pipe(
      Effect.scoped,
      Effect.provide(testModeLayer('json')),
      Effect.andThen(() => {
        // JSON mode should still output to console.log (our captured output)
        expect(capturedOutput).toHaveLength(1)
        const output = JSON.parse(capturedOutput[0]!)
        expect(output).toEqual({ _tag: 'Success', count: 1 })
      }),
    ),
  )
})
