import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { expect } from 'vitest'

import { PoolControllerRequest } from './store-pool-controller.ts'

const decode = Schema.decodeUnknownEffect(PoolControllerRequest, { onExcessProperty: 'error' })

// Pure wire metadata only; these assertions are not physical custody, native
// holder, child lifetime, reset or service qualification evidence.
describe('physical pool request envelope', () => {
  for (const request of [
    { operation: 'warm' },
    { operation: 'run', id: 'owned-slot', tasks: ['check:quick', 'buck2.test'] },
    { operation: 'reset', id: 'owned-slot', mode: 'warm' },
    { operation: 'reset', id: 'owned-slot', mode: 'wiped' },
  ]) {
    it.effect(`decodes explicit ${request.operation} metadata`, () => Effect.gen(function* () {
      expect(yield* decode(request)).toEqual(request)
    }))
  }
  for (const request of [
    { operation: 'adopt', id: 'old-root' },
    { operation: 'retire', id: 'old-root' },
    { operation: 'run', id: 'owned-slot', tasks: [] },
    { operation: 'run', id: 'owned-slot', tasks: ['--unsafe'] },
    { operation: 'run', id: 'owned-slot', tasks: ['check;exit'] },
    { operation: 'run', id: 'owned-slot', tasks: ['check'], command: '/bin/sh' },
    { operation: 'reset', id: 'owned-slot', mode: 'recursive-delete' },
    { operation: 'reset', id: 'owned-slot', mode: 'warm', commit: 'other' },
    { operation: 'warm', qualified: true },
  ]) {
    it.effect(`rejects unsupported request ${JSON.stringify(request)}`, () => Effect.gen(function* () {
      const failure = yield* decode(request).pipe(Effect.flip)
      expect(failure).toBeDefined()
    }))
  }
})
