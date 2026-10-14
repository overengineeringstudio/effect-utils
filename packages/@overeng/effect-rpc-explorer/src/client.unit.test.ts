import { describe, it } from '@effect/vitest'
import { Duration, Effect, Exit, Schema, Scope } from 'effect'
import { Rpc, RpcGroup } from 'effect/rpc'
import { expect } from 'vitest'

import { makeExplorerClient } from './client.ts'
import { makeExplorer } from './explorer.ts'
import { defaultNormalizationBounds } from './policy.ts'

const application = RpcGroup.make(
  Rpc.make('Echo', { payload: Schema.String, success: Schema.String }),
)
const config = {
  instanceId: 'local-client',
  telemetry: {
    registerRetainedGauge: () => () => {},
    registerNormalizationHistogram: () => () => {},
  },
  bounds: {
    active: { maxCount: 16, maxAge: Duration.seconds(10) },
    completed: { maxCount: 16, maxAge: Duration.seconds(10) },
    deltas: { maxCount: 16, maxAge: Duration.seconds(10) },
    normalized: defaultNormalizationBounds,
    streamValuesPerRecord: 16,
    subscriberQueue: 16,
  },
}

describe('local explorer client', () => {
  it.effect('preserves snapshot, watch and clear frames without observing inspector traffic', () =>
    Effect.gen(function* () {
      const explorer = yield* makeExplorer({ group: application, config })
      const client = yield* makeExplorerClient({ inspector: explorer.inspector })
      const snapshot = yield* Effect.promise(() => client.getSnapshot())
      expect(snapshot).toMatchObject({
        _tag: 'Snapshot',
        active: [],
        completed: [],
        revision: 0,
        descriptorRevision: 0,
      })
      const iterator = client.watch({})[Symbol.asyncIterator]()
      const initial = yield* Effect.promise(() => iterator.next())
      expect(initial.value).toEqual(snapshot)
      const clear = yield* Effect.promise(() => client.clearHistory())
      expect(clear).toHaveProperty('clearedRevision')
      const reset = yield* Effect.promise(() => iterator.next())
      expect(reset.value).toMatchObject({ _tag: 'Reset' })
      yield* Effect.promise(async () => {
        await iterator.return?.()
      })
      expect(explorer.store.snapshot().active).toHaveLength(0)
      expect(explorer.store.snapshot().completed).toHaveLength(0)
    }).pipe(Effect.scoped),
  )

  it.effect('scope close cancels a pending watch and rejects released unary operations', () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      const explorer = yield* Scope.provide(makeExplorer({ group: application, config }), scope)
      const client = yield* Scope.provide(
        makeExplorerClient({ inspector: explorer.inspector }),
        scope,
      )
      const iterator = client.watch({})[Symbol.asyncIterator]()
      yield* Effect.promise(() => iterator.next())
      const pending = iterator.next()
      yield* Scope.close(scope, Exit.void)
      const result = yield* Effect.promise(() => pending)
      expect(result.done).toBe(true)
      yield* Effect.promise(async () => {
        await expect(client.getSnapshot()).rejects.toBeDefined()
      })
      const after = client.watch({})[Symbol.asyncIterator]()
      expect((yield* Effect.promise(() => after.next())).done).toBe(true)
    }),
  )
})
