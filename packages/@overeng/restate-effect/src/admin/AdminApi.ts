/**
 * The bare (Promise-based) Restate admin / management API client — the single
 * place the raw `fetch`-against-admin calls live. It is consumed by BOTH the
 * public `./admin` Effect surface (`RestateAdmin`, `admin.ts`) and the test
 * harness (`./testing`, which speaks the admin API internally for State
 * inspection + deployment registration). Keeping it in ONE module means the two
 * never drift and a server-version quirk is fixed once.
 *
 * Pinned to the restate-server 1.6.2 admin API (admin-api-version 3, verified):
 * the per-invocation lifecycle ops are `PATCH /invocations/{id}/{verb}`, the
 * introspection surface is `POST /query` (SQL over the `sys_*` tables), and
 * deployment management is `GET|PATCH /deployments[/{id}]`. The BULK/BATCH
 * invocation verbs (a filtered `PATCH /invocations/{verb}` body) do NOT exist on
 * 1.6.2 — they return 405 — and are a later-server feature (see `./admin`'s
 * trust-boundary doc + decision 0018).
 *
 * SECURITY / TRUST BOUNDARY: the admin API is UNAUTHENTICATED by default and MUST
 * NOT be exposed publicly (decision 0018). An optional bearer `apiKey` is threaded
 * as `Authorization: Bearer <key>` for a secured/Cloud admin endpoint; it is
 * unwrapped from its `Redacted` only here, at the request boundary (never logged).
 */
import { Redacted } from 'effect'

/** Configuration for the bare admin client: the admin base URL + an optional bearer key. */
export interface AdminClientConfig {
  /** The `restate-server` ADMIN base URL (e.g. `http://localhost:9070`). NOT the ingress URL. */
  readonly adminUrl: string
  /**
   * An OPTIONAL bearer API key for a secured / Restate Cloud admin endpoint, sent
   * as `Authorization: Bearer <key>`. A `Redacted` so it never prints; unwrapped
   * only at the request boundary. Unset → an unauthenticated (local) admin API.
   */
  readonly apiKey?: Redacted.Redacted<string>
}

/** A thrown admin-call failure carrying the HTTP status + response body for diagnosis. */
export class AdminHttpError extends Error {
  readonly status: number
  readonly body: string
  constructor(method: string, status: number, body: string) {
    super(`admin call ${method} failed (${status})${body !== '' ? `: ${body}` : ''}`)
    this.name = 'AdminHttpError'
    this.status = status
    this.body = body
  }
}

const authHeaders = (config: AdminClientConfig): Record<string, string> =>
  config.apiKey !== undefined ? { Authorization: `Bearer ${Redacted.value(config.apiKey)}` } : {}

