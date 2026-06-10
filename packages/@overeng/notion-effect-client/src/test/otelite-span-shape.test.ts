/**
 * D3 demonstrator (decision 0015): a REAL-consumer span-assertion test that
 * lives in the consumer's own suite. It drives this client's REAL instrumented
 * HTTP path (`NotionDatabases.query` → `executeRequest` → `Effect.withSpan
 * ('NotionHttp.POST')`) against a STUB upstream — no secrets, no network — and
 * asserts the emitted span shape via the otelite vitest capture bridge.
 *
 * Why co-located here, not in utils-dev: the churn-coupled assertions (the
 * `notion.http.*` attribute names, the templated-route key) sit next to the
 * instrumentation that churns. The bridge (`@overeng/utils-dev/otelite`) stays
 * a lean shared helper.
 *
 * The HttpClient-shadowing gotcha: `makeOteliteCaptureLayer` re-exports
 * `HttpClient.HttpClient` (the exporter's internal `FetchHttpClient`). If the
 * consumer resolved THAT, its "stub" requests would hit the real
 * `api.notion.com`. We provide the stub to the effect-under-test directly
 * (`Effect.provide`, innermost-wins) so the consumer sees the stub while the
 * exporter keeps its own client. The proof the stub is used: the captured span
 * carries the templated route + our canned status + our canned rate-limit
 * header, which only the stub produces (a real call with `stub-token` would
 * 401, not 200).
 */

import { HttpClient, HttpClientResponse } from '@effect/platform'
import { expect, layer } from '@effect/vitest'
import { Effect, Layer, Redacted } from 'effect'

import {
  flushCaptureSpans,
  makeOteliteCaptureLayer,
  OteliteCapture,
} from '@overeng/utils-dev/otelite'

import { NotionConfig } from '../config.ts'
import { NotionDatabases } from '../databases.ts'

const exportInterval = 100

/** Per-file capture receiver + OTLP exporter pointed at it (decision 0015). */
const CaptureLayer = makeOteliteCaptureLayer({ exportInterval })

/** A 32-hex data source id so the route templates to `{data_source_id}`. */
const DATA_SOURCE_ID = '0123456789abcdef0123456789abcdef'

/**
 * Dummy config — nothing validates the token; the stub never reads it. The
 * `Bearer <token>` header it produces never reaches the captured spans
 * (asserted below as a public-repo leak guard).
 */
const NotionConfigStub = Layer.succeed(NotionConfig, {
  authToken: Redacted.make('stub-token-not-a-secret'),
  retryEnabled: false,
})

/**
 * Stub upstream: answers the ONE instrumented endpoint the query path hits
 * (`POST /data_sources/{id}/query`) with a minimal-but-valid empty paginated
 * list + a couple of canned Notion headers. No network, no secrets.
 */
const StubHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({ object: 'list', results: [], next_cursor: null, has_more: false }),
          {
            status: 200,
            headers: {
              'content-type': 'application/json',
              'x-ratelimit-remaining': '42',
              'x-request-id': 'stub-request-id',
            },
          },
        ),
      ),
    ),
  ),
)

// `excludeTestServices: true` runs on the REAL clock so the OTLP exporter's
// batch loop + the flush sleep tick against wall time.
layer(CaptureLayer, { excludeTestServices: true })('NotionHttp span shape (D3)', (it) => {
  it.effect('emits a NotionHttp.POST span with the templated route against a stub upstream', () =>
    Effect.gen(function* () {
      const cap = yield* OteliteCapture

      // Drive the REAL instrumented path. Stub + config provided to THIS effect
      // (innermost-wins) so the consumer's `HttpClient.HttpClient` is the stub,
      // not the exporter's re-exported FetchHttpClient.
      const result = yield* NotionDatabases.query({ dataSourceId: DATA_SOURCE_ID }).pipe(
        Effect.provide(Layer.mergeAll(StubHttpClientLayer, NotionConfigStub)),
      )
      expect(result.results).toHaveLength(0)

      yield* flushCaptureSpans({ exportInterval })

      // (a) exactly one NotionHttp.POST span per HTTP call (one page fetched).
      const notionHttpSpans = yield* cap.inspect({ signal: 'traces', name: 'NotionHttp.POST' })
      expect(notionHttpSpans).toHaveLength(1)
      const span = notionHttpSpans[0]!
      expect(span.schema).toBe('otelite.span/v1')

      // (b) the templated route + stable consumer attributes. The templated
      // form + the 200 status PROVE the stub served the request (a real call
      // with `stub-token` would 401).
      expect(span.attrs['notion.http.route']).toBe('/data_sources/{data_source_id}/query')
      expect(span.attrs['notion.http.method']).toBe('POST')
      expect(span.attrs['notion.http.operation']).toBe('data_sources.query')
      expect(span.attrs['notion.http.status_code']).toBe('200')
      expect(span.attrs['notion.rate_limit.remaining']).toBe('42')

      // (c) silent-export guard: a non-zero span count, asserted explicitly.
      const summary = yield* cap.inspect({ signal: 'traces', summary: true })
      expect(summary.span_count).toBeGreaterThanOrEqual(1)

      // The auto `http.client POST` child from @effect/platform exists —
      // confirming our stub HttpClient (not the exporter's FetchHttpClient) is
      // the one being instrumented (its `url.path` is the stubbed query path).
      const httpClientSpans = yield* cap.inspect({ signal: 'traces', name: 'http.client POST' })
      expect(httpClientSpans).toHaveLength(1)
      expect(httpClientSpans[0]!.attrs['url.path']).toBe(`/v1/data_sources/${DATA_SOURCE_ID}/query`)

      // (d) public-repo leak guard: the `Bearer <token>` Authorization header
      // never reaches the captured spans — @effect/platform records only a
      // header subset and excludes Authorization. Assert NO captured span
      // attribute carries an auth header or the token value.
      const allSpans = yield* cap.inspect({ signal: 'traces' })
      for (const captured of allSpans) {
        for (const [key, value] of Object.entries(captured.attrs)) {
          expect(key.toLowerCase()).not.toContain('authorization')
          expect(value).not.toContain('stub-token-not-a-secret')
          expect(value).not.toContain('Bearer ')
        }
      }
    }),
  )
})
