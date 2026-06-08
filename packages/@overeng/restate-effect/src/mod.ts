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
 * Phase 2 (Virtual Objects, Workflows, awakeables):
 * - Virtual Objects: `RestateObject.implement` with exclusive/shared handlers,
 *   typed K/V State (`State.for`), `ObjectKey`-backed `Restate.key`, and
 *   in-handler + ingress object clients.
 * - Workflows: `RestateWorkflow.implement` (one `run` + signal/query shared
 *   handlers), durable promises (`DurablePromise.for`), and submit/attach/output
 *   ingress clients (`run` omitted from the direct call surface).
 * - Awakeables: `Awakeable.make`/`resolve`/`reject` + ingress resolve/reject.
 * - Typed service-to-service clients (`Restate.call`/`send`/`objectClient`/…) and
 *   the `idempotencyKey` input-field annotation (the single key source, 0011).
 *
 * Phase 3 (determinism layer) + Phase 2b (cancellation):
 * - The per-invocation determinism layer (`determinismLayer`): a journaled Effect
 *   `Clock` (async `currentTimeMillis`/`Nanos` ← `ctx.date`; sync
 *   `unsafeCurrentTime*` ← a per-attempt frozen base seeded at handler entry) and
 *   `Random` (← `ctx.rand`), provided over each handler effect.
 * - The cancellation↔interruption bridge (`withAttemptInterruption`):
 *   `Request.attemptCompletedSignal` → Effect interruption, so `acquireRelease` /
 *   `onInterrupt` finalizers run; `toTerminal` maps an interruption to a
 *   `CancelledError` (no retry), distinct from a defect (retry).
 * - The `Restate.cancel` / `Restate.onCancellation` cancellation surface.
 * - The `overeng/no-raw-nondeterminism` lint enabled on `src/` handler code.
 *
 * The OTel bridge and the testing-harness subpaths remain for later phases.
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
/**
 * Durable combinators + Restate Schema annotations under one `Restate`
 * namespace: `Restate.run` / `.sleep` / `.timeout` / `.all` / `.race` / `.any`
 * (durable ops), and `Restate.terminal` / `.retryable` / `.serde` (Schema
 * annotations read at the error boundary / serde).
 */
import * as Client from './Client.ts'
import * as Ctx from './RestateContext.ts'
import * as Runtime from './Runtime.ts'

export const Restate = {
  run: Ctx.run,
  sleep: Ctx.sleep,
  timeout: Ctx.timeout,
  all: Ctx.all,
  race: Ctx.race,
  any: Ctx.any,
  runDescriptor: Ctx.runDescriptor,
  sleepDescriptor: Ctx.sleepDescriptor,
  /** The current Object / Workflow invocation key (requires `ObjectKey`). */
  key: Ctx.objectKey,
  /* In-handler service-to-service clients (require `RestateContext`, §9.2). */
  call: Client.callService,
  send: Client.sendService,
  objectClient: Client.callObject,
  objectSendClient: Client.sendObject,
  workflowClient: Client.callWorkflowSignal,
  workflowSubmit: Client.sendWorkflowRun,
  /* Cancellation surface (R31, §12): cancel another invocation (cooperative — the
   * target surfaces an interruption so its finalizers run), and observe the
   * current invocation's cancellation (resolves only under `explicitCancellation`). */
  cancel: Runtime.cancel,
  onCancellation: Runtime.onCancellation,
  terminal: Annotations.Restate.terminal,
  retryable: Annotations.Restate.retryable,
  serde: Annotations.Restate.serde,
  idempotencyKey: Annotations.Restate.idempotencyKey,
} as const

export { RestateContext, StateRead, StateWrite, ObjectKey } from './RestateContext.ts'
/* `DurablePromise` is the capability MARKER Tag (type only — used in handler `R`
 * channels); the public combinator namespace is the `DurablePromise` const below. */