/** Issue one admin request, throwing {@link AdminHttpError} on a non-OK status. */
const request = async (
  config: AdminClientConfig,
  method: string,
  path: string,
  opts?: { readonly body?: unknown; readonly accept?: string },
): Promise<Response> => {
  const headers: Record<string, string> = { ...authHeaders(config) }
  if (opts?.body !== undefined) headers['content-type'] = 'application/json'
  if (opts?.accept !== undefined) headers['accept'] = opts.accept
  const res = await fetch(`${config.adminUrl}${path}`, {
    method,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new AdminHttpError(`${method} ${path}`, res.status, text)
  }
  return res
}

/** Parse a response body as JSON (an empty body — common for a 202 — becomes `{}`). */
const json = async <T>(res: Response): Promise<T> => {
  const text = await res.text()
  return (text === '' ? {} : JSON.parse(text)) as T
}

/* ── Invocation lifecycle (per-id `PATCH /invocations/{id}/{verb}`) ─────────── */

/** The per-id invocation verbs exposed on the 1.6.2 admin API. */
export type InvocationVerb =
  | 'cancel'
  | 'kill'
  | 'pause'
  | 'resume'
  | 'purge'
  | 'purge-journal'
  | 'restart-as-new'

/** `PATCH /invocations/{id}/{verb}` with optional query params (no request body). */
export const patchInvocation = async (
  config: AdminClientConfig,
  invocationId: string,
  verb: InvocationVerb,
  query?: Readonly<Record<string, string>>,
): Promise<void> => {
  const qs =
    query !== undefined && Object.keys(query).length > 0
      ? `?${new URLSearchParams(query).toString()}`
      : ''
  await request(config, 'PATCH', `/invocations/${encodeURIComponent(invocationId)}/${verb}${qs}`)
}

/** `PATCH /invocations/{id}/restart-as-new` → the new invocation id (admin api ≥3). */
export const restartAsNew = async (
  config: AdminClientConfig,
  invocationId: string,
  query?: Readonly<Record<string, string>>,
): Promise<{ readonly new_invocation_id: string }> => {
  const qs =
    query !== undefined && Object.keys(query).length > 0
      ? `?${new URLSearchParams(query).toString()}`
      : ''
  const res = await request(
    config,
    'PATCH',
    `/invocations/${encodeURIComponent(invocationId)}/restart-as-new${qs}`,
  )
  return json(res)
}

/** `DELETE /invocations/{id}` — remove the completed invocation (output + journal). */
export const deleteInvocation = async (
  config: AdminClientConfig,
  invocationId: string,
  mode?: string,
): Promise<void> => {
  const qs = mode !== undefined ? `?mode=${encodeURIComponent(mode)}` : ''
  await request(config, 'DELETE', `/invocations/${encodeURIComponent(invocationId)}${qs}`)
}

/* ── Deployments (`GET|PATCH /deployments[/{id}]`) ─────────────────────────── */

/** `POST /deployments` — register a deployment by handler-endpoint URI (`force` overwrites). */
export const registerDeployment = async (
  config: AdminClientConfig,
  uri: string,
  opts?: { readonly force?: boolean },
): Promise<unknown> => {
  const res = await request(config, 'POST', '/deployments', {
    body: { uri, ...(opts?.force !== undefined ? { force: opts.force } : { force: true }) },
  })
  return json(res)
}

/** `GET /deployments` — list registered deployments + their services. */
export const listDeployments = async (config: AdminClientConfig): Promise<unknown> =>
  json(await request(config, 'GET', '/deployments'))

/** `GET /deployments/{id}` — one deployment's detail. */
export const getDeployment = async (config: AdminClientConfig, id: string): Promise<unknown> =>
  json(await request(config, 'GET', `/deployments/${encodeURIComponent(id)}`))

/** `PATCH /deployments/{id}` — update headers / address / role (the `UpdateDeploymentRequest`). */
export const updateDeployment = async (
  config: AdminClientConfig,
  id: string,
  body: Readonly<Record<string, unknown>>,
): Promise<unknown> =>
  json(await request(config, 'PATCH', `/deployments/${encodeURIComponent(id)}`, { body }))

/* ── Introspection (`POST /query`, SQL over `sys_*`) ───────────────────────── */

/**
 * `POST /query` — run a SQL query over the `sys_*` introspection tables (e.g.
 * `sys_invocation`, `state`). With `Accept: application/json` the result is
 * `{ rows: [...] }` (no Apache Arrow dependency); a binary column rides as a HEX
 * string. The caller supplies the row shape (the binding does not own those
 * shapes), so this returns the raw rows for the `./admin` `query` to decode
 * through a caller-supplied Schema.
 */
export const query = async (
  config: AdminClientConfig,
  sql: string,
): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const res = await request(config, 'POST', '/query', {
    body: { query: sql },
    accept: 'application/json',
  })
  const body = await json<{ readonly rows?: ReadonlyArray<Record<string, unknown>> }>(res)
  return body.rows ?? []
}

/* ── State inspection/seed (reused by `./testing`'s `stateOf`) ─────────────── */

/**
 * Read the raw `{ key, value-bytes }` pairs for one service + key via `POST
 * /query` (the binary `value` column as a HEX string under `Accept:
 * application/json`). Lifted from the harness so `./testing` and any future
 * `./admin` State surface share ONE implementation.
 */
export const queryStateRows = async (
  config: AdminClientConfig,
  service: string,
  serviceKey: string,
): Promise<ReadonlyArray<{ readonly key: string; readonly value: Uint8Array }>> => {
  const rows = await query(
    config,
    `SELECT key, value FROM state WHERE service_name = '${service}' AND service_key = '${serviceKey}'`,
  )
  return rows.flatMap((row) => {
    const key = row['key']
    if (typeof key !== 'string') return []
    return [{ key, value: decodeQueryValue(row['value']) }]
  })
}

/**
 * Decode a `value` cell from a JSON state query into bytes. Restate-server 1.6.2
 * emits a binary column as a HEX string in JSON mode (verified). Tolerate a
 * `number[]` (raw byte array) fallback so the client survives a future server
 * build that changes the JSON binary encoding.
 */
const decodeQueryValue = (value: unknown): Uint8Array => {
  if (typeof value === 'string') return Uint8Array.from(Buffer.from(value, 'hex'))
  if (Array.isArray(value) === true) return Uint8Array.from(value as ReadonlyArray<number>)
  return new TextEncoder().encode(typeof value === 'undefined' ? '' : JSON.stringify(value))
}

/**
 * Push the full `{ key → bytes }` set for one service + key to the Admin state
 * mutation endpoint (`POST /services/{service}/state`), encoding each value as a
 * byte array (the `new_state` wire form).
 */
export const putState = async (
  config: AdminClientConfig,
  service: string,
  serviceKey: string,
  entries: ReadonlyArray<readonly [string, Uint8Array]>,
): Promise<void> => {
  await request(config, 'POST', `/services/${encodeURIComponent(service)}/state`, {
    body: {
      object_key: serviceKey,
      new_state: Object.fromEntries(entries.map(([k, v]) => [k, Array.from(v)])),
    },
  })
}
