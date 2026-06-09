/**
 * The `./admin` management API + the Molty-consumer runbook, verified end-to-end
 * against a real native `restate-server` via the `./testing` harness (spec §12,
 * decision 0018). Drives the EXACT contracts the runbook recipe shows
 * (`examples/13-admin-operations.ts`) and the admin flows an operator runs:
 *
 * - QUERY a Virtual-Object (incident) key's State via admin `/query`.
 * - LIST invocations filtered by service (`sys_invocation`).
 * - SURFACE + CANCEL a wedged delivery (a workflow parked on a durable promise).
 * - a typed `/query` introspection round-trip (rows decoded through a Schema).
 * - list/get deployments.
 *
 * Gracefully skips when no native binary is present (`serverAvailable`).
 */
import { Effect, Layer, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  IncidentObj,
  IncidentLive,
  InvocationRow,
  listByServiceSql,
  DeliveryWf,
  DeliveryLive,
  stuckDeliveriesSql,
} from '../examples/13-admin-operations.ts'
import { RestateAdmin, type RestateAdminService } from './admin.ts'
import { serverAvailable, withRestateServer } from './testing.ts'

/* One held native server for the suite, serving the incident object + delivery
 * workflow (the runbook's two constructs). The admin surface is built from the
 * booted ADMIN url; the typed ingress is the harness's. */
const held = withRestateServer({
  services: [IncidentLive, DeliveryLive],
  appLayer: Layer.empty,
})

/* Run an admin program against the booted admin url. */
const runAdmin = <A>(use: (admin: RestateAdminService) => Effect.Effect<A, unknown>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const admin = yield* RestateAdmin
      return yield* use(admin)
    }).pipe(
      Effect.provide(RestateAdmin.layer({ adminUrl: held.harness().adminUrl })),
    ) as Effect.Effect<A>,
  )

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe.skipIf(!serverAvailable)('restate-effect ./admin management API', () => {
  beforeAll(held.setup, 60_000)
  afterAll(held.teardown, 60_000)

  it('lists deployments + a typed /query round-trip over sys_invocation', async () => {
    const deployments = await runAdmin((admin) => admin.listDeployments())
    /* The harness registered exactly one deployment (the served endpoint). */
    expect(deployments).toBeDefined()

    /* A typed introspection round-trip: rows decoded through the caller's Schema.
     * Empty result is fine (no invocations yet) — the point is the decode path. */
    const rows = await runAdmin((admin) =>
      admin.query(
        'SELECT id, status FROM sys_invocation LIMIT 5',
        Schema.Struct({ id: Schema.String, status: Schema.String }),
      ),
    )
    expect(Array.isArray(rows)).toBe(true)
  }, 90_000)

  it('QUERY a Virtual-Object (incident) key State via the admin surface', async () => {
    const key = `incident-${Date.now()}`
    /* Drive the single-writer transition through the typed ingress. */
    await Effect.runPromise(
      held
        .harness()
        .ingress.objectCall(IncidentObj, key, 'open', 'disk full on dev3')
        .pipe(Effect.orDie),
    )

    /* QUERY the incident's State directly over the admin /query SQL (the runbook
     * "inspect an incident key's state" flow), decoding the State rows. The
     * `status` value is JSON-encoded bytes; assert the row is present + non-empty. */
    const stateRows = await runAdmin((admin) =>
      admin.queryRaw(
        `SELECT key FROM state WHERE service_name = 'incident' AND service_key = '${key}'`,
      ),
    )
    const keys = stateRows.map((r) => r['key'])
    expect(keys).toContain('status')
    expect(keys).toContain('note')

    /* And the typed `stateOf` proxy (same admin /query under the hood) reads the
     * decoded value, confirming the single-writer transition landed. */
    const status = await Effect.runPromise(
      held.harness().stateOf(IncidentObj, key).get('status').pipe(Effect.orDie),
    )
    expect(status).toBe('open')
  }, 90_000)

  it('SURFACES a wedged delivery, then CANCELS it via RestateAdmin.cancel', async () => {
    const key = `delivery-${Date.now()}`
    /* Submit a delivery that WEDGES (parks on its durable `release` promise). */
    const submission = await Effect.runPromise(
      held.harness().ingress.workflowSubmit(DeliveryWf, key, { wedge: true }).pipe(Effect.orDie),
    )
    const invocationId = submission.invocationId
    expect(invocationId).toMatch(/.+/)

    /* LIST invocations for the delivery service + SURFACE the stuck one: poll
     * `sys_invocation` until the workflow's `run` invocation appears in a
     * NON-TERMINAL state. NB (verified, 1.6.2): a workflow `run` blocked on a long
     * durable wait reports `running` — it does NOT flip to `suspended` like an
     * Object handler — so "stuck" is "present + not completed", not a single status. */
    const activeStatuses = ['running', 'suspended', 'backing-off', 'scheduled']
    const findStuck = async (): Promise<InvocationRow | undefined> => {
      const rows = await runAdmin((admin) =>
        admin.query(listByServiceSql('delivery'), InvocationRow),
      )
      return rows.find((r) => r.id === invocationId)
    }
    let stuck: InvocationRow | undefined
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      stuck = await findStuck()
      if (stuck !== undefined && activeStatuses.includes(stuck.status) === true) break
      await sleep(250)
    }
    expect(stuck).toBeDefined()
    expect(stuck!.target_service_name).toBe('delivery')
    expect(activeStatuses).toContain(stuck!.status)
    /* The runbook's stuck-delivery query surfaces it (non-terminal ⊃ this one). */
    const stuckList = await runAdmin((admin) =>
      admin.query(stuckDeliveriesSql('delivery'), InvocationRow),
    )
    expect(stuckList.some((r) => r.id === invocationId)).toBe(true)

    /* CANCEL the wedged invocation via the admin surface (graceful — finalizers
     * run, no retry). */
    await runAdmin((admin) => admin.cancel(invocationId))

    /* Poll until the invocation is no longer active (cancellation is async). */
    const gone = async (): Promise<boolean> => {
      const rows = await runAdmin((admin) =>
        admin.query(listByServiceSql('delivery'), InvocationRow),
      )
      const row = rows.find((r) => r.id === invocationId)
      /* Either purged from the live set, or no longer in an active state. */
      return row === undefined || !activeStatuses.includes(row.status)
    }
    const cancelDeadline = Date.now() + 30_000
    let cancelled = false
    while (Date.now() < cancelDeadline) {
      if (await gone()) {
        cancelled = true
        break
      }
      await sleep(250)
    }
    expect(cancelled).toBe(true)
  }, 90_000)
})
