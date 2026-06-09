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
 * The OTel bridge (`./otel`, Phase 4) and the Docker-free testing harness
 * (`./testing`, Phase 5) live behind their own opt-in subpath exports — not on
 * this core `.` surface.
 */

export { RestateError } from './schema/RestateError.ts'
export {
  effectSerde,
  ingressSerde,
  internalSerde,
  type RestateSerde,
  type SerdeSlot,
} from './schema/Serde.ts'

/**
 * Field-level redaction for `sensitive`/`redacted` schema fields (decision 0011,
 * §4/§13). `RestateRedaction` is the pluggable cipher Tag the consumer provides;
 * `aesGcmRedactionLayer(key)` is a ready-to-use AES-256-GCM reference layer (and
 * `aesGcmCipher(key)` the bare cipher). Provide a `RestateRedaction` layer in the
 * application Layer whenever any served schema marks a field `Restate.sensitive`
 * — otherwise encode/decode fails with `RedactionCipherMissingError` (never
 * plaintext). NOT the deferred whole-value `JournalValueCodec` (which has no field
 * structure).
 */
export {
  RestateRedaction,
  aesGcmCipher,
  aesGcmRedactionLayer,
  RedactionCipherMissingError,
  type RedactionCipher,
} from './schema/Redaction.ts'

import * as Annotations from './schema/Annotations.ts'
export type { RetentionOptions, SerdeOptions, ErrorClass } from './schema/Annotations.ts'
import * as Ctx from './authoring/RestateContext.ts'
/**
 * Durable combinators + Restate Schema annotations under one `Restate`
 * namespace: `Restate.run` / `.sleep` / `.timeout` / `.all` / `.race` / `.any`
 * (durable ops), and `Restate.terminal` / `.retryable` / `.serde` (Schema
 * annotations read at the error boundary / serde).
 */
import * as Client from './clients/Client.ts'
import { annotateSpan, annotateSpanFrom } from './observability/Metrics.ts'
import * as Runtime from './runtime/Runtime.ts'
import { reschedule } from './scheduling/Reschedule.ts'
import { pollLoop } from './scheduling/Scheduled.ts'

export const Restate = {
  run: Ctx.run,
  /** Observe a `Restate.run`'s outcome (success / domain `E` / infra defect) as an `Exit` value (compensation/sagas, decision 0003). */
  runExit: Ctx.runExit,
  sleep: Ctx.sleep,
  timeout: Ctx.timeout,
  all: Ctx.all,
  race: Ctx.race,
  any: Ctx.any,
  runDescriptor: Ctx.runDescriptor,
  sleepDescriptor: Ctx.sleepDescriptor,
  /** A typed in-handler service `call` issued as a `Descriptor` for `Restate.all`/`race`/`any` (#2). */
  callDescriptor: Client.callServiceDescriptor,
  /** A typed in-handler Object `call` issued as a `Descriptor` for the deterministic combinators (#2). */
  objectCallDescriptor: Client.callObjectDescriptor,
  /** The current Object / Workflow invocation key (requires `ObjectKey`). */
  key: Ctx.objectKey,
  /* In-handler service-to-service clients (require `RestateContext`, §9.2). */
  call: Client.callService,
  send: Client.sendService,
  objectClient: Client.callObject,
  objectSendClient: Client.sendObject,
  workflowClient: Client.callWorkflowSignal,
  workflowSubmit: Client.sendWorkflowRun,
  /**
   * Re-arm the CURRENT Virtual Object by a delayed self-send of one of its own
   * handlers (#4, decision 0012): the typed durable self-send building block for a
   * hand-rolled durable loop. Capability-gated to keyed handlers (`ObjectKey`).
   */
  reschedule,
  /**
   * Build a narrow durable recurring-loop Virtual Object (#4, decision 0012):
   * `fixedDelay` scheduling, `skipToNext` default error policy, stop conditions,
   * generation re-arm, and the safe re-arm-before-fallible-work ordering. Alias for
   * {@link RestateScheduled.make}; per-cycle retry belongs inside a bounded
   * `Restate.run` (there is no `retryCycle` knob).
   */
  pollLoop,
  /* Cancellation surface (R31, §12): cancel another invocation (cooperative — the
   * target surfaces an interruption so its finalizers run), and observe the
   * current invocation's cancellation (resolves only under `explicitCancellation`). */
  cancel: Runtime.cancel,
  onCancellation: Runtime.onCancellation,
  /**
   * Stamp custom BUSINESS span attributes on the current span (R23, §10, decision
   * 0014) — the USER observability path for slicing in Tempo/Grafana (e.g.
   * `dataSourceId`). A thin combinator over `Effect.annotateCurrentSpan`; otel-free
   * (no `./otel` import). Use the `span.label` convention for a single primary
   * label. Attributes are NOT replay-suppressed — for side-effecting telemetry use
   * a metric / span event gated through `Restate.run`.
   */
  annotateSpan,
  /**
   * Stamp span attributes PROJECTED from a decoded struct, SAFE BY DEFAULT against
   * the redaction rule (decision 0014): every `Restate.sensitive`/`redacted` field
   * is STRIPPED so a secret can never reach the span — the schema-aware counterpart
   * to {@link annotateSpan} for "annotate a few non-secret fields of my input/state".
   */
  annotateSpanFrom,
  terminal: Annotations.Restate.terminal,
  retryable: Annotations.Restate.retryable,
  serde: Annotations.Restate.serde,
  idempotencyKey: Annotations.Restate.idempotencyKey,
  /* Retention/timeout facts on a contract / handler I/O schema → SDK options at
   * `materialize` (decision 0011, §7), and field-level redaction (`sensitive`/
   * `redacted`) consumed by `effectSerde` as an encrypt/decrypt transform (0011, §4). */
  retention: Annotations.Restate.retention,
  sensitive: Annotations.Restate.sensitive,
  redacted: Annotations.Restate.redacted,
} as const

