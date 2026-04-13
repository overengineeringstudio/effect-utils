import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'

import { Cause, Effect, Exit, Stream } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createTerminalInput } from '../../src/effect/TerminalInput.ts'

class FakeTtyInput extends EventEmitter {
  isTTY = true
  isRaw = false

  readonly pause = vi.fn()
  readonly resume = vi.fn()
  readonly setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode
  })

  emitData(data: Buffer): void {
    this.emit('data', data)
  }
}

describe('createTerminalInput', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('publishes Ctrl+C so consumers can interrupt their fiber', async () => {
    const input = new FakeTtyInput()
    const offSpy = vi.spyOn(input, 'off')

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const terminalInput = yield* createTerminalInput({
            input: input as unknown as Readable,
            output: { isTTY: false } as never,
            handleResize: false,
          })

          const fiber = yield* terminalInput.events.pipe(
            Stream.runForEach((event) => {
              if (event._tag === 'Event.Key' && event.ctrl === true && event.key === 'c') {
                return Effect.interrupt
              }

              return Effect.void
            }),
            Effect.fork,
          )

          yield* Effect.yieldNow()
          input.emitData(Buffer.from([0x03]))

          const fiberExit = yield* fiber.await
          expect(Exit.isFailure(fiberExit)).toBe(true)
          if (Exit.isFailure(fiberExit)) {
            expect(Cause.isInterruptedOnly(fiberExit.cause)).toBe(true)
          }
        }),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)

    expect(input.setRawMode).toHaveBeenCalledTimes(2)
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false)
    expect(input.isRaw).toBe(false)
    offSpy.mockRestore()
  })

  it('preserves an already-raw terminal on cleanup', async () => {
    const input = new FakeTtyInput()
    input.isRaw = true

    const terminalInput = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          return yield* createTerminalInput({
            input: input as unknown as Readable,
            output: { isTTY: false } as never,
            handleResize: false,
          })
        }),
      ),
    )

    expect(input.setRawMode).not.toHaveBeenCalled()
    expect(input.isRaw).toBe(true)
    expect(terminalInput.isRawMode).toBe(true)
  })
})
