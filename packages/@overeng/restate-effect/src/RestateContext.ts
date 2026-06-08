import type * as restate from '@restatedev/restate-sdk'
import { Context, Effect, Runtime } from 'effect'

import { RestateError } from './RestateError.ts'

/**
 * The per-invocation Restate `Context`, provided as a `Context.Tag` service.
 *
 * This is bound to a single invocation/journal, so it is provided *per call*
 * at the handler boundary (see `Endpoint.materialize`) — never placed in the
 * long-lived application `Layer`. Handlers that need durable operations carry
 * `RestateContext` in their `R` and `yield* RestateContext` to reach the raw
 * SDK context.
 */
export class RestateContext extends Context.Tag('@overeng/restate-effect/RestateContext')<
  RestateContext,
  restate.Context
>() {}

/**
 * A durable side-effect step backed by `ctx.run(name, …)`. Restate journals the
 * result so it is replayed (not re-executed) on subsequent attempts.
 *
 * The inner Effect is executed via the *captured* per-invocation runtime
 * (`Runtime.runPromise`), so any of its requirements `R` are satisfied from the
 * surrounding handler scope and nested `ctx.*` calls are structurally avoided
 * inside the durable closure.
 *
 * Rejections (including a give-up after `ctx.run`'s own retries) surface as a
 * `RestateError({ reason: 'RunFailed' })` defect channel value — i.e. the
 * wrapper's failure, distinct from the user's domain `E`.
 */
export const run = <A, E, R>(
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, RestateError, R | RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    const runtime = yield* Effect.runtime<R>()
    return yield* Effect.tryPromise({
      try: () => ctx.run(name, () => Runtime.runPromise(runtime)(effect)),
      catch: (cause) => new RestateError({ reason: 'RunFailed', method: `run(${name})`, cause }),
    })
  }).pipe(Effect.withSpan('restate.run', { attributes: { 'span.label': name } }))

/**
 * A durable timer backed by `ctx.sleep`. The duration is a lower bound; the
 * timer survives suspension and process restarts.
 */
export const sleep = (
  millis: number,
  name?: string,
): Effect.Effect<void, RestateError, RestateContext> =>
  Effect.gen(function* () {
    const ctx = yield* RestateContext
    yield* Effect.tryPromise({
      try: () => ctx.sleep(millis, name),
      catch: (cause) =>
        new RestateError({ reason: 'SleepFailed', method: `sleep(${millis})`, cause }),
    })
  }).pipe(
    Effect.withSpan('restate.sleep', {
      attributes: { 'span.label': name ?? `${millis}ms` },
    }),
  )
