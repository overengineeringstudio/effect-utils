/**
 * The `HttpClient` Effect's OTLP exporters post through in a browser. Effect's exporter keeps
 * batching, retry and the scope-close flush; this transport adds the browser policy:
 *
 * - **Same origin**: requests use `credentials: 'same-origin'` so application-owned cookies
 *   reach the relay; the application server owns authentication and collector forwarding.
 * - **Offline drop**: while `navigator.onLine` is false a batch is dropped and answered with a
 *   synthetic 204, so the exporter neither retries nor trips its 60 s self-disable.
 * - **Size**: batches above `maxBodyBytes` (the relay's limit) are dropped, not sent to be refused.
 * - **keepalive**: bodies within the 64 KiB keepalive quota use `fetch(..., { keepalive: true })`,
 *   so an export started just before navigation still completes.
 * - **Hiding**: once the page is hidden the transport switches to `navigator.sendBeacon`, which
 *   queues synchronously and survives unload; a rejected beacon (quota) is counted as dropped.
 */
import { Effect } from 'effect'
import * as Headers from 'effect/http/Headers'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientError from 'effect/http/HttpClientError'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import { BrowserPlatform } from './BrowserPlatform.ts'

/** Browser export body-size limits. */
export interface TransportOptions {
  /** Largest body sent with `keepalive` (browsers cap in-flight keepalive bodies at 64 KiB). */
  readonly keepaliveMaxBytes?: number | undefined
  /** Batches above this are dropped; keep it at or below the relay's request limit. */
  readonly maxBodyBytes?: number | undefined
}

/** Counters for completed sends and policy-driven drops. */
export interface TransportStats {
  readonly sent: number
  readonly beacons: number
  readonly droppedOffline: number
  readonly droppedOversize: number
  readonly droppedBeaconRejected: number
}

/** Browser-aware OTLP HTTP client and lifecycle controls. */
export interface Transport {
  readonly client: HttpClient.HttpClient
  /** `true` while the page is hidden: exports go out as beacons. */
  readonly setHiding: (hiding: boolean) => void
  readonly stats: () => TransportStats
}

/** Default keepalive budget below the browser's 64 KiB in-flight quota. */
export const defaultKeepaliveMaxBytes = 60_000
/** Default maximum relay request body size in bytes. */
export const defaultMaxBodyBytes = 512 * 1024

/** Creates an OTLP transport using the current browser platform. */
export const make = Effect.fnUntraced(function* (options?: TransportOptions) {
  const platform = yield* BrowserPlatform
  const keepaliveMaxBytes = options?.keepaliveMaxBytes ?? defaultKeepaliveMaxBytes
  const maxBodyBytes = options?.maxBodyBytes ?? defaultMaxBodyBytes
  let hiding = false
  const stats = {
    sent: 0,
    beacons: 0,
    droppedOffline: 0,
    droppedOversize: 0,
    droppedBeaconRejected: 0,
  }

  const client = HttpClient.make((request, url, signal) => {
    const accepted = (status: number) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status })))
    if (url.origin !== platform.origin) {
      return Effect.die(
        new Error(`otel-browser transport only posts same-origin, got ${url.origin}`),
      )
    }
    if (platform.isOnline() === false) {
      stats.droppedOffline += 1
      return accepted(204)
    }
    const body = request.body
    // Effect types the bytes `ArrayBufferLike`; OTLP JSON/protobuf bodies are always plain
    // `ArrayBuffer`-backed, which is what `Blob`/`fetch` require.
    const bytes = body._tag === 'Uint8Array' ? (body.body as Uint8Array<ArrayBuffer>) : undefined
    const contentType = body._tag === 'Uint8Array' ? body.contentType : 'application/json'
    if (bytes === undefined) return Effect.die(new Error(`unsupported OTLP body ${body._tag}`))
    if (bytes.byteLength > maxBodyBytes) {
      stats.droppedOversize += 1
      return accepted(204)
    }
    if (hiding === true && platform.sendBeacon !== undefined) {
      const queued = platform.sendBeacon({
        url: url.toString(),
        body: new Blob([bytes], { type: contentType }),
      })
      if (queued === true) stats.beacons += 1
      else stats.droppedBeaconRejected += 1
      return accepted(queued === true ? 202 : 204)
    }
    // The exporter's own `user-agent` header is meaningless from a page and would force a CORS
    // preflight if the relay ever moves cross-origin.
    const headers = Headers.removeMany(request.headers, ['user-agent', 'content-length'])
    return Effect.tryPromise({
      try: () =>
        platform.fetch({
          input: url,
          init: {
            method: request.method,
            headers: { ...headers, 'content-type': contentType },
            body: bytes,
            credentials: 'same-origin',
            keepalive: bytes.byteLength <= keepaliveMaxBytes,
            signal,
          },
        }),
      catch: (cause) =>
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause }),
        }),
    }).pipe(
      Effect.map((response) => {
        stats.sent += 1
        return HttpClientResponse.fromWeb(request, response)
      }),
    )
  })

  const transport: Transport = {
    client,
    setHiding: (next) => {
      hiding = next
    },
    stats: () => ({ ...stats }),
  }
  return transport
})
