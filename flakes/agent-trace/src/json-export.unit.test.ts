import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { object } from './projection.ts'
import { assertJsonPatternExports, jsonSchemaOptions } from './registry.ts'
import { ModelRoute, AgentTraceV2 } from './schema.ts'

const patterns = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((entry: unknown) => patterns(entry))
  if (value === null || typeof value !== 'object') return []
  const record = object(value)
  return [
    ...(typeof record.pattern === 'string' ? [record.pattern] : []),
    ...Object.values(record).flatMap(patterns),
  ]
}

describe('native JSON Schema export completeness', () => {
  it('exports every ModelRoute check through native allOf without weakening the authority', () => {
    assertJsonPatternExports(ModelRoute)
    const document = Schema.toJsonSchemaDocument(ModelRoute, jsonSchemaOptions)
    expect(patterns(document.schema)).toEqual(
      expect.arrayContaining(['^[^\\r\\n]+$', '^[a-z0-9][a-z0-9._-]*\\/[a-z0-9][a-z0-9._+-]*$']),
    )
    expect(document.schema.maxLength).toBe(64)
  })
  it('rejects an intentionally non-Unicode pattern, including inside a struct', () => {
    const incomplete = Schema.Struct({ missing: Schema.String.check(Schema.isPattern(/a/)) })
    expect(() => assertJsonPatternExports(incomplete)).toThrow(
      'Non-exportable isPattern at missing',
    )
    assertJsonPatternExports(AgentTraceV2)
  })
  it('preserves sensitivity, row, format and title/description annotations natively', () => {
    const document = Schema.toJsonSchemaDocument(AgentTraceV2, jsonSchemaOptions)
    const metadata = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(document.schema)
    expect(metadata).toContain('"x-sensitivity":"internal"')
    expect(metadata).toContain('"x-row":true')
    expect(metadata).toContain('"x-format":"space"')
    expect(metadata).toContain('"title":"Who"')
    expect(metadata).toContain('"description":"Identities accountable')
  })
})
