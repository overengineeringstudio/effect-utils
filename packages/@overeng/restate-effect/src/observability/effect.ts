import { Effect } from 'effect'

import type { OtelAttrEncodeError } from '@overeng/otel-contract'

import { restateOperation } from './contract.ts'

export const trustOtelContract = <A, E, R>(
  effect: Effect.Effect<A, E | OtelAttrEncodeError, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)))

export const withRestateOperation =
  (name: string, label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    trustOtelContract(effect.pipe(restateOperation(name).with({ label })))
