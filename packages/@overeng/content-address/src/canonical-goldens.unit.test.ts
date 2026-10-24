import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { canonicalJsonBytes, canonicalJsonString, hashCanonicalJson } from './bytes.ts'
import golden from './fixtures/canonical-goldens.json' with { type: 'json' }

// Genie projects the SwiftPM contract authority verbatim into this package.
// Neither implementation computes expected bytes or digests during the test.
describe('portable canonical-json contract', () => {
  it.each(golden.cases)('$name', (fixture) => {
    const value: unknown = JSON.parse(fixture.inputJSON)
    const input = { schema: Schema.Unknown, value }
    expect(canonicalJsonString(input)).toBe(fixture.canonicalJSON)
    expect(canonicalJsonBytes(input)).toEqual(new TextEncoder().encode(fixture.canonicalJSON))
    expect(hashCanonicalJson(input)).toBe(fixture.sha256)
  })
})
