/**
 * TEST FIXTURE — a synthetic `otel_scrape.*` telemetry registry standing in for the first real
 * Rust consumer of the weaver generator (decision 0007: otel-scrape produces ~25 fleet-relevant
 * semconv names — spans/metrics/attributes, profile fields, schema tags — and wants generated
 * Rust bindings).
 *
 * It is authored as PLAIN Layer-1 data using only the dep-free types from `./mod.ts` (no
 * `@overeng/otel-contract` import), because everything under `runtime/**` MUST be dependency-free
 * (loadable in arbitrary repos). The Rust renderer is Layer 1, so its fixture is Layer-1 data;
 * the Layer-2 Effect-Schema projection path is covered separately by
 * `packages/@overeng/otel-contract/src/registry-demo.contract.ts` (M1).
 *
 * `rust-constants.unit.test.ts` renders this directly via the Layer-1 `renderRustConstants`,
 * exercising the true name-projection the Rust consumer relies on. NOT part of the shipped
 * `genie/weaver-registry/` composed registry — a standalone fixture so it does not pollute the live
 * registry. Covers the type variety a real Rust consumer needs: string / int / double / boolean
 * attributes, a multi-member enum (per-member stability), a `template[...]` dynamic-key attribute,
 * plus span + metric signals.
 *
 * Name budget (~25, per decision 0007): 20 attribute keys + 2 span ids + 3 metric names.
 * Public-safe: generic `otel_scrape.*` names only.
 */
import type { AttrDef, Registry, SignalDef } from './mod.ts'

// ---- string attributes (examples kept for fidelity; not required by the Rust renderer) ----
const stringAttrs: ReadonlyArray<AttrDef> = [
  {
    id: 'otel_scrape.target.url',
    type: 'string',
    brief: 'The scrape target endpoint URL.',
    stability: 'development',
    examples: ['http://localhost:4318/v1/traces'],
    policy: { cardinality: 'high' },
  },
  {
    id: 'otel_scrape.target.name',
    type: 'string',
    brief: 'Logical name of the scrape target.',
    stability: 'development',
    examples: ['collector', 'gateway'],
    policy: { cardinality: 'bounded' },
  },
  {
    id: 'otel_scrape.endpoint',
    type: 'string',
    brief: 'The OTLP endpoint path.',
    stability: 'development',
    examples: ['/v1/traces', '/v1/metrics'],
    policy: { cardinality: 'bounded' },
  },
  {
    id: 'otel_scrape.profile.name',
    type: 'string',
    brief: 'The profiling stream name.',
    stability: 'development',
    examples: ['cpu', 'heap'],
    policy: { cardinality: 'bounded' },
  },
  {
    id: 'otel_scrape.schema.tag',
    type: 'string',
    brief: 'The semantic-convention schema tag applied to the payload.',
    stability: 'development',
    examples: ['stable', 'development'],
    policy: { cardinality: 'bounded' },
  },
  {
    id: 'otel_scrape.schema.version',
    type: 'string',
    brief: 'The pinned upstream semconv version.',
    stability: 'development',
    examples: ['1.37.0'],
    policy: { cardinality: 'bounded' },
  },
]

// ---- enum attributes (multi-member, explicit per-member stability per weaver 0.24.2) ----
const enumAttrs: ReadonlyArray<AttrDef> = [
  {
    id: 'otel_scrape.status',
    type: {
      members: [
        { id: 'success', value: 'success', brief: 'Scrape succeeded.', stability: 'development' },
        { id: 'failure', value: 'failure', brief: 'Scrape failed.', stability: 'development' },
        { id: 'timeout', value: 'timeout', brief: 'Scrape timed out.', stability: 'development' },
      ],
    },
    brief: 'The terminal status of a scrape.',
    stability: 'development',
  },
  {
    id: 'otel_scrape.protocol',
    type: {
      members: [
        { id: 'http', value: 'http', brief: 'OTLP/HTTP.', stability: 'development' },
        { id: 'grpc', value: 'grpc', brief: 'OTLP/gRPC.', stability: 'development' },
      ],
    },
    brief: 'The OTLP transport protocol.',
    stability: 'development',
  },
  {
    id: 'otel_scrape.error.type',
    type: {
      members: [
        {
          id: 'connection',
          value: 'connection',
          brief: 'Transport/connection error.',
          stability: 'development',
        },
        { id: 'decode', value: 'decode', brief: 'Payload decode error.', stability: 'development' },
        {
          id: 'policy',
          value: 'policy',
          brief: 'Registry policy violation.',
          stability: 'development',
        },
      ],
    },
    brief: 'The class of scrape error.',
    stability: 'development',
  },
]

