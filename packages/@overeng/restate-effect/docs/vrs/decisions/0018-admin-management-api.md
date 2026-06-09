# Admin / management API (`./admin`)

A production consumer (Molty notifications) validated the programming model but
found the gaps were OPERATIONAL: there was no first-class way to LIST/INSPECT
invocations, QUERY a Virtual-Object key's State, CANCEL/KILL/retry a wedged
invocation, or SURFACE stuck deliveries. The `restate-server` admin REST API does
all of this, but a consumer had to hand-roll `fetch` calls (the cancellation
integration test did exactly that). This decision ships a typed `./admin` surface
over the admin API.

## Surface

A new OPT-IN subpath `./admin` — a separate dependency-light subpath like `./otel`
/ `./testing`, NOT on the core `.` export — exporting a `RestateAdmin` Tag +
`layer({ adminUrl, apiKey? })`, MIRRORING the `RestateIngress` Tag/layer pattern
(decision 0016). Every operation is an Effect failing with the existing
`RestateError`, under a new `reason: 'AdminFailed'`.

Operations map 1:1 onto the admin REST endpoints (verified against restate-server
1.6.2, admin-api-version 3):

- **Invocations** — `cancel` / `kill` / `pause` / `resume` / `purge` /
  `purgeJournal` / `delete` (`PATCH|DELETE /invocations/{id}/…`), and
  `restartAsNew` (`PATCH /invocations/{id}/restart-as-new`, with `from` =
  restart-from-journal-prefix and `deployment` = pin).
- **Deployments** — `registerDeployment` / `listDeployments` / `getDeployment` /
  `updateDeployment` (`POST|GET|PATCH /deployments[/{id}]`).
- **Introspection** — `query(sql, rowSchema)` / `queryRaw(sql)` over `POST /query`
  (SQL on the `sys_*` tables).

The raw HTTP lives in ONE bare-client module (`AdminApi.ts`) that BOTH `./admin`
and the test harness (`./testing`) consume — lifting the duplicated fetch-against-
admin code the harness already had (`queryStateRows` / `putState` / deployment
registration), so the two surfaces never drift on a server quirk.

## Typed-passthrough introspection

The `/query` SQL endpoint returns rows whose shape the binding does NOT own (the
`sys_invocation` / `state` columns are the server's, and consumers query arbitrary
columns). So `query` is a THIN TYPED PASSTHROUGH: the CALLER supplies the SQL AND
the row Schema, and the binding only threads them through the admin API and
`Schema.decodeUnknown`. A decode mismatch surfaces as an `AdminFailed`
`RestateError` (no silent garbage). `queryRaw` is the untyped escape hatch. This
keeps the binding from owning — and having to evolve with — the `sys_*` schema,
while still giving the caller a typed result for the columns they DID select.

## Trust boundary (load-bearing)

The admin API is a DIFFERENT, more dangerous trust boundary than the SDK
invocation protocol, and the module documents it prominently:

- **Unauthenticated by default; never expose it publicly.** Anyone who can reach
  the admin port can cancel/kill invocations, mutate State, and read every `sys_*`
  row. Keep it on a trusted network (private subnet / Tailscale / localhost) or
  behind an authenticating proxy. For a secured / Restate Cloud admin endpoint,
  pass a bearer `apiKey` (a `Redacted<string>`, unwrapped only at the request
  boundary — same discipline as the ingress key, decision 0016).
- **Less stable than the SDK protocol; pinned.** Endpoint shapes, query params,
  and the `sys_*` SQL schema change across server versions. `./admin` is PINNED to
  restate-server 1.6.2 and the shapes are verified against it.

## Version caveats found against 1.6.2 (verified)

- The BULK/BATCH invocation verbs (a filtered `PATCH /invocations/{verb}` body) do
  NOT exist on 1.6.2 — they return **405**. They are a later-server feature; the
  binding does not pretend to offer them on a server that lacks them (a follow-up
  when a newer server is the floor).
- A WORKFLOW `run` blocked on a long durable wait reports `sys_invocation.status =
'running'` (it does NOT flip to `suspended` like a stateless Service / Virtual
  Object handler). So "surface stuck deliveries" is "non-terminal, ranked by
  `retry_count`", not a single `status` match — the recipe + its SQL reflect this.

## Consequences

- New public surface: the `./admin` subpath (`RestateAdmin` + layer), a new
  `RestateError` reason `AdminFailed`, and the shared `AdminApi.ts` bare client.
- "Admin / management wrappers" is REMOVED from the Deferred list (now shipped).
- Verified server-free (`src/admin.test.ts`: per-op method/path/auth + typed-query
  decode-failure) and against a real native server (`src/admin.integration.test.ts`:
  list deployments, a typed `/query` round-trip, QUERY an incident object's State,
  and surface + cancel a wedged delivery). The runbook recipe is
  `examples/13-admin-operations.ts`.

Status: accepted
