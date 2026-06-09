/**
 * `@overeng/restate-effect/admin` — the opt-in Restate admin / management API
 * surface (decision 0018, spec §12). A `RestateAdmin` Tag + `layer({ adminUrl })`
 * MIRRORING the `RestateIngress` Tag/layer pattern, exposing the admin REST
 * endpoints as Effect combinators that fail with a typed
 * `RestateError({ reason: 'AdminFailed' })`.
 *
 * The raw HTTP lives in `AdminApi.ts` (the SINGLE bare-client module the test
 * harness also speaks); this module is the thin Effect + typed-error wrapper.
 *
 * ## TRUST BOUNDARY (read before exposing this)
 *
 * The admin API is **unauthenticated by default** and MUST NOT be reachable from
 * the public internet — anyone who can reach it can cancel/kill invocations,
 * mutate State, and read every row of every `sys_*` table. Keep it on a trusted
 * network (a private subnet / Tailscale / localhost) or in front of an
 * authenticating proxy. For a secured / Restate Cloud admin endpoint, pass a
 * bearer `apiKey` (a `Redacted<string>`).
 *
 * The admin API is also LESS STABLE than the SDK invocation protocol: endpoint
 * shapes, query params, and the `sys_*` SQL schema change across server versions.
 * This module is PINNED to **restate-server 1.6.2 (admin-api-version 3)** and the
 * shapes are verified against it. Notably the BULK/BATCH invocation verbs (a
 * filtered `PATCH /invocations/{verb}`) do NOT exist on 1.6.2 — they 405 — and are
 * a later-server feature; {@link RestateAdmin.batch} surfaces them behind that
 * explicit version caveat (see decision 0018).
 *
 * ```ts
 * Effect.gen(function* () {
 *   const admin = yield* RestateAdmin
 *   yield* admin.cancel(invocationId) // PATCH /invocations/{id}/cancel
 *   const stuck = yield* admin.query(
 *     `SELECT id, target_handler_name, retry_count FROM sys_invocation WHERE status = 'backing-off'`,
 *     StuckRow, // the caller-owned row Schema
 *   )
 * }).pipe(Effect.provide(RestateAdmin.layer({ adminUrl: 'http://localhost:9070' })))
 * ```
 */
import type { Redacted } from 'effect'
import { Config, type ConfigError, Context, Effect, Layer, Option, Schema } from 'effect'

import {
  type AdminClientConfig,
  deleteInvocation as bareDeleteInvocation,
  getDeployment as bareGetDeployment,
  type InvocationVerb,
  listDeployments as bareListDeployments,
  patchInvocation as barePatchInvocation,
  query as bareQuery,
  registerDeployment as bareRegisterDeployment,
  restartAsNew as bareRestartAsNew,
  updateDeployment as bareUpdateDeployment,
} from './AdminApi.ts'
import { RestateError } from './RestateError.ts'

/** Wrap a bare admin Promise in an Effect that fails with a typed `AdminFailed` error. */
const adminCall = <A>(method: string, run: () => Promise<A>): Effect.Effect<A, RestateError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new RestateError({ reason: 'AdminFailed', method, cause }),
  })

/**
 * The service shape held by the `RestateAdmin` Tag — the admin/management
 * operations bound to one `restate-server` admin URL. Built once from the bare
 * `AdminApi` client; each method is an Effect failing with a typed `RestateError`.
 */
export interface RestateAdminService {
  /** The bound admin base URL (NOT the ingress URL). */
  readonly adminUrl: string

  /* ── Invocation lifecycle ────────────────────────────────────────────────── */