export type { DurablePromise as DurablePromiseCapability } from './RestateContext.ts'
export type {
  AwakeableId,
  Descriptor,
  DurableCaps,
  ResultsOf,
  SendOptions,
  StateSchemas,
} from './RestateContext.ts'

/** Typed, capability-gated State combinators bound to a contract's `state` block. */
export const State = { for: Ctx.stateFor } as const

/**
 * Typed, capability-gated Workflow durable-promise combinators bound to a payload
 * Schema: `DurablePromise.for(Schema).{get,peek,resolve,reject,getDescriptor}`.
 * Requires the `DurablePromise` capability (Workflow handlers only).
 */
export const DurablePromise = { for: Ctx.durablePromiseFor } as const

/**
 * Awakeable external-completion combinators (R33): `Awakeable.make(Schema)` in a
 * handler (suspends until resolved); `resolve`/`reject` in-handler. Ingress
 * resolution is `RestateIngress.resolveAwakeable` / `rejectAwakeable`.
 */
export const Awakeable = {
  make: Ctx.makeAwakeable,
  resolve: Ctx.resolveAwakeable,
  reject: Ctx.rejectAwakeable,
} as const

export {
  RestateService,
  RestateObject,
  RestateWorkflow,
  type Contract,
  type HandlerSpec,
  type HandlerSpecMap,
  type HandlerOptions,
  type ServiceLevelOptions,
  type ServiceImpl,
  type ServiceImplementation,
  type InputOf,
  type SuccessOf,
  type ErrorOf,
  type MethodsOf,
  type ObjectContract,
  type ObjectHandlerSpec,
  type ObjectHandlerSpecMap,
  type ObjectImpl,
  type ObjectImplementation,
  type ObjectInputOf,
  type ObjectSuccessOf,
  type ObjectErrorOf,
  type ObjectMethodsOf,
  type WorkflowContract,
  type WorkflowHandlerSpec,
  type WorkflowHandlerSpecMap,
  type WorkflowImpl,
  type WorkflowImplementation,
  type WorkflowRunInputOf,
  type WorkflowRunSuccessOf,
  type WorkflowRunErrorOf,
  type WorkflowSignalQueryOf,
  type WorkflowSignalInputOf,
  type WorkflowSignalSuccessOf,
} from './Service.ts'

export {
  layer,
  serve,
  materialize,
  materializeObject,
  materializeWorkflow,
  materializeAny,
  toTerminal,
  type AnyImplementation,
  type EndpointOptions,
  type EndpointHooks,
  type HandlerWrap,
  type MaterializeWiring,
} from './Endpoint.ts'

/**
 * Per-invocation runtime boundary helpers (R17, R31). `determinismLayer` is the
 * journaled `Clock`/`Random` Layer (`ctx.date` + frozen base; `ctx.rand`);
 * `withAttemptInterruption` bridges `attemptCompletedSignal` to interruption.
 * Both are wired by `materialize*`; exported for direct testing.
 */
export { determinismLayer, withAttemptInterruption } from './Runtime.ts'

/**
 * The typed external ingress client. `RestateIngress` is the connected-ingress
 * Tag + layer; the standalone functions are the typed call surface:
 *
 * - Services: `call` / `callTyped` (request/response) + `decodeTerminalError`.
 * - Objects: `objectCall` / `objectCallTyped` / `objectSend`.
 * - Workflows: `workflowSubmit` / `workflowAttach` / `workflowOutput` (the `run`
 *   handler is omitted from the direct surface, R32) + `workflowCall` (signals/queries).
 * - Awakeables: `resolveAwakeable` / `rejectAwakeable`.
 * - Attach/output: `result` (get-output by send / submission handle).
 */
export {
  RestateIngress,
  call,
  callTyped,
  decodeTerminalError,
  decodeErrorWith,
  objectCall,
  objectCallTyped,
  objectSend,
  workflowSubmit,
  workflowAttach,
  workflowOutput,
  workflowCall,
  resolveAwakeable as ingressResolveAwakeable,
  rejectAwakeable as ingressRejectAwakeable,
  result,
} from './Client.ts'
