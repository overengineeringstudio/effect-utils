import { createHash } from 'node:crypto'

import type { GenieContext, GenieOutput } from '../packages/@overeng/genie/src/runtime/mod.ts'
import { defineRepoContext } from '../packages/@overeng/genie/src/runtime/repo-context/mod.ts'

type RegistryItem = {
  readonly id: string
  readonly description?: string
}

type NamedRegistryItem = RegistryItem & {
  readonly name: string
}

/**
 * A span is named by the operation it represents (decision 0014), never by a
 * fixed instrumentation constant. The registry owns the naming *scheme* per
 * span id, not a fixed span-name string.
 */
type SpanRegistryItem = RegistryItem & {
  readonly naming: 'program-basename' | 'descendant-basename' | 'adapter-phase'
}

/**
 * A single example value. For a `string[]`-typed attribute an example is itself
 * a list, so arrays of scalars are permitted alongside scalar examples.
 */
type AttrExample = string | number | boolean | readonly (string | number | boolean)[]

/**
 * Field shape pre-aligned with PR #881's Weaver semconv AttrDef (decision 0016):
 * `stability`, `examples`, `note`, and a structured `deprecated` trail carried on
 * the old entry across a rename. `cardinality`/`encode` stay first-class JSON
 * policy fields (not pre-emitted as Weaver `annotations.<policy>` blocks).
 */
type AttributeRegistryItem = RegistryItem & {
  readonly key: string
  readonly valueType: 'string' | 'string[]' | 'int' | 'double' | 'boolean'
  readonly cardinality: 'low' | 'bounded' | 'high'
  readonly stability: 'stable' | 'development'
  readonly examples?: readonly AttrExample[]
  readonly note?: string
  readonly encode?: 'drop'
  readonly deprecated?: {
    readonly reason: string
    readonly renamed_to?: string
  }
}

type ProfileFieldRegistryItem = RegistryItem & {
  readonly field: string
}

type SchemaRegistryItem = RegistryItem & {
  readonly value: string
}

type OtelScrapeTelemetryRegistry = {
  readonly schemaVersion: 1
  readonly namespace: 'otel_scrape'
  readonly spans: readonly SpanRegistryItem[]
  readonly metrics: readonly NamedRegistryItem[]
  readonly attributes: readonly AttributeRegistryItem[]
  readonly profileFields: readonly ProfileFieldRegistryItem[]
  readonly schemas: readonly SchemaRegistryItem[]
}

const sourcePath = 'context/otel-scrape/telemetry-registry.json'
const repo = defineRepoContext({ name: 'effect-utils', importMetaUrl: import.meta.url })

const registry = (): {
  readonly data: OtelScrapeTelemetryRegistry
  readonly fingerprint: string
} => {
  const source = repo.readText(sourcePath)
  const data = JSON.parse(source) as OtelScrapeTelemetryRegistry
  validateRegistry(data)

  return {
    data,
    fingerprint: `sha256:${createHash('sha256').update(source).digest('hex')}`,
  }
}

/** Generates the TypeScript projection for otel-scrape telemetry constants. */
export const otelScrapeRegistryTs = (): GenieOutput<OtelScrapeTelemetryRegistry> => ({
  data: registry().data,
  stringify: (ctx) => renderTs({ ...registry(), ctx }),
})

/** Generates the Rust projection for otel-scrape telemetry constants. */
export const otelScrapeRegistryRust = (): GenieOutput<OtelScrapeTelemetryRegistry> => ({
  data: registry().data,
  stringify: (ctx) => renderRust({ ...registry(), ctx }),
})

const renderTs = ({
  data,
  fingerprint,
}: {
  readonly data: OtelScrapeTelemetryRegistry
  readonly fingerprint: string
  readonly ctx: GenieContext
}) => `// Registry source: ${sourcePath}
// Input fingerprint: ${fingerprint}

export const otelScrapeTelemetryRegistry = ${JSON.stringify(data, null, 2)} as const

// Spans are named by the operation they represent (decision 0014), not by a
// fixed instrumentation constant. The registry owns the naming *scheme* per
// span id; the emitted name is the program / descendant / adapter-phase
// basename resolved at runtime.
export const otelScrapeSpanNaming = ${mapObject(data.spans, 'naming')} as const

export const otelScrapeMetricNames = ${mapObject(data.metrics, 'name')} as const

export const otelScrapeAttributeKeys = ${mapObject(data.attributes, 'key')} as const

export const otelScrapeProfileFields = ${mapObject(data.profileFields, 'field')} as const

export const otelScrapeSchemas = ${mapObject(data.schemas, 'value')} as const

export type OtelScrapeSpanNaming =
  (typeof otelScrapeSpanNaming)[keyof typeof otelScrapeSpanNaming]

export type OtelScrapeMetricName =
  (typeof otelScrapeMetricNames)[keyof typeof otelScrapeMetricNames]

export type OtelScrapeAttributeKey =
  (typeof otelScrapeAttributeKeys)[keyof typeof otelScrapeAttributeKeys]
`