export { RestateContext, StateRead, StateWrite, ObjectKey } from './authoring/RestateContext.ts'
/* `DurablePromise` is the capability MARKER Tag (type only — used in handler `R`
 * channels); the public combinator namespace is the `DurablePromise` const below. */
export type { DurablePromise as DurablePromiseCapability } from './authoring/RestateContext.ts'
export type {
  AwakeableId,
  Descriptor,
  DurableCaps,
  ResultsOf,
  RunRetryOptions,
  SendOptions,
  StateSchemas,
  StateValueType,
} from './authoring/RestateContext.ts'

/** Typed, capability-gated State combinators bound to a contract's `state` block. */
export const State = { for: Ctx.stateFor } as const

/**
 * The narrow durable recurring-loop primitive (#4, decision 0012):
 * `RestateScheduled.make({ name, domainState, cycle, schedule, … })` materializes
 * a Virtual Object that runs a chain of bounded delayed self-sends. `fixedDelay`
 * scheduling, `OnCycleError` (default `skipToNext`), stop via
 * `stopWhen`/`maxIterations`/in-cycle `{ stop: true }`, generation-token re-arm,
 * and the safe re-arm-before-fallible-work ordering. Composes a declared
 * `errorSchema` (a `retryable` failure RE-ARMS after its projected `retryAfter`,
 * bounded by `maxRetryBackoffs`) and an opt-in awakeable `wake` (a webhook cuts the
 * inter-cycle wait short via the `wakeId` shared handler; the reason rides into the
 * next cycle as `wokenBy`). `fixedRate`/`cron`/runtime reconfigure are deferred;
 * per-cycle retry lives inside a bounded `Restate.run`. `WakePayload` is the wake
 * awakeable schema (resolved via ingress `resolveAwakeable`).
 */
export { RestateScheduled, Schedule, OnCycleError, WakePayload } from './scheduling/Scheduled.ts'
export type {
  Scheduled,
  ScheduledConfig,
  CycleEffect,
  LoopStatusTag,
  StatusOutput as ScheduledStatus,
} from './scheduling/Scheduled.ts'

/** The typed durable self-send building block (#4, decision 0012). */
export { reschedule } from './scheduling/Reschedule.ts'

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
  type RetryPolicyOptions,
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
} from './authoring/Service.ts'

export {
  layer,
  serve,
  materialize,
  materializeObject,
  materializeWorkflow,
  materializeAny,
  type AnyImplementation,
  type EndpointOptions,
  type MaterializeWiring,
} from './endpoint/Endpoint.ts'

export {
  toTerminal,
  classifyOutcome,
  type BoundaryErrorClass,
  type BoundaryInfo,
  type BoundaryObserver,
  type BoundaryOutcome,
  type EndpointHooks,
  type HandlerWrap,
} from './error/Boundary.ts'

/**
 * The replay-aware auto baseline metric definitions (decision 0014, §10) — Effect
 * `Metric`s (no otel import) bound to the OTel meter by `RestateOtel.layer` (see
 * `./otel`). Exported so consumers can inspect / reuse them; `Restate.annotateSpan`
 * is the user span-attribute path on the `Restate` namespace.
 */
export {
  invocationsTotal,
  invocationDurationMs,
  attemptsTotal,
  durableStepsTotal,
  awakeableWaitMs,
  pollLoopCyclesTotal,
} from './observability/Metrics.ts'

/**
 * Per-invocation runtime boundary helpers (R17, R31, decision 0015).
 * `determinismLayer` is the journaled `Clock`/`Random` Layer (`ctx.date` + frozen
 * base; `ctx.rand`); `loggerLayer` replaces the default Effect logger with one
 * that writes to the replay-aware `ctx.console` (so in-handler `Effect.log*` is
 * suppressed on replay); `withAttemptInterruption` bridges `attemptCompletedSignal`
 * to interruption. All wired by `materialize*`; exported for direct testing.
 */
export { determinismLayer, loggerLayer, withAttemptInterruption } from './runtime/Runtime.ts'

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
} from './clients/Client.ts'