// ---- int attributes ----
const intAttrs: ReadonlyArray<AttrDef> = [
  {
    id: 'otel_scrape.payload.size_bytes',
    type: 'int',
    brief: 'Size of the received payload in bytes.',
    stability: 'development',
    examples: [1024],
    policy: { cardinality: 'high' },
  },
  {
    id: 'otel_scrape.retry.count',
    type: 'int',
    brief: 'Number of retries before the scrape terminated.',
    stability: 'development',
    examples: [0, 1],
    policy: { cardinality: 'low' },
  },
  {
    id: 'otel_scrape.profile.cpu_samples',
    type: 'int',
    brief: 'Number of CPU profile samples captured.',
    stability: 'development',
    examples: [128],
    policy: { cardinality: 'high' },
  },
  {
    id: 'otel_scrape.profile.heap_bytes',
    type: 'int',
    brief: 'Heap bytes captured in the heap profile.',
    stability: 'development',
    examples: [1048576],
    policy: { cardinality: 'high' },
  },
  {
    id: 'otel_scrape.batch.size',
    type: 'int',
    brief: 'Number of items in the scrape batch.',
    stability: 'development',
    examples: [50],
    policy: { cardinality: 'bounded' },
  },
  {
    id: 'otel_scrape.target.port',
    type: 'int',
    brief: 'The scrape target port.',
    stability: 'development',
    examples: [4318],
    policy: { cardinality: 'bounded' },
  },
]

// ---- double attribute ----
const doubleAttrs: ReadonlyArray<AttrDef> = [
  {
    id: 'otel_scrape.duration_ms',
    type: 'double',
    brief: 'Wall-clock scrape duration in milliseconds.',
    stability: 'development',
    examples: [12.5],
    policy: { cardinality: 'high' },
  },
]

// ---- boolean attributes ----
const booleanAttrs: ReadonlyArray<AttrDef> = [
  {
    id: 'otel_scrape.compressed',
    type: 'boolean',
    brief: 'Whether the payload was compressed.',
    stability: 'development',
  },
  {
    id: 'otel_scrape.tls.enabled',
    type: 'boolean',
    brief: 'Whether the transport used TLS.',
    stability: 'development',
  },
  {
    id: 'otel_scrape.result.cached',
    type: 'boolean',
    brief: 'Whether the scrape result was served from cache.',
    stability: 'development',
  },
]

// ---- template attribute (dynamic per-header keys) ----
const templateAttrs: ReadonlyArray<AttrDef> = [
  {
    id: 'otel_scrape.request.header',
    type: 'template[string]',
    brief: 'Dynamic request header values, keyed by header name.',
    stability: 'development',
    examples: ['application/json'],
    policy: { cardinality: 'high' },
  },
]

const attributes: ReadonlyArray<AttrDef> = [
  ...stringAttrs,
  ...enumAttrs,
  ...intAttrs,
  ...doubleAttrs,
  ...booleanAttrs,
  ...templateAttrs,
]

// ---- signals (spans + metrics REF the catalog by attribute id) ----
const signals: ReadonlyArray<SignalDef> = [
  {
    kind: 'span',
    id: 'span.otel_scrape.request',
    // Operation-projected span: the Rust const must emit this runtime name, NOT the group id.
    span_name: 'otel_scrape/request',
    span_kind: 'client',
    brief: 'A single scrape request against a target.',
    stability: 'development',
    attributes: [
      { ref: 'otel_scrape.target.url', requirement_level: 'required' },
      { ref: 'otel_scrape.protocol', requirement_level: 'recommended' },
      {
        ref: 'otel_scrape.status',
        requirement_level: { conditionally_required: 'If the scrape terminated.' },
      },
      { ref: 'otel_scrape.compressed', requirement_level: 'recommended' },
    ],
  },
  {
    kind: 'span',
    id: 'span.otel_scrape.batch',
    span_kind: 'internal',
    brief: 'A batch of buffered scrape items being flushed.',
    stability: 'development',
    attributes: [
      { ref: 'otel_scrape.batch.size', requirement_level: 'required' },
      { ref: 'otel_scrape.retry.count', requirement_level: 'recommended' },
    ],
  },
  {
    kind: 'metric',
    id: 'metric.otel_scrape.scrapes',
    metric_name: 'otel_scrape.scrapes',
    instrument: 'counter',
    unit: '{scrape}',
    brief: 'Scrapes by status and protocol.',
    stability: 'development',
    attributes: [
      { ref: 'otel_scrape.status', requirement_level: 'required' },
      { ref: 'otel_scrape.protocol', requirement_level: 'recommended' },
    ],
  },
  {
    kind: 'metric',
    id: 'metric.otel_scrape.scrape.duration',
    metric_name: 'otel_scrape.scrape.duration',
    instrument: 'histogram',
    unit: 's',
    brief: 'Scrape wall-clock duration.',
    stability: 'development',
    attributes: [{ ref: 'otel_scrape.target.name', requirement_level: 'required' }],
  },
  {
    kind: 'metric',
    id: 'metric.otel_scrape.payload.bytes',
    metric_name: 'otel_scrape.payload.bytes',
    instrument: 'counter',
    unit: 'By',
    brief: 'Total received payload bytes by protocol.',
    stability: 'development',
    attributes: [{ ref: 'otel_scrape.protocol', requirement_level: 'recommended' }],
  },
]

/** The synthetic otel-scrape Layer-1 registry — a Rust-target fixture (20 attrs + 2 spans + 3 metrics). */
export const otelScrapeFixtureRegistry: Registry = {
  name: 'otel-scrape-fixture',
  description: 'Synthetic otel-scrape registry (Rust-target fixture).',
  schemaUrl: 'https://example.invalid/schemas/otel-scrape/0.0.0',
  dependencies: [],
  groups: [
    {
      namespace: 'otel_scrape',
      displayName: 'OTel Scrape (fixture)',
      attributes,
    },
  ],
  signals,
}
