import type { Effect, Schema } from 'effect'

import type { RestateContext } from './RestateContext.ts'

/**
 * A single Schema-typed handler. The authoring form (`handler`) is fully typed;
 * the stored form here is widened (`any` schemas / effect) so a heterogeneous
 * `Record<string, HandlerDef>` can describe one service. The erased generics
 * are re-narrowed only at the `Endpoint.materialize` boundary.
 */
export interface HandlerDef<R> {
  /* eslint-disable @typescript-eslint/no-explicit-any -- intentional widening of the stored form */
  readonly input: Schema.Schema<any, any>
  readonly success: Schema.Schema<any, any>
  readonly error?: Schema.Schema<any, any>
  readonly run: (input: any) => Effect.Effect<any, any, R | RestateContext>
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Declares one handler with full call-site typing: `run` must take the decoded
 * `input` and return an `Effect<success, error, R | RestateContext>`. The
 * result is widened to the stored `HandlerDef<R>` form for service assembly.
 */
export const handler = <AI, II, AO, IO, AE = never, IE = never, R = never>(def: {
  readonly input: Schema.Schema<AI, II>
  readonly success: Schema.Schema<AO, IO>
  readonly error?: Schema.Schema<AE, IE>
  readonly run: (input: AI) => Effect.Effect<AO, AE, R | RestateContext>
}): HandlerDef<R> => def as unknown as HandlerDef<R>

/** A named, stateless Restate service: a map of Schema-typed handlers. */
export interface ServiceDef<R> {
  readonly name: string
  readonly handlers: Record<string, HandlerDef<R>>
}

/** Assembles a `ServiceDef` from a name and a handler map. */
export const make = <R>(name: string, handlers: Record<string, HandlerDef<R>>): ServiceDef<R> => ({
  name,
  handlers,
})
