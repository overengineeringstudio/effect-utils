/**
 * `@overeng/restate-effect` — a fully Effect-idiomatic wrapper around the
 * Restate TypeScript SDK.
 *
 * Phase 1 (core machinery, Services end-to-end):
 * - Restate Schema annotations (`Restate.terminal`/`retryable`/`serde`).
 * - `effectSerde` (slot-aware: `ingress` decode failure → `TerminalError(400)`,
 *   `internal` → corrupt-journal defect).
 * - `RestateContext` Tag + flat capability markers (`StateRead`/`StateWrite`/
 *   `DurablePromise`/`ObjectKey`) and durable combinators (`Restate.run` with
 *   capability scrubbing, `sleep`, `timeout`, descriptor-based `all`/`race`/`any`,
 *   and `State.*`).
 * - `contract` / `implement` / `define` typed Service builders; typed Object /
 *   Workflow contract builders (`implement` scaffolded for Phase 2).
 * - The endpoint `materialize` + scoped `layer` + `serve`, per-error errorCode
 *   + `_tag`-in-body transport, and the typed `RestateIngress` client + decode.
 *
 * Objects/Workflows/awakeables are SCAFFOLDED (typed, runtime-stubbed) for Phase 2.
 */

export { RestateError } from './RestateError.ts'
export {
  effectSerde,
  ingressSerde,
  internalSerde,
  type RestateSerde,
  type SerdeSlot,
} from './Serde.ts'

import * as Annotations from './Annotations.ts'
import * as Ctx from './RestateContext.ts'

/**
 * Durable combinators + Restate Schema annotations under one `Restate`
 * namespace: `Restate.run` / `.sleep` / `.timeout` / `.all` / `.race` / `.any`
 * (durable ops), and `Restate.terminal` / `.retryable` / `.serde` (Schema
 * annotations read at the error boundary / serde).
 */
export const Restate = {
  run: Ctx.run,
  sleep: Ctx.sleep,
  timeout: Ctx.timeout,
  all: Ctx.all,
  race: Ctx.race,
  any: Ctx.any,
  runDescriptor: Ctx.runDescriptor,
  sleepDescriptor: Ctx.sleepDescriptor,
  terminal: Annotations.Restate.terminal,
  retryable: Annotations.Restate.retryable,
  serde: Annotations.Restate.serde,
} as const

export {
  RestateContext,
  StateRead,
  StateWrite,
  DurablePromise,
  ObjectKey,
} from './RestateContext.ts'
export type { Descriptor, DurableCaps, ResultsOf, StateSchemas } from './RestateContext.ts'

/** Typed, capability-gated State combinators bound to a contract's `state` block. */
export const State = { for: Ctx.stateFor } as const

export {
  RestateService,
  RestateObject,
  RestateWorkflow,
  type Contract,
  type HandlerSpec,
  type HandlerSpecMap,
  type ServiceImpl,
  type ServiceImplementation,
  type InputOf,
  type SuccessOf,
  type ErrorOf,
  type MethodsOf,
  type ObjectContract,
  type ObjectImpl,
  type WorkflowContract,
} from './Service.ts'

export { layer, serve, materialize, toTerminal, type EndpointOptions } from './Endpoint.ts'

export { RestateIngress, call, callTyped, decodeTerminalError } from './Client.ts'
