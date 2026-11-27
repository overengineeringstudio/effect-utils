import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { IrohNode, layerWasm, N0_RELAYS, type IrohWasmModule } from './IrohNode.ts'

const fakeWasm = ({
  homeRelay,
  close,
}: {
  homeRelay: () => Promise<unknown>
  close: () => void
}): IrohWasmModule => ({
  default: async () => undefined,
  spawnNode: async (relays) => {
    expect(relays).toBe(N0_RELAYS.join(','))
    expect(N0_RELAYS.every((relay) => !new URL(relay).hostname.endsWith('.'))).toBe(true)
    return {
      endpointId: () => 'ab'.repeat(32),
      homeRelay,
      accept: async () => null,
      connect: async () => null,
      close: async () => {
        close()
      },
    }
  },
})

describe('wasm node lifecycle', () => {
  it.effect('reports a rejected relay as a typed failure and closes the endpoint', () => {
    let closed = 0
    const layer = layerWasm({
      secretKey: new Uint8Array(32),
      load: async () =>
        fakeWasm({
          homeRelay: async () => {
            throw new Error('relay down')
          },
          close: () => {
            closed++
          },
        }),
    })
    return Effect.gen(function* () {
      const failure = yield* IrohNode.use((node) => node.homeRelay).pipe(
        Effect.flip,
        Effect.provide(layer),
      )
      expect(failure._tag).toBe('RelayUnreachable')
      expect(closed).toBe(1)
    })
  })

  it.effect('bounds a hanging relay lookup and releases its endpoint', () => {
    let closed = 0
    const layer = layerWasm({
      secretKey: new Uint8Array(32),
      homeRelayTimeout: '1 second',
      load: async () =>
        fakeWasm({
          homeRelay: () => new Promise(() => {}),
          close: () => {
            closed++
          },
        }),
    })
    return Effect.gen(function* () {
      const lookup = yield* IrohNode.use((node) => node.homeRelay).pipe(
        Effect.flip,
        Effect.provide(layer),
        Effect.forkScoped,
      )
      yield* TestClock.adjust('1 second')
      const failure = yield* Fiber.join(lookup)
      expect(failure._tag).toBe('RelayUnreachable')
      expect(closed).toBe(1)
    })
  })
})
