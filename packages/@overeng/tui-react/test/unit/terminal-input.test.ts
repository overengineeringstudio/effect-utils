import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'

import { Effect } from 'effect'
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

  it('restores terminal state before exiting on Ctrl+C', async () => {
    const input = new FakeTtyInput()
    const offSpy = vi.spyOn(input, 'off')
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      expect(code).toBe(130)
      expect(offSpy).toHaveBeenCalledWith('data', expect.any(Function))
      expect(input.pause).toHaveBeenCalledOnce()
      expect(input.setRawMode).toHaveBeenCalledWith(false)
      throw new Error('exit')
    }) as never)

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* createTerminalInput({
              input: input as unknown as Readable,
              output: { isTTY: false } as never,
              handleResize: false,
            })

            input.emitData(Buffer.from([0x03]))
          }),
        ),
      ),
    ).rejects.toThrow('exit')

    expect(input.setRawMode).toHaveBeenCalledTimes(2)
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false)
    expect(input.isRaw).toBe(false)

    exitSpy.mockRestore()
    offSpy.mockRestore()
  })

  it('preserves an already-raw terminal on cleanup', async () => {
    const input = new FakeTtyInput()
    input.isRaw = true

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* createTerminalInput({
            input: input as unknown as Readable,
            output: { isTTY: false } as never,
            handleResize: false,
          })
        }),
      ),
    )

    expect(input.setRawMode).not.toHaveBeenCalled()
    expect(input.isRaw).toBe(true)
  })
})
