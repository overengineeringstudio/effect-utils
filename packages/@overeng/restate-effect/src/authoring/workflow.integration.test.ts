/**
 * Integration test for Workflows against a real native `restate-server`.
 *
 * Proves the Workflow vertical slice: an `approval` workflow whose `run` handler
 * awaits a durable promise, an `approve` / `reject` SIGNAL handler resolves or
 * rejects it, and a `status` QUERY handler reads the State. Driven via
 * `workflowSubmit` + `workflowAttach`, asserting BOTH the approved and rejected
 * outcomes (docs/vrs/01-authoring/spec.md §1.3 — the `'rejected'` path is reachable via the query, R34).
 */
import { Effect, Layer, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DurablePromise,
  RestateIngress,
  RestateWorkflow,
  State,
  workflowAttach,
  workflowCall,
  workflowSubmit,
} from '../mod.ts'
import { serverAvailable, withRestateServer } from '../testing/testing.ts'

/* ── approval workflow: run awaits a durable promise; approve/reject signals ── */

const Decision = Schema.Struct({ approved: Schema.Boolean })
const Approval = DurablePromise.for(Decision)

const StatusState = { status: Schema.Literal('pending', 'approved', 'rejected') } as const
const Status = State.for(StatusState)

const ApprovalWf = RestateWorkflow.contract('approval', {
  state: StatusState,
  payload: { input: Schema.String, success: Schema.Boolean },
  signals: {
    approve: { input: Schema.Void, success: Schema.Void },
    reject: { input: Schema.Void, success: Schema.Void },
  },
  queries: {
    status: { input: Schema.Void, success: Schema.String },
  },
})

const ApprovalLive = RestateWorkflow.implement<typeof ApprovalWf>(ApprovalWf, {
  /* `run` (full caps): mark pending, await the durable `decision` promise, record
   * the outcome in State. Wrapper errors are infra → `orDie`. */
  run: () =>
    Effect.gen(function* () {
      yield* Status.set('status', 'pending')
      const decision = yield* Approval.get('decision')
      yield* Status.set('status', decision.approved ? 'approved' : 'rejected')
      return decision.approved
    }).pipe(Effect.orDie),
  /* Signal (shared): resolve the durable promise approved. */
  approve: () => Approval.resolve('decision', { approved: true }).pipe(Effect.orDie),
  /* Signal (shared): resolve the durable promise rejected (drives the `'rejected'`
   * State path, observable via the `status` query — R34). */
  reject: () => Approval.resolve('decision', { approved: false }).pipe(Effect.orDie),
  /* Query (shared, read-only State): a `State.set` here would not typecheck. */
  status: () =>
    Status.get('status').pipe(
      Effect.map((s) => s ?? 'pending'),
      Effect.orDie,
    ),
})

/* One held native server for the suite (collapses the copy-pasted scope/ingress
 * `beforeAll`); the standalone workflow ingress functions need a `RestateIngress`
 * layer built from the booted ingress URL. */
const held = withRestateServer({ services: [ApprovalLive], appLayer: Layer.empty })
const ingressLayer = (): Layer.Layer<RestateIngress> =>
  RestateIngress.layer({ url: held.harness().ingressUrl })

describe('restate-effect workflow (approval)', () => {
  beforeAll(held.setup, 60_000)
  afterAll(held.teardown, 60_000)

  it.skipIf(!serverAvailable)('submit → approve signal → attach resolves approved', async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        yield* workflowSubmit(ApprovalWf, 'wf-approve', 'please review')
        /* Give the run handler time to register the durable promise, then signal. */
        yield* Effect.sleep('200 millis')
        yield* workflowCall(ApprovalWf, 'wf-approve', 'approve', undefined)
        const result = yield* workflowAttach(ApprovalWf, 'wf-approve')
        const status = yield* workflowCall(ApprovalWf, 'wf-approve', 'status', undefined)
        return { result, status }
      }).pipe(Effect.provide(ingressLayer())),
    )
    expect(outcome.result).toBe(true)
    expect(outcome.status).toBe('approved')
  })

  it.skipIf(!serverAvailable)('submit → reject signal → attach resolves rejected', async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        yield* workflowSubmit(ApprovalWf, 'wf-reject', 'please review')
        yield* Effect.sleep('200 millis')
        yield* workflowCall(ApprovalWf, 'wf-reject', 'reject', undefined)
        const result = yield* workflowAttach(ApprovalWf, 'wf-reject')
        const status = yield* workflowCall(ApprovalWf, 'wf-reject', 'status', undefined)
        return { result, status }
      }).pipe(Effect.provide(ingressLayer())),
    )
    expect(outcome.result).toBe(false)
    expect(outcome.status).toBe('rejected')
  })
})
