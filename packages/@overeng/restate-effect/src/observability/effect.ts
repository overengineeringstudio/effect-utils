import { Effect } from 'effect'

import type { OtelAttrEncodeError } from '@overeng/otel-contract'

import { restateOperation } from './contract.ts'

const trustOtelContract = <A, E, R>(
  effect: Effect.Effect<A, E | OtelAttrEncodeError, R>,
): Effect.Effect<A, E, R> =>
  effect.pipe(Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)))

/**
 * Wrap an Effect in a named Restate operation span carrying a single `label`
 * (the `span.label` Grafana convention), turning the otel-contract's
 * `OtelAttrEncodeError` into a defect so the handler's `E` channel stays clean —
 * the shared seam every durable combinator/runtime/reschedule step spans through.
 */
export const withRestateOperation =
  (name: string, label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    trustOtelContract(effect.pipe(restateOperation(name).with({ label })))
