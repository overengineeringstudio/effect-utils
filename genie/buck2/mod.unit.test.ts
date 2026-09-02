import { describe, expect, it } from 'vitest'

import { buck2SemanticFingerprint, renderBuck2Visibility } from './mod.ts'

describe('buck2SemanticFingerprint', () => {
  it('canonicalizes object key order while preserving array order', () => {
    const fingerprint = (semanticData: unknown) =>
      buck2SemanticFingerprint({
        generator: 'effect-utils/genie/buck2-materialization',
        schemaVersion: 1,
        semanticData,
      })

    expect(fingerprint({ z: 1, nested: { b: 2, a: 1 } })).toBe(
      fingerprint({ nested: { a: 1, b: 2 }, z: 1 }),
    )
    expect(fingerprint({ values: ['a', 'b'] })).not.toBe(fingerprint({ values: ['b', 'a'] }))
  })

  it('commits to generator and schema identity', () => {
    const fingerprint = (generator: string, schemaVersion: number) =>
      buck2SemanticFingerprint({ generator, schemaVersion, semanticData: { value: 'same' } })

    expect(fingerprint('effect-utils/genie/buck2-materialization', 1)).not.toBe(
      fingerprint('effect-utils/genie/buck2-materialization', 2),
    )
    expect(fingerprint('effect-utils/genie/buck2-materialization', 1)).not.toBe(
      fingerprint('another-generator', 1),
    )
  })
})

describe('renderBuck2Visibility', () => {
  it('renders visibility forwarded by a generated target', () => {
    expect(renderBuck2Visibility({ visibility: ['PUBLIC'] })).toBe('    visibility = ["PUBLIC"],')
    expect(renderBuck2Visibility({ visibility: ['//packages/@overeng/tui-core:'] })).toBe(
      '    visibility = ["//packages/@overeng/tui-core:"],',
    )
  })

  it('rejects an empty visibility projection', () => {
    expect(() => renderBuck2Visibility({ visibility: [] })).toThrow(
      'Buck2 visibility must not be empty',
    )
  })
})
