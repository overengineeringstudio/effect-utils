/**
 * SEAM member contract for the `notion.*` telemetry namespace (decision 0005) — notion-effect-client's
 * OWN observability catalog, authored via the Layer-2 `@overeng/otel-contract/registry` surface. This
 * is the single home for the client's telemetry attribute catalog: the Weaver registry projection AND
 * the runtime encoders (`src/internal/otel.ts`, `src/internal/metrics.ts`) both derive from it
 * (SC-R13/R14).
 *
 * This is a `*.contract.ts` seam file, so it is exempt from the `otel-contract-in-seam-file` lint and
 * MUST be registered in the root aggregator's `memberSeamPaths` (a colocated no-orphan-seam test
 * asserts this).
 *
 * Placement: `src/` (notion-effect-client has no dependency-free zone; `internal/otel.ts` already
 * imports `@overeng/otel-contract` at runtime, so this file's `./registry` import is dependency-safe).
 *
 * NAMESPACE `notion` (NOT the upstream OTel `http.*` semconv). The client's HTTP-shaped attributes are
 * deliberately FIRST-PARTY `notion.http.*` keys (`notion.http.method`, `notion.http.route`,
 * `notion.http.status_code`, …), not references to the pinned upstream `http.*` registry — so they are
 * OWN attributes, not `refExternal` refs. This namespace is disjoint from notion-md's `notion_md`.
 *
 * DYNAMIC-NAME BRIDGE (SC-DQ5). The per-method request span `NotionHttp.<METHOD>` embeds the HTTP
 * method in its NAME (one of GET/POST/PATCH/DELETE), so it has no stable single-signal registry
 * projection and stays LEGACY inline `OtelOperation.define` in `internal/otel.ts` (mirroring genie's
 * `cli.mode` and megarepo's dynamic bridges). Its `notion.http.*` keys reach the catalog via
 * `docOnlyAttributes` (SC-R13 completeness), rebuilt inline from the IMPORTED catalog schemas below
 * (identical encode — proven by the colocated equivalence property test).
 *
 * ANNOTATE-ONLY BUNDLES. The retry/quota/rate-limit attributes and the throttle-wait attribute are
 * annotated onto the CURRENT (request) span via standalone `OtelAttrs.defineSync` bundles in
 * `internal/otel.ts`, rebuilt from the SAME `attr.*` schema objects (byte-identical encode). Keys that
 * appear only in those bundles or only on the dynamic bridge land in the catalog via
 * `docOnlyAttributes`.
 *
 * METRICS NOT migrated as SIGNALS (rebuilt-label, NOT deferred-for-rename). The rate-limit pressure
 * metrics (`notion_http_attempts_total`, `notion_http_retry_after_total`, `notion_http_retry_after_ms_total`,
 * `notion_rate_limit_wait_ms`) stay raw `OtelMetric` definitions in `internal/metrics.ts` to preserve
 * their exact runtime shape (descriptions, and the counters' ABSENT unit — the registry `metric()` DSL
 * requires a `unit` and so cannot express "no unit"). Their labels ARE namespaced already
 * (`notion.http.method`/`notion.http.operation`), so — unlike restate's bare-label deferral — there is
 * NO wire rename: the label struct is REBUILT from the imported catalog schemas (identical encode,
 * proven by the equivalence test). Those two label keys therefore reach the catalog via
 * `docOnlyAttributes`. Promoting the metrics to registry `metric()` signals is a FLAGGED follow-up.
 */
import { attr, defineOtelContract, operation, required } from '@overeng/otel-contract/registry'

// ---------------------------------------------------------------------------
// attributes (annotated Effect Schemas; the notion.* catalog SSOT)
// ---------------------------------------------------------------------------

// -- http request slice --
/** Notion HTTP request method. */
export const NotionHttpMethod = attr.enum({
  key: 'notion.http.method',
  values: ['GET', 'POST', 'PATCH', 'DELETE'],
  briefs: {
    GET: 'HTTP GET.',
    POST: 'HTTP POST.',
    PATCH: 'HTTP PATCH.',
    DELETE: 'HTTP DELETE.',
  },
  brief: 'Notion HTTP request method.',
  stability: 'development',
})

/** Notion API route template a request targets (parameterized path, not the concrete url). */
export const NotionHttpRoute = attr.string({
  key: 'notion.http.route',
  cardinality: 'bounded',
  brief: 'Notion API route template a request targets (parameterized path, not the concrete url).',
  stability: 'development',
  examples: ['/v1/pages/{id}', '/v1/databases/{id}/query'],
})

/** Sanitized Notion API operation key (bounded — never ids/urls). */
export const NotionHttpOperation = attr.string({
  key: 'notion.http.operation',
  cardinality: 'bounded',
  brief: 'Sanitized Notion API operation key (bounded — never ids/urls).',
  stability: 'development',
  examples: ['pages.retrieve', 'databases.query'],
})

/** HTTP status code of a Notion API response. */
export const NotionHttpStatusCode = attr.number({
  key: 'notion.http.status_code',
  weaverType: 'int',
  cardinality: 'bounded',
  brief: 'HTTP status code of a Notion API response.',
  stability: 'development',
  examples: [200, 429],
})

// -- http retry slice --
/** 1-based attempt number of a Notion HTTP attempt (initial attempt is 1). */
export const NotionHttpRetryAttempt = attr.number({
  key: 'notion.http.retry.attempt',
  weaverType: 'int',
  cardinality: 'low',
  brief: '1-based attempt number of a Notion HTTP attempt (initial attempt is 1).',
  stability: 'development',
  examples: [1, 2],
})

