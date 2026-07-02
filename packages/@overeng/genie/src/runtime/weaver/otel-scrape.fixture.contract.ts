/**
 * TEST FIXTURE — a synthetic `otel_scrape.*` telemetry contract standing in for the first real
 * Rust consumer of the weaver generator (decision 0007: otel-scrape produces ~25 fleet-relevant
 * semconv names — spans/metrics/attributes, profile fields, schema tags — and wants generated
 * Rust bindings). It is authored via the REAL Layer 2 `@overeng/otel-contract` `./registry` seam
 * so `rust-constants.unit.test.ts` exercises the true projection path (Schema annotations →
 * `fragment()` → `registryFromMembers` → Layer-1 `renderRustConstants`) WITHOUT depending on
 * otel-scrape (#867) landing.
 *
 * NOT part of the shipped `weaver-registry/` composed registry — a standalone fixture so it does
 * not pollute the live registry. Covers the type variety a real Rust consumer needs: string /
 * int / double / boolean attributes, multi-member enums (per-member stability), a `template[...]`
 * dynamic-key attribute, plus span + metric signals.
 *
 * Name budget (~25, per decision 0007): 20 attribute keys + 2 span ids + 3 metric names.
 */
import {
  attr,
  conditionally,
  defineOtelContract,
  metric,
  recommended,
  required,
  span,
} from '@overeng/otel-contract/registry'

// ---- string attributes (examples required under weaver --future) ----
const TargetUrl = attr.string({
  key: 'otel_scrape.target.url',
  cardinality: 'high',
  brief: 'The scrape target endpoint URL.',
  stability: 'development',
  examples: ['http://localhost:4318/v1/traces'],
})
const TargetName = attr.string({
  key: 'otel_scrape.target.name',
  cardinality: 'bounded',
  brief: 'Logical name of the scrape target.',
  stability: 'development',
  examples: ['collector', 'gateway'],
})
const Endpoint = attr.string({
  key: 'otel_scrape.endpoint',
  cardinality: 'bounded',
  brief: 'The OTLP endpoint path.',
  stability: 'development',
  examples: ['/v1/traces', '/v1/metrics'],
})
const ProfileName = attr.string({
  key: 'otel_scrape.profile.name',
  cardinality: 'bounded',
  brief: 'The profiling stream name.',
  stability: 'development',
  examples: ['cpu', 'heap'],
})
const SchemaTag = attr.string({
  key: 'otel_scrape.schema.tag',
  cardinality: 'bounded',
  brief: 'The semantic-convention schema tag applied to the payload.',
  stability: 'development',
  examples: ['stable', 'development'],
})
const SchemaVersion = attr.string({
  key: 'otel_scrape.schema.version',
  cardinality: 'bounded',
  brief: 'The pinned upstream semconv version.',
  stability: 'development',
  examples: ['1.37.0'],
})

// ---- enum attributes (multi-member, per-member stability required by weaver 0.24.2) ----
const Status = attr.enum({
  key: 'otel_scrape.status',
  values: ['success', 'failure', 'timeout'],
  briefs: { success: 'Scrape succeeded.', failure: 'Scrape failed.', timeout: 'Scrape timed out.' },
  brief: 'The terminal status of a scrape.',
  stability: 'development',
})
const Protocol = attr.enum({
  key: 'otel_scrape.protocol',
  values: ['http', 'grpc'],
  briefs: { http: 'OTLP/HTTP.', grpc: 'OTLP/gRPC.' },
  brief: 'The OTLP transport protocol.',
  stability: 'development',
})
const ErrorType = attr.enum({
  key: 'otel_scrape.error.type',
  values: ['connection', 'decode', 'policy'],
  briefs: {
    connection: 'Transport/connection error.',
    decode: 'Payload decode error.',
    policy: 'Registry policy violation.',
  },
  brief: 'The class of scrape error.',
  stability: 'development',
})

