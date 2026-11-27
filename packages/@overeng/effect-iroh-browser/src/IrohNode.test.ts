import { describe, expect, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { IrohNode, layerWasm, N0_RELAYS, type IrohWasmModule } from './IrohNode.ts'

const fakeWasm = ({
  homeRelay,
  networkChange,
  close,
}: {
  homeRelay: () => Promise<unknown>
  networkChange: () => Promise<void>
  close: () => void
}): IrohWasmModule => ({
  default: async () => undefined,
  spawnNode: async (relays) => {
    expect(relays).toBe(N0_RELAYS.join(','))
    expect(N0_RELAYS.every((relay) => !new URL(relay).hostname.endsWith('.'))).toBe(true)
    return {
      endpointId: () => 'ab'.repeat(32),
      homeRelay,
      networkChange,
      accept: async () => null,
      connect: async () => null,
      close: async () => {
        close()
      },
    }
  },
})

describe('wasm node lifecycle', () => {
  it.effect('exposes an awaitable network-change hook without replacing the endpoint', () => {
    let changes = 0
    let closed = 0
    const layer = layerWasm({
      secretKey: new Uint8Array(32),
      load: async () =>
        fakeWasm({
          homeRelay: async () => 'https://relay.test',
          networkChange: async () => {
            changes++
          },
          close: () => {
            closed++
          },
        }),
    })
    return Effect.gen(function* () {
      yield* IrohNode.use((node) =>
        Effect.gen(function* () {
          const endpointId = node.endpointId
          yield* node.networkChange
          yield* node.networkChange
          expect(changes).toBe(2)
          expect(node.endpointId).toBe(endpointId)
          expect(closed).toBe(0)
        }),
      ).pipe(Effect.provide(layer))
      expect(closed).toBe(1)
    })
  })

  it.effect('reports a rejected relay as a typed failure and closes the endpoint', () => {
    let closed = 0
    const layer = layerWasm({
      secretKey: new Uint8Array(32),
      load: async () =>
        fakeWasm({
          homeRelay: async () => {
            throw new Error('relay down')
          },
          networkChange: async () => undefined,
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
          networkChange: async () => undefined,
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
