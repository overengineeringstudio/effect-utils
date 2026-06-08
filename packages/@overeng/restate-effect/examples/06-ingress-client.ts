/**
 * The typed external ingress client + the typed error boundary.
 *
 * From a contract ALONE (no hand-declared handler shape), the binding derives a
 * fully typed client: arguments are validated and encoded through the contract's
 * input serde, the result is decoded through the success serde, and a terminal
 * error body is re-decoded back into the original tagged error so the caller
 * `catchTag`s a typed domain error rather than a raw transport error.
 *
 * - `call` — request/response; a `TerminalError` surfaces as a raw transport
 *   `RestateError` (no auto-decode).
 * - `callTyped` — `call` + the typed terminal decode: the `E` channel gains the
 *   contract's declared error, so `Effect.catchTag('EmptyName', …)` recovers it.
 * - `objectCall` / `objectCallTyped` — the keyed-Object equivalents.
 * - `workflowSubmit` / `workflowAttach` / `workflowCall` — the Workflow surface.
 *
 * The client requires a `RestateIngress` layer bound to the server's ingress URL.
 */
import { Effect } from 'effect'

import {
  callTyped,
  objectCall,
  RestateIngress,
  workflowAttach,
  workflowCall,
  workflowSubmit,
} from '../src/mod.ts'
import { Greeter } from './01-service.ts'
import { CounterObj } from './02-virtual-object.ts'
import { ApprovalWf } from './03-workflow.ts'

/** Bind the ingress client to a running `restate-server` ingress URL. */
export const IngressLayer = RestateIngress.layer({ url: 'http://localhost:8080' })

/* A typed Service call: `result` is `{ message, id }` (validated success). */
export const greet = callTyped(Greeter, 'greet', { name: 'Sarah' }).pipe(
  Effect.provide(IngressLayer),
)

/**
 * The typed error boundary: an empty name fails the handler with `EmptyName`,
 * which crosses the wire as a terminal error and is decoded back into the tagged
 * `EmptyName` here — so `catchTag` recovers it like a local typed error.
 */
export const greetWithRecovery = callTyped(Greeter, 'greet', { name: '' }).pipe(
  Effect.map((ok) => ok.message),
  Effect.catchTag('EmptyName', () => Effect.succeed('(no name given)')),
  Effect.provide(IngressLayer),
)

/* A keyed Virtual Object call (the per-invocation key is the second argument). */
export const addToCounter = objectCall(CounterObj, 'counter-1', 'add', 3).pipe(
  Effect.provide(IngressLayer),
)

/**
 * The Workflow ingress surface: `submit` the `run` (idempotent, returns
 * immediately), `call` a signal/query, then `attach` to await the typed result.
 * The `run` handler is intentionally NOT in the direct call surface.
 */
export const runApproval = Effect.gen(function* () {
  yield* workflowSubmit(ApprovalWf, 'wf-1', 'please review')
  yield* workflowCall(ApprovalWf, 'wf-1', 'approve', undefined) // a signal
  return yield* workflowAttach(ApprovalWf, 'wf-1') // awaits the run's typed success
}).pipe(Effect.provide(IngressLayer))
