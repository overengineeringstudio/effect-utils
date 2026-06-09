# Spec: 10-admin

Specifies the operations / management API (`./admin`) over the `restate-server`
admin REST surface, plus the Molty operating runbook. Builds on
[../requirements.md](../requirements.md) + [./requirements.md](./requirements.md);
terms in [../glossary.md](../glossary.md); rationale in
[../.decisions/0018](../.decisions/0018-admin-management-api.md). See
[../spec.md](../spec.md) for the index.

Traces: R31 (the operator drives the cancel/kill edges that
[04-error-boundary](../04-error-boundary/spec.md#cancellation--interruption)
surfaces from inside a handler).

## 1. Operations / management API (`./admin`)

An opt-in `./admin` subpath (a separate dependency-light subpath like `./otel` /
`./testing`, NOT on the core `.` export) exposes a typed surface over the
`restate-server` ADMIN REST API for OPERATING a running deployment. `RestateAdmin`
is the Tag; `RestateAdmin.layer({ adminUrl, apiKey? })` (or `layerConfig` reading
`RESTATE_ADMIN_URL` / `RESTATE_ADMIN_KEY`) the layer — MIRRORING the
`RestateIngress` pattern (see [05-clients](../05-clients/spec.md),
[../.decisions/0016](../.decisions/0016-secured-ingress-and-request-identity.md))
but bound to the ADMIN url, not ingress. Every operation is an Effect failing with
`RestateError({ reason: 'AdminFailed' })`.

| Group         | Operations                                                                      | Endpoint(s)                                |
| ------------- | ------------------------------------------------------------------------------- | ------------------------------------------ |
| Invocations   | `cancel` / `kill` / `pause` / `resume` / `purge` / `purgeJournal` / `delete`    | `PATCH\|DELETE /invocations/{id}[/{verb}]` |
| Invocations   | `restartAsNew({ from?, deployment? })` → `{ newInvocationId }`                  | `PATCH /invocations/{id}/restart-as-new`   |
| Deployments   | `registerDeployment` / `listDeployments` / `getDeployment` / `updateDeployment` | `POST\|GET\|PATCH /deployments[/{id}]`     |
| Introspection | `query(sql, rowSchema)` (typed) / `queryRaw(sql)`                               | `POST /query` (SQL over `sys_*`)           |

- **Typed-passthrough introspection.** The `/query` SQL rows are the server's shape
  (the `sys_*` columns), which the binding does NOT own. `query` is a thin TYPED
  passthrough: the caller supplies the SQL AND the row Schema, and the binding only
  threads them through and `Schema.decodeUnknown`s each row (a decode mismatch →
  `AdminFailed`). `queryRaw` is the untyped escape hatch. This keeps the binding
  from owning — and evolving with — the `sys_*` schema.
- **One bare client, no drift.** The raw HTTP lives in ONE module (`AdminApi.ts`)
  that BOTH `./admin` and the harness ([09-testing](../09-testing/spec.md)'s
  `stateOf` + deployment registration) consume — lifting the harness's
  previously-duplicated fetch-against-admin code.

### 1.1 Trust boundary

The admin API is a DIFFERENT, more dangerous trust boundary than the SDK
invocation protocol:

- **Unauthenticated by default — never expose it publicly.** Reaching the admin
  port lets anyone cancel/kill invocations, mutate State, and read every `sys_*`
  row. Keep it on a trusted network or behind an authenticating proxy; for a
  secured / Cloud admin endpoint pass a bearer `apiKey` (`Redacted<string>`,
  unwrapped only at the request boundary — decision 0016).
- **Less stable than the SDK protocol — pinned.** Endpoint shapes, query params,
  and the `sys_*` SQL schema change across server versions; `./admin` is pinned to
  **restate-server 1.6.2 (admin-api-version 3)** and verified against it.

### 1.2 Operating a deployment — the Molty runbook

The recipe (`examples/13-admin-operations.ts`, verified by
`src/admin/admin.integration.test.ts`) models an `incident` Virtual Object (single-writer
state machine) + a `delivery` Workflow that can WEDGE, and the flows a production
consumer runs: LIST invocations (filter by `target_service_name` / `status`),
INSPECT workflow / QUERY object State (`SELECT … FROM state` or `stateOf`), SURFACE
STUCK deliveries (non-terminal invocations, ranked by `retry_count`), and
CANCEL/KILL/restart a wedged invocation. See the guide's
[admin operations](../../guide/admin-operations.md) page.

Version caveats verified against 1.6.2: the BULK/BATCH invocation verbs (a filtered
`PATCH /invocations/{verb}`) do NOT exist (they 405) — a later-server feature; and
a WORKFLOW `run` blocked on a long durable wait reports `status = 'running'` (not
`suspended` like an Object handler), so "stuck" is non-terminal-ranked-by-retries,
not a single status.