/** Cumulative number of HTTP attempts made for a logical Notion request. */
export const NotionHttpRetryAttempts = attr.number({
  key: 'notion.http.retry.attempts',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Cumulative number of HTTP attempts made for a logical Notion request.',
  stability: 'development',
  examples: [1, 3],
})

/** Backoff delay (ms) applied before a Notion HTTP retry (floored by any server `Retry-After`). */
export const NotionHttpRetryDelayMs = attr.number({
  key: 'notion.http.retry.delay_ms',
  weaverType: 'int',
  cardinality: 'low',
  brief:
    'Backoff delay (ms) applied before a Notion HTTP retry (floored by any server `Retry-After`).',
  stability: 'development',
  examples: [1000, 3000],
})

// -- quota --
/** Logical quota cost charged for a Notion request (attempt-count proxy). */
export const NotionQuotaCost = attr.number({
  key: 'notion.quota.cost',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Logical quota cost charged for a Notion request (attempt-count proxy).',
  stability: 'development',
  examples: [1, 2],
})

// -- rate limit --
/** Whether the Notion response carried rate-limit headers. */
export const NotionRateLimitPresent = attr.boolean({
  key: 'notion.rate_limit.present',
  brief: 'Whether the Notion response carried rate-limit headers.',
  stability: 'development',
})

/** Remaining rate-limit budget reported by Notion. */
export const NotionRateLimitRemaining = attr.number({
  key: 'notion.rate_limit.remaining',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Remaining rate-limit budget reported by Notion.',
  stability: 'development',
  examples: [0, 90],
})

/** Milliseconds until the Notion rate-limit window resets (from the `Retry-After` reset hint). */
export const NotionRateLimitResetAfterMs = attr.number({
  key: 'notion.rate_limit.reset_after_ms',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Milliseconds until the Notion rate-limit window resets (from the reset hint).',
  stability: 'development',
  examples: [1000, 30000],
})

/** Milliseconds a logical request was blocked acquiring a Notion request-throttle token. */
export const NotionRateLimitWaitMs = attr.number({
  key: 'notion.rate_limit.wait_ms',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Milliseconds a logical request was blocked acquiring a Notion request-throttle token.',
  stability: 'development',
  examples: [0, 1000],
})

// -- identity --
/** Notion data source (database) id a query targets. */
export const NotionDataSourceId = attr.string({
  key: 'notion.data_source_id',
  cardinality: 'high',
  brief: 'Notion data source (database) id a query targets.',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

/** Notion page id a retrieve targets. */
export const NotionPageId = attr.string({
  key: 'notion.page_id',
  cardinality: 'high',
  brief: 'Notion page id a retrieve targets.',
  stability: 'development',
  examples: ['205d5c1a-0000-4000-8000-000000000000'],
})

// ---------------------------------------------------------------------------
// operations (static-name spans; label extractors read a catalog attribute)
// ---------------------------------------------------------------------------

/** `NotionDatabases.query` — a Notion data-source (database) query, labelled by data source id. */
export const NotionDatabasesQueryOperation = operation({
  id: 'span.notion.databases_query',
  name: 'NotionDatabases.query',
  brief: 'A Notion data-source (database) query.',
  stability: 'development',
  attributes: {
    dataSourceId: required(NotionDataSourceId),
  },
  label: (v: { dataSourceId: string }) => v.dataSourceId,
})

/** `NotionPages.retrieve` — a Notion page retrieve, labelled by page id. */
export const NotionPagesRetrieveOperation = operation({
  id: 'span.notion.pages_retrieve',
  name: 'NotionPages.retrieve',
  brief: 'A Notion page retrieve.',
  stability: 'development',
  attributes: {
    pageId: required(NotionPageId),
  },
  label: (v: { pageId: string }) => v.pageId,
})

// ---------------------------------------------------------------------------
// contract seam (namespace `notion`, derived).
// ---------------------------------------------------------------------------

export default defineOtelContract({
  memberPath: 'packages/@overeng/notion-effect-client',
  displayName: 'Notion Effect Client Attributes',
  signals: [NotionDatabasesQueryOperation, NotionPagesRetrieveOperation],
  // Keys reaching the catalog ONLY via the DYNAMIC-NAME `NotionHttp.<METHOD>` bridge span, the
  // annotate-only rate-limit bundles, or the raw metric labels (no static single-signal open-ref
  // carries them). Catalog completeness (SC-R13). `notion.data_source_id` / `notion.page_id` are
  // NOT here — they ride the two static operations above.
  docOnlyAttributes: [
    // NotionHttp.<METHOD> dynamic bridge span + rate-limit annotate bundle + metric labels
    NotionHttpMethod,
    NotionHttpRoute,
    NotionHttpOperation,
    // rate-limit annotate bundle (HttpRateLimitAttrs)
    NotionHttpStatusCode,
    NotionHttpRetryAttempt,
    NotionHttpRetryAttempts,
    NotionHttpRetryDelayMs,
    NotionQuotaCost,
    NotionRateLimitPresent,
    NotionRateLimitRemaining,
    NotionRateLimitResetAfterMs,
    // throttle-wait annotate bundle (HttpRateLimitWaitAttrs)
    NotionRateLimitWaitMs,
  ],
})
