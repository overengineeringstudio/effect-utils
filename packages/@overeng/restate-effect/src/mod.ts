/**
 * `@overeng/restate-effect` — a fully Effect-idiomatic wrapper around the
 * Restate TypeScript SDK.
 *
 * Authoring is declarative and Schema-typed: a Restate *service* is a named map
 * of `RestateService.handler({ input, success, error, run })` entries, where
 * `run` is an `Effect` that may `yield* RestateContext` to reach durable
 * primitives. The endpoint is a scoped `Layer` (graceful shutdown) and `serve`
 * is the long-lived entrypoint.
 *
 * The architecture pillars proven by this POC:
 * - Effect `Schema` as the I/O contract (`effectSerde` ↔ Restate `Serde`).
 * - Tagged domain errors → Restate `TerminalError` (no retry); defects →
 *   normal throw (SDK retries). See `Endpoint.toTerminal`.
 * - A per-invocation Effect runtime boundary: the shared app runtime is built
 *   once from a `Layer`, and the per-call `RestateContext` is provided per
 *   invocation.
 * - Durable steps via `RestateContext.run` / `.sleep` (backed by `ctx.run` /
 *   `ctx.sleep`).
 * - App-service injection via a `Layer`; the endpoint server as a scoped Layer.
 *
 * Every boundary op is `Effect.withSpan`-wrapped, so spans flow when a Tracer
 * is present. Virtual Objects, Workflows, awakeables, sagas, and the full OTel
 * trace-context bridge are intentionally out of scope for this POC.
 */

export { RestateError } from './RestateError.ts'
export { effectSerde, type RestateSerde } from './Serde.ts'

import * as RestateContextNs from './RestateContext.ts'
/**
 * The per-invocation Restate context `Context.Tag` plus durable combinators
 * (`RestateContext.run`, `RestateContext.sleep`). Used as both the service Tag
 * and the namespace of durable operations.
 */
export const RestateContext = Object.assign(RestateContextNs.RestateContext, {
  run: RestateContextNs.run,
  sleep: RestateContextNs.sleep,
})
export type RestateContext = RestateContextNs.RestateContext

import * as ServiceNs from './Service.ts'
/** Declarative, Schema-typed service authoring: `RestateService.make` / `.handler`. */
export const RestateService = {
  make: ServiceNs.make,
  handler: ServiceNs.handler,
}
export type { HandlerDef, ServiceDef } from './Service.ts'

export { layer, serve, materialize, toTerminal, type EndpointOptions } from './Endpoint.ts'