  /** Cancel an invocation gracefully (`PATCH /invocations/{id}/cancel`) — finalizers run, no retry (R31). */
  readonly cancel: (invocationId: string) => Effect.Effect<void, RestateError>
  /** Kill an invocation immediately (`PATCH /invocations/{id}/kill`) — no graceful cancellation. */
  readonly kill: (invocationId: string) => Effect.Effect<void, RestateError>
  /** Pause an invocation (`PATCH /invocations/{id}/pause`) — stop scheduling further attempts. */
  readonly pause: (invocationId: string) => Effect.Effect<void, RestateError>
  /**
   * Resume a paused invocation (`PATCH /invocations/{id}/resume`), optionally
   * pinning it to a specific `deployment` id.
   */
  readonly resume: (
    invocationId: string,
    opts?: { readonly deployment?: string },
  ) => Effect.Effect<void, RestateError>
  /** Purge a COMPLETED invocation's output + journal (`PATCH /invocations/{id}/purge`). */
  readonly purge: (invocationId: string) => Effect.Effect<void, RestateError>
  /** Purge a COMPLETED invocation's journal only, keeping the result (`PATCH /invocations/{id}/purge-journal`). */
  readonly purgeJournal: (invocationId: string) => Effect.Effect<void, RestateError>
  /** Delete a completed invocation entirely (`DELETE /invocations/{id}`). */
  readonly delete: (
    invocationId: string,
    opts?: { readonly mode?: string },
  ) => Effect.Effect<void, RestateError>
  /**
   * Restart a completed invocation as a NEW invocation (`PATCH
   * /invocations/{id}/restart-as-new`, admin-api ≥3), returning the new
   * invocation id. `from` restarts from a JOURNAL-PREFIX entry index (replaying up
   * to it); `deployment` pins the new invocation to a deployment.
   */
  readonly restartAsNew: (
    invocationId: string,
    opts?: { readonly from?: number; readonly deployment?: string },
  ) => Effect.Effect<{ readonly newInvocationId: string }, RestateError>

  /* ── Deployments ─────────────────────────────────────────────────────────── */

  /** Register a deployment by handler-endpoint URI (`POST /deployments`, `force` overwrites). */
  readonly registerDeployment: (
    uri: string,
    opts?: { readonly force?: boolean },
  ) => Effect.Effect<unknown, RestateError>
  /** List registered deployments + their services (`GET /deployments`). */
  readonly listDeployments: () => Effect.Effect<unknown, RestateError>
  /** Get one deployment's detail (`GET /deployments/{id}`). */
  readonly getDeployment: (id: string) => Effect.Effect<unknown, RestateError>
  /** Update a deployment's headers / address / role (`PATCH /deployments/{id}`). */
  readonly updateDeployment: (
    id: string,
    body: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, RestateError>

  /* ── Introspection ───────────────────────────────────────────────────────── */

  /**
   * Run a SQL query over the `sys_*` introspection tables (`POST /query`) and
   * DECODE each row through the caller-supplied `rowSchema` — a thin typed
   * passthrough, since the binding does not own the `sys_*` row shapes. The caller
   * owns the SQL and the row Schema; this only threads them through the admin API
   * and `Schema.decodeUnknown`. A decode failure surfaces as an `AdminFailed`
   * `RestateError`.
   */
  readonly query: <A, I>(
    sql: string,
    rowSchema: Schema.Schema<A, I>,
  ) => Effect.Effect<ReadonlyArray<A>, RestateError>
  /** As {@link query} but returns the RAW untyped rows (no Schema decode). */
  readonly queryRaw: (
    sql: string,
  ) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, RestateError>
}

/* Build a `RestateAdminService` from a bare admin client config. */
const makeAdmin = (config: AdminClientConfig): RestateAdminService => {
  const patch = (id: string, verb: InvocationVerb, query?: Readonly<Record<string, string>>) =>
    adminCall(`admin.${verb}(${id})`, () => barePatchInvocation(config, id, verb, query))
  return {
    adminUrl: config.adminUrl,
    cancel: (id) => patch(id, 'cancel'),
    kill: (id) => patch(id, 'kill'),
    pause: (id) => patch(id, 'pause'),
    resume: (id, opts) =>
      patch(
        id,
        'resume',
        opts?.deployment !== undefined ? { deployment: opts.deployment } : undefined,
      ),
    purge: (id) => patch(id, 'purge'),
    purgeJournal: (id) => patch(id, 'purge-journal'),
    delete: (id, opts) =>
      adminCall(`admin.delete(${id})`, () => bareDeleteInvocation(config, id, opts?.mode)),
    restartAsNew: (id, opts) =>
      adminCall(`admin.restartAsNew(${id})`, () =>
        bareRestartAsNew(config, id, {
          ...(opts?.from !== undefined ? { from: String(opts.from) } : {}),
          ...(opts?.deployment !== undefined ? { deployment: opts.deployment } : {}),
        }),
      ).pipe(Effect.map((r) => ({ newInvocationId: r.new_invocation_id }))),
    registerDeployment: (uri, opts) =>
      adminCall('admin.registerDeployment', () => bareRegisterDeployment(config, uri, opts)),
    listDeployments: () => adminCall('admin.listDeployments', () => bareListDeployments(config)),
    getDeployment: (id) =>
      adminCall(`admin.getDeployment(${id})`, () => bareGetDeployment(config, id)),
    updateDeployment: (id, body) =>
      adminCall(`admin.updateDeployment(${id})`, () => bareUpdateDeployment(config, id, body)),
    query: (sql, rowSchema) =>
      adminCall('admin.query', () => bareQuery(config, sql)).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            Schema.decodeUnknown(rowSchema)(row).pipe(
              Effect.mapError(
                (cause) =>
                  new RestateError({ reason: 'AdminFailed', method: 'admin.query.decode', cause }),
              ),
            ),
          ),
        ),
      ),
    queryRaw: (sql) => adminCall('admin.queryRaw', () => bareQuery(config, sql)),
  }
}