const renderRust = ({
  data,
  fingerprint,
}: {
  readonly data: OtelScrapeTelemetryRegistry
  readonly fingerprint: string
  readonly ctx: GenieContext
}) => `// Registry source: ${sourcePath}
// Input fingerprint: ${fingerprint}

pub const REGISTRY_SCHEMA_VERSION: u8 = ${data.schemaVersion};
pub const REGISTRY_NAMESPACE: &str = ${rustString(data.namespace)};
pub const REGISTRY_INPUT_FINGERPRINT: &str =
    ${rustString(fingerprint)};

${rustModule({ name: 'span_naming', items: data.spans, field: 'naming' })}

${rustModule({ name: 'metrics', items: data.metrics, field: 'name' })}

${rustModule({ name: 'attributes', items: data.attributes, field: 'key' })}

${rustModule({ name: 'profile_fields', items: data.profileFields, field: 'field' })}

${rustModule({ name: 'schemas', items: data.schemas, field: 'value' })}
`

const mapObject = <T extends RegistryItem, K extends keyof T>(
  items: readonly T[],
  field: K,
): string =>
  JSON.stringify(
    Object.fromEntries(items.map((item) => [camelCase(item.id), item[field]])),
    null,
    2,
  )

const rustConst = <T extends RegistryItem, K extends keyof T>({
  item,
  field,
}: {
  readonly item: T
  readonly field: K
}): string =>
  `    pub const ${screamingSnakeCase(item.id)}: &str = ${rustString(String(item[field]))};`

const rustModule = <T extends RegistryItem, K extends keyof T>({
  name,
  items,
  field,
}: {
  readonly name: string
  readonly items: readonly T[]
  readonly field: K
}): string => {
  if (items.length === 0) return `pub mod ${name} {}`

  return `pub mod ${name} {
${items.map((item) => rustConst({ item, field })).join('\n')}
}`
}

const rustString = (value: string): string => JSON.stringify(value)

const camelCase = (value: string): string =>
  value.replaceAll(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase())

const screamingSnakeCase = (value: string): string => value.toUpperCase()

const validateRegistry = (data: OtelScrapeTelemetryRegistry): void => {
  if (data.schemaVersion !== 1) throw new Error('otel-scrape registry schemaVersion must be 1')
  if (data.namespace !== 'otel_scrape') throw new Error('otel-scrape registry namespace mismatch')

  assertUnique(
    'span ids',
    data.spans.map((item) => item.id),
  )
  assertUnique(
    'metric ids',
    data.metrics.map((item) => item.id),
  )
  assertUnique(
    'metric names',
    data.metrics.map((item) => item.name),
  )
  assertUnique(
    'attribute ids',
    data.attributes.map((item) => item.id),
  )
  assertUnique(
    'attribute keys',
    data.attributes.map((item) => item.key),
  )
  assertUnique(
    'profile field ids',
    data.profileFields.map((item) => item.id),
  )
  assertUnique(
    'profile fields',
    data.profileFields.map((item) => item.field),
  )
  assertUnique(
    'schema ids',
    data.schemas.map((item) => item.id),
  )

  for (const span of data.spans) assertId(span.id)
  for (const metric of data.metrics) assertId(metric.id)
  for (const attribute of data.attributes) assertId(attribute.id)
  for (const field of data.profileFields) assertId(field.id)
  for (const schema of data.schemas) assertId(schema.id)
}

const assertUnique = (label: string, values: readonly string[]): void => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value) === true) throw new Error(`Duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

const assertId = (value: string): void => {
  if (/^[a-z][a-z0-9_]*$/.test(value) === false) {
    throw new Error(`Registry id must be lower snake case: ${value}`)
  }
}