// ---- int attributes ----
const PayloadSizeBytes = attr.number({
  key: 'otel_scrape.payload.size_bytes',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Size of the received payload in bytes.',
  stability: 'development',
  examples: [1024],
})
const RetryCount = attr.number({
  key: 'otel_scrape.retry.count',
  weaverType: 'int',
  cardinality: 'low',
  brief: 'Number of retries before the scrape terminated.',
  stability: 'development',
  examples: [0, 1],
})
const ProfileCpuSamples = attr.number({
  key: 'otel_scrape.profile.cpu_samples',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Number of CPU profile samples captured.',
  stability: 'development',
  examples: [128],
})
const ProfileHeapBytes = attr.number({
  key: 'otel_scrape.profile.heap_bytes',
  weaverType: 'int',
  cardinality: 'high',
  brief: 'Heap bytes captured in the heap profile.',
  stability: 'development',
  examples: [1048576],
})
const BatchSize = attr.number({
  key: 'otel_scrape.batch.size',
  weaverType: 'int',
  cardinality: 'bounded',
  brief: 'Number of items in the scrape batch.',
  stability: 'development',
  examples: [50],
})
const TargetPort = attr.number({
  key: 'otel_scrape.target.port',
  weaverType: 'int',
  cardinality: 'bounded',
  brief: 'The scrape target port.',
  stability: 'development',
  examples: [4318],
})

// ---- double attribute ----
const DurationMs = attr.number({
  key: 'otel_scrape.duration_ms',
  weaverType: 'double',
  cardinality: 'high',
  brief: 'Wall-clock scrape duration in milliseconds.',
  stability: 'development',
  examples: [12.5],
})

// ---- boolean attributes ----
const Compressed = attr.boolean({
  key: 'otel_scrape.compressed',
  brief: 'Whether the payload was compressed.',
  stability: 'development',
})
const TlsEnabled = attr.boolean({
  key: 'otel_scrape.tls.enabled',
  brief: 'Whether the transport used TLS.',
  stability: 'development',
})
const ResultCached = attr.boolean({
  key: 'otel_scrape.result.cached',
  brief: 'Whether the scrape result was served from cache.',
  stability: 'development',
})

// ---- template attribute (dynamic per-header keys) ----
const RequestHeader = attr.template({
  key: 'otel_scrape.request.header',
  templateType: 'string',
  cardinality: 'high',
  brief: 'Dynamic request header values, keyed by header name.',
  stability: 'development',
  examples: ['application/json'],
})

// ---- signals (spans + metrics reference the catalog) ----
const RequestSpan = span({
  id: 'span.otel_scrape.request',
  kind: 'client',
  brief: 'A single scrape request against a target.',
  stability: 'development',
  attributes: {
    targetUrl: required(TargetUrl),
    protocol: recommended(Protocol),
    status: conditionally({ schema: Status, when: 'If the scrape terminated.' }),
    compressed: recommended(Compressed),
  },
})

const BatchSpan = span({
  id: 'span.otel_scrape.batch',
  kind: 'internal',
  brief: 'A batch of buffered scrape items being flushed.',
  stability: 'development',
  attributes: {
    batchSize: required(BatchSize),
    retryCount: recommended(RetryCount),
  },
})

const ScrapesTotal = metric({
  id: 'metric.otel_scrape.scrapes',
  name: 'otel_scrape.scrapes',
  instrument: 'counter',
  unit: '{scrape}',
  brief: 'Scrapes by status and protocol.',
  stability: 'development',
  labels: {
    status: required(Status),
    protocol: recommended(Protocol),
  },
})

const ScrapeDuration = metric({
  id: 'metric.otel_scrape.scrape.duration',
  name: 'otel_scrape.scrape.duration',
  instrument: 'histogram',
  unit: 's',
  brief: 'Scrape wall-clock duration.',
  stability: 'development',
  boundaries: [0.01, 0.1, 1, 10],
  labels: {
    targetName: required(TargetName),
  },
})

const PayloadBytes = metric({
  id: 'metric.otel_scrape.payload.bytes',
  name: 'otel_scrape.payload.bytes',
  instrument: 'counter',
  unit: 'By',
  brief: 'Total received payload bytes by protocol.',
  stability: 'development',
  labels: {
    protocol: recommended(Protocol),
  },
})

export default defineOtelContract({
  memberPath: 'packages/@overeng/genie/src/runtime/weaver/otel-scrape.fixture.contract.ts',
  displayName: 'OTel Scrape (fixture)',
  signals: [RequestSpan, BatchSpan, ScrapesTotal, ScrapeDuration, PayloadBytes],
  // Attributes not referenced by any signal — profile fields, schema tags, the template, etc.
  docOnlyAttributes: [
    Endpoint,
    ProfileName,
    SchemaTag,
    SchemaVersion,
    ErrorType,
    PayloadSizeBytes,
    ProfileCpuSamples,
    ProfileHeapBytes,
    TargetPort,
    DurationMs,
    TlsEnabled,
    ResultCached,
    RequestHeader,
  ],
})
