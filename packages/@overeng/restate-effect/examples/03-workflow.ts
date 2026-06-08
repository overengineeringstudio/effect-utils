/**
 * A Workflow: one `run` handler (exactly-once per workflow ID), plus `signal`
 * and `query` shared handlers, coordinated through a durable promise.
 *
 * - `run` has the full capability set (`StateRead + StateWrite + DurablePromise +
 *   ObjectKey`): it awaits a durable promise and records the outcome in State.
 * - `approve` / `reject` are SIGNALS (shared handlers): they resolve the durable
 *   promise. A durable promise is the rendezvous between `run` (which awaits it)
 *   and a signal (which resolves it).
 * - `status` is a QUERY (shared, read-only State): a `State.set` here would not
 *   type-check.
 *
 * Verified end-to-end by `src/examples.integration.test.ts`.
 */
import { Effect, Schema } from 'effect'

import { DurablePromise, RestateWorkflow, State } from '../src/mod.ts'

/* ── A durable promise typed by its payload Schema (Workflow handlers only) ── */

const Decision = Schema.Struct({ approved: Schema.Boolean })
const Approval = DurablePromise.for(Decision)

/* ── Typed State observable via the `status` query ── */

export const StatusState = {
  status: Schema.Literal('pending', 'approved', 'rejected'),
} as const
const Status = State.for(StatusState)

export const ApprovalWf = RestateWorkflow.contract('approval', {
  state: StatusState,
  /* `payload` is the `run` handler's I/O. */
  payload: { input: Schema.String, success: Schema.Boolean },
  signals: {
    approve: { input: Schema.Void, success: Schema.Void },
    reject: { input: Schema.Void, success: Schema.Void },
  },
  queries: {
    status: { input: Schema.Void, success: Schema.String },
  },
})

export const ApprovalLive = RestateWorkflow.implement<typeof ApprovalWf>(ApprovalWf, {
  /* The single `run` (full caps): mark pending, AWAIT the durable promise (the
   * invocation durably suspends here until a signal resolves it), record the
   * outcome. The await survives process restarts — it is journaled, not in-memory. */
  run: () =>
    Effect.gen(function* () {
      yield* Status.set('status', 'pending')
      const decision = yield* Approval.get('decision') // blocks until resolved
      yield* Status.set('status', decision.approved ? 'approved' : 'rejected')
      return decision.approved
    }).pipe(Effect.orDie),
  /* Signals (shared): resolve the durable promise. `reject` drives the
   * `'rejected'` State path, observable via the `status` query. */
  approve: () => Approval.resolve('decision', { approved: true }).pipe(Effect.orDie),
  reject: () => Approval.resolve('decision', { approved: false }).pipe(Effect.orDie),
  /* Query (shared, read-only State). */
  status: () =>
    Status.get('status').pipe(
      Effect.map((s) => s ?? 'pending'),
      Effect.orDie,
    ),
})