/* Build the bare-client config from the layer options. */
const toClientConfig = (opts: {
  readonly adminUrl: string
  readonly apiKey?: Redacted.Redacted<string>
}): AdminClientConfig => ({
  adminUrl: opts.adminUrl,
  ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
})

/**
 * The Restate admin / management API service (decision 0018, spec §12). Build the
 * layer with `RestateAdmin.layer({ adminUrl, apiKey? })` (or the env-driven
 * `RestateAdmin.layerConfig`) and `yield* RestateAdmin`. MIRRORS the
 * `RestateIngress` Tag/layer pattern — but points at the admin URL, NOT the
 * ingress URL, and carries the admin-API trust boundary (see the module doc).
 */
export class RestateAdmin extends Context.Tag('@overeng/restate-effect/RestateAdmin')<
  RestateAdmin,
  RestateAdminService
>() {
  /**
   * Build a `RestateAdmin` layer bound to a `restate-server` ADMIN URL (the
   * PRIMITIVE form). For a SECURED / Restate Cloud admin endpoint, pass `apiKey`
   * (a `Redacted<string>`, so the key never prints): it is sent as
   * `Authorization: Bearer <key>` on every admin request. Unset → unauthenticated
   * (a trusted local network only — see the trust-boundary note).
   */
  static layer = (opts: {
    readonly adminUrl: string
    readonly apiKey?: Redacted.Redacted<string>
  }): Layer.Layer<RestateAdmin> => Layer.succeed(RestateAdmin, makeAdmin(toClientConfig(opts)))

  /**
   * Build a `RestateAdmin` layer from `Config` (env-driven): the admin URL from
   * `RESTATE_ADMIN_URL` and an OPTIONAL bearer key from `RESTATE_ADMIN_KEY` (read
   * as a `Config.redacted`, so the secret stays a `Redacted`). A thin
   * `Config`-then-literal wrapper over {@link RestateAdmin.layer}. Fails the layer
   * with a `ConfigError` if `RESTATE_ADMIN_URL` is unset.
   */
  static layerConfig = (): Layer.Layer<RestateAdmin, ConfigError.ConfigError> =>
    Layer.effect(
      RestateAdmin,
      Effect.gen(function* () {
        const url = yield* Config.url('RESTATE_ADMIN_URL')
        const apiKey = yield* Config.option(Config.redacted('RESTATE_ADMIN_KEY'))
        return makeAdmin(
          toClientConfig({
            adminUrl: url.toString().replace(/\/$/, ''),
            ...(Option.isSome(apiKey) === true ? { apiKey: apiKey.value } : {}),
          }),
        )
      }),
    )
}
