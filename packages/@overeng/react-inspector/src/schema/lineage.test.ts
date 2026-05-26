import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  authority,
  cache,
  computed,
  derivedFrom,
  external,
  foreignKey,
  freshness,
  getAuthority,
  getFreshness,
  getLineage,
  getLineageDisplay,
  getReference,
  LineageAnnotationId,
  mirror,
  projection,
  sourceOfTruth,
} from './lineage.ts'

describe('Lineage annotations: round-trip', () => {
  it('sourceOfTruth', () => {
    const s = Schema.Number.pipe(sourceOfTruth({ owner: 'orders', system: 'pg' }))
    expect(getLineage(s)).toEqual({ _tag: 'SourceOfTruth', owner: 'orders', system: 'pg' })
  })

  it('derivedFrom (bare field names + default Pure)', () => {
    const s = Schema.Number.pipe(derivedFrom(['subtotal', 'tax']))
    expect(getLineage(s)).toEqual({
      _tag: 'Derived',
      from: [
        { _tag: 'Field', path: '$.subtotal' },
        { _tag: 'Field', path: '$.tax' },
      ],
      how: { _tag: 'Pure' },
    })
  })

  it('derivedFrom (explicit DerivationKind + pure flag)', () => {
    const s = Schema.Number.pipe(
      derivedFrom(
        [{ _tag: 'Field', path: '$.items' }],
        { _tag: 'Aggregation', op: 'sum' },
        { pure: true },
      ),
    )
    const got = getLineage(s)
    expect(got).toEqual({
      _tag: 'Derived',
      from: [{ _tag: 'Field', path: '$.items' }],
      how: { _tag: 'Aggregation', op: 'sum' },
      pure: true,
    })
  })

  it('projection / cache / mirror / external / computed', () => {
    expect(getLineage(Schema.Number.pipe(projection('total', { stalenessMs: 5000 })))).toEqual({
      _tag: 'Projection',
      of: { _tag: 'Field', path: '$.total' },
      stalenessMs: 5000,
    })
    expect(getLineage(Schema.Number.pipe(cache('total', { ttlMs: 1000 })))).toEqual({
      _tag: 'Cache',
      of: { _tag: 'Field', path: '$.total' },
      ttlMs: 1000,
    })
    expect(getLineage(Schema.String.pipe(mirror('id', { system: 'stripe' })))).toEqual({
      _tag: 'Mirror',
      of: { _tag: 'Field', path: '$.id' },
      system: 'stripe',
    })
    expect(getLineage(Schema.String.pipe(external('stripe', 'cus_123')))).toEqual({
      _tag: 'External',
      system: 'stripe',
      ref: 'cus_123',
    })
    expect(getLineage(Schema.Number.pipe(computed({ fn: 'now()' })))).toEqual({
      _tag: 'Computed',
      fn: 'now()',
    })
  })

  it('companion annotations: authority / freshness / foreignKey', () => {
    const a = Schema.Number.pipe(authority({ writers: ['svc-orders'], readers: ['svc-billing'] }))
    expect(getAuthority(a)).toEqual({ writers: ['svc-orders'], readers: ['svc-billing'] })

    const f = Schema.Number.pipe(freshness({ capturedAt: 'event-time', maxAgeMs: 60000 }))
    expect(getFreshness(f)).toEqual({ capturedAt: 'event-time', maxAgeMs: 60000 })

    const r = Schema.String.pipe(foreignKey('Order', 'id'))
    expect(getReference(r)).toEqual({
      _tag: 'ForeignKey',
      targetSchema: 'Order',
      targetField: 'id',
    })
  })

  it('reads annotations through Refinement wrappers', () => {
    const inner = Schema.Number.pipe(sourceOfTruth())
    /* Refinement wrapper around an inner-annotated schema. */
    const wrapped = inner.pipe(Schema.positive())
    expect(getLineage(wrapped)).toEqual({ _tag: 'SourceOfTruth' })
  })
})

describe('Lineage annotations: fail-soft', () => {
  it('returns undefined for malformed annotation payloads', () => {
    const bogus = Schema.Number.annotations({ [LineageAnnotationId]: { _tag: 'Bogus' } })
    expect(getLineage(bogus)).toBeUndefined()
  })

  it('returns undefined when annotation is absent', () => {
    expect(getLineage(Schema.Number)).toBeUndefined()
    expect(getAuthority(Schema.Number)).toBeUndefined()
    expect(getFreshness(Schema.Number)).toBeUndefined()
    expect(getReference(Schema.Number)).toBeUndefined()
  })
})

describe('getLineageDisplay', () => {
  it('produces sensible badges and summaries for each variant', () => {
    expect(getLineageDisplay({ _tag: 'SourceOfTruth' }).badge).toBe('⇆')
    expect(getLineageDisplay({ _tag: 'Computed' }).badge).toBe('⊙')

    const derived = getLineageDisplay({
      _tag: 'Derived',
      from: [
        { _tag: 'Field', path: '$.a' },
        { _tag: 'Field', path: '$.b' },
      ],
      how: { _tag: 'Pure' },
    })
    expect(derived.badge).toBe('ƒ')
    expect(derived.kindLabel).toBe('Derived')
    expect(derived.summary).toBe('pure of $.a, $.b')
    expect(derived.badgeTitle).toBe('Derived from $.a, $.b')

    const proj = getLineageDisplay({
      _tag: 'Projection',
      of: { _tag: 'Field', path: '$.total' },
      stalenessMs: 5000,
    })
    expect(proj.badge).toBe('≈')
    expect(proj.details).toEqual([{ label: 'staleness', value: '5000ms' }])

    expect(getLineageDisplay({ _tag: 'External', system: 'stripe' }).badge).toBe('↗')
    expect(getLineageDisplay({ _tag: 'Cache', of: { _tag: 'Field', path: '$.x' } }).badge).toBe(
      '☷',
    )
    expect(
      getLineageDisplay({ _tag: 'Mirror', of: { _tag: 'Field', path: '$.x' }, system: 's' }).badge,
    ).toBe('↻')
  })
})
