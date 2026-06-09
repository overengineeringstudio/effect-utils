# Operating a deployment (`./admin`)

[← Handbook index](./README.md)

Running constructs is only half the job — you also have to **operate** a live
deployment: list and inspect invocations, read a workflow / object's State, surface
deliveries that are wedged, and cancel/kill/retry the stuck ones. The opt-in
`./admin` subpath wraps the `restate-server` **admin REST API** as a typed
`RestateAdmin` service. The worked recipe is
[`examples/13-admin-operations.ts`](../../examples/13-admin-operations.ts), verified
end-to-end by [`src/admin.integration.test.ts`](../../src/admin/admin.integration.test.ts).

> **Trust boundary — read this first.** The admin API is **unauthenticated by
> default** and lets anyone who can reach it cancel/kill invocations, mutate State,
> and read every `sys_*` row. **Never expose it publicly.** Keep it on a trusted
> network (private subnet / Tailscale / localhost) or behind an authenticating
> proxy; for a secured / Restate Cloud endpoint pass a bearer `apiKey`
> (`Redacted<string>`). It is also **less stable** than the SDK invocation
> protocol — endpoint shapes and the `sys_*` SQL schema change across server
> versions. `./admin` is pinned to **restate-server 1.6.2** and verified against it.

## Wiring it up

`RestateAdmin.layer` mirrors `RestateIngress.layer`, but points at the **admin** url
(not ingress):

```ts
import { Effect } from 'effect'
import { RestateAdmin } from '@overeng/restate-effect/admin'

const program = Effect.gen(function* () {
  const admin = yield* RestateAdmin
  yield* admin.cancel(invocationId) // PATCH /invocations/{id}/cancel
}).pipe(
  Effect.provide(RestateAdmin.layer({ adminUrl: 'http://localhost:9070' })),
  // for a secured endpoint: RestateAdmin.layer({ adminUrl, apiKey: Redacted.make(key) })
  // env-driven: RestateAdmin.layerConfig() reads RESTATE_ADMIN_URL / RESTATE_ADMIN_KEY
)
```

## The Molty runbook

The recipe models the two constructs a notifications consumer runs — an `incident`
Virtual Object (a single-writer state machine keyed by incident id) and a `delivery`
Workflow (durable Discord delivery that can **wedge**) — and the flows an operator
runs against them.

### LIST invocations (filter by service / status)

`query(sql, rowSchema)` runs SQL over the `sys_*` tables and decodes each row
through **your** Schema (a typed passthrough — the binding does not own the `sys_*`
shapes). `queryRaw(sql)` is the untyped escape hatch.

```ts
const InvocationRow = Schema.Struct({
  id: Schema.String,
  target_service_name: Schema.String,
  target_handler_name: Schema.String,
  status: Schema.String,
  retry_count: Schema.optional(Schema.NullishOr(Schema.Number)),
})

const rows =
  yield *
  admin.query(
    `SELECT id, target_service_name, target_handler_name, status, retry_count
   FROM sys_invocation
   WHERE target_service_name = 'delivery'`,
    InvocationRow,
  )
```

### INSPECT workflow state / QUERY an incident key's State

State rows live in the `state` table, keyed by `service_name` + `service_key`:

```ts
const stateRows =
  yield *
  admin.queryRaw(
    `SELECT key FROM state WHERE service_name = 'incident' AND service_key = '${incidentKey}'`,
  )
```

For a **typed** decode of a known key's value, the testing harness's
`stateOf(contract, key).get(...)` reads through the same admin `/query` with the
contract's serde — see [Testing](./testing.md).

### SURFACE stuck deliveries

A "stuck" delivery is a **non-terminal** invocation (anything but `completed`),
ranked by `retry_count`. Two shapes to triage (verified against 1.6.2):

- `status = 'backing-off'` — parked on a **retryable** error (a Discord 429 / 5xx);
  the SDK is durably retrying, `retry_count` climbs.
- `status = 'suspended'` — a Service / Virtual Object handler parked on a durable
  wait (sleep / awakeable / call).
- `status = 'running'` for a long time — note a **Workflow** `run` blocked on a long
  durable wait reports `running` (it does **not** flip to `suspended` like an Object
  handler), so a long-`running` `run` is itself a stuck signal.

```ts
const stuck =
  yield *
  admin.query(
    `SELECT id, target_service_name, target_handler_name, status, retry_count
   FROM sys_invocation
   WHERE target_service_name = 'delivery' AND status != 'completed'
   ORDER BY retry_count DESC`,
    InvocationRow,
  )
```

### CANCEL / KILL / retry a wedged invocation

```ts
yield * admin.cancel(invocationId) // graceful — finalizers run, no retry (R31)
yield * admin.kill(invocationId) // hard — no compensation
yield * admin.pause(invocationId) //  stop scheduling further attempts
yield * admin.resume(invocationId, { deployment: 'dp_x' }) // resume, optionally pinned
const { newInvocationId } = yield * admin.restartAsNew(invocationId, { from: 3 })
yield * admin.purge(invocationId) // drop a completed invocation's output + journal
```

A `cancel` surfaces inside the handler as an Effect **interruption**, so
`acquireRelease` / `onInterrupt` finalizers and saga compensations run — see
[Cancellation](./cancellation.md).

### Deployments

```ts
const deployments = yield * admin.listDeployments()
const detail = yield * admin.getDeployment(deploymentId)
yield * admin.updateDeployment(deploymentId, { additional_headers: { 'x-token': '…' } })
```

## Version caveats (verified against 1.6.2)

- The **bulk/batch** invocation verbs (a filtered `PATCH /invocations/{verb}`) do
  **not** exist on 1.6.2 — they return `405`. They are a later-server feature; this
  surface offers only the per-id ops a 1.6.2 server actually exposes.
- A Workflow `run` blocked on a long durable wait reports `running`, not
  `suspended` (the stuck-delivery query above accounts for this).

## See also

- [Cancellation and lifecycle](./cancellation.md) — what a `cancel` does inside the handler.
- [Testing (`./testing`)](./testing.md) — the typed `stateOf` State proxy over the same admin `/query`.
- [decision 0018](../vrs/.decisions/0018-admin-management-api.md) — the trust-boundary + typed-passthrough rationale.
