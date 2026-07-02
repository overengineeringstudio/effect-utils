import { deepStrictEqual } from 'node:assert'

import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { OtelAttr, OtelAttrs } from './mod.ts'
import demoContract, { ProbeSpan, ProbesTotal } from './registry-demo.contract.ts'
import {
  attr,
  defineOtelContract,
  fragment,
  required,
  span,
  WeaverMissingAnnotationError,
  WeaverStrayNamespaceKeyError,
} from './registry.ts'

describe('Layer 2 → runtime encoder derivation (SC-R13/R14)', () => {
  it('derived SPAN encoder output is deepStrictEqual to a hand-written OtelAttrs.defineSync', () => {
    // Independent hand-authored baseline: inline OtelAttr.* + OtelAttrs.defineSync, NOT via Layer 2.
    const handSpan = OtelAttrs.defineSync(
      Schema.Struct({
        probeName: OtelAttr.string({
          key: 'acme.probe.name',
          metadata: { cardinality: 'bounded' },
        }),
        region: Schema.optional(
          OtelAttr.literal('acme.region', 'us_east', 'us_west', 'eu_central'),
        ),
        attempt: Schema.optional(
          OtelAttr.number({ key: 'acme.attempt', metadata: { cardinality: 'low' } }),
        ),
        httpMethod: Schema.optional(
          OtelAttr.string({ key: 'http.request.method', metadata: { cardinality: 'low' } }),
        ),
      }),
    )
    const sample = {
      probeName: 'liveness',
      region: 'us_east' as const,
      attempt: 2,
      httpMethod: 'GET',
    }
    const derived = ProbeSpan.encoder.encodeSync(sample)
    const hand = handSpan.encodeSync(sample)
    deepStrictEqual(derived, hand)
  })

  it('derived METRIC label encoder output is deepStrictEqual to a hand-written baseline', () => {
    const handLabels = OtelAttrs.defineSync(
      Schema.Struct({
        probeName: OtelAttr.string({
          key: 'acme.probe.name',
          metadata: { cardinality: 'bounded' },
        }),
        region: Schema.optional(
          OtelAttr.literal('acme.region', 'us_east', 'us_west', 'eu_central'),
        ),
      }),
    )
    const sample = { probeName: 'readiness', region: 'eu_central' as const }
    const derived = ProbesTotal.metric.encodeLabelsSync(sample)
    const hand = handLabels.encodeSync(sample)
    deepStrictEqual(derived, hand)
    expect(ProbesTotal.metric.instrument).toBe('counter')
    expect(ProbesTotal.metric.name).toBe('acme.probes')
  })

  it('preserves Effect decode-at-edge validation (bad enum rejected)', () => {
    expect(() =>
      ProbeSpan.encoder.encodeSync({ probeName: 'x', region: 'bogus' as never }),
    ).toThrow()
  })
})

describe('derived namespace + catalog (decision 0006)', () => {
  it('derives the namespace from own keys and the catalog from refs ∪ doc-only', () => {
    expect(demoContract.namespace).toBe('acme')
    const frag = fragment(demoContract)
    const ids = frag.attributes.map((a) => a.id)
    // referenced own attrs:
    expect(ids).toContain('acme.probe.name')
    expect(ids).toContain('acme.region')
    // doc-only attrs (not referenced by any signal):
    expect(ids).toContain('acme.request.header')
    expect(ids).toContain('acme.probe.label')
    // upstream ref is foreign, NOT redefined in the own catalog:
    expect(ids).not.toContain('http.request.method')
    expect(frag.foreignRefs).toContain('http.request.method')
    // runtime-only span.label never enters the registry:
    expect(ids).not.toContain('span.label')
  })

  it('raises WeaverStrayNamespaceKeyError on an unmarked own key with a foreign prefix (typo)', () => {
    expect(() =>
      defineOtelContract({
        memberPath: 'x',
        displayName: 'x',
        signals: [
          span({
            id: 'span.typo',
            kind: 'internal',
            brief: 'stray key',
            stability: 'development',
            attributes: {
              probe: required(
                attr.string({
                  key: 'acme.probe.name',
                  cardinality: 'low',
                  brief: 'ok',
                  stability: 'development',
                  examples: ['x'],
                }),
              ),
              // unmarked ref whose prefix diverges → must be a hard error, not a foreign ref.
              oops: required(
                attr.string({
                  key: 'acmee.typo',
                  cardinality: 'low',
                  brief: 'typo',
                  stability: 'development',
                  examples: ['x'],
                }),
              ),
            },
          }),
        ],
      }),
    ).toThrow(WeaverStrayNamespaceKeyError)
  })

  it('raises WeaverMissingAnnotationError projecting a schema without the otel key annotation', () => {
    expect(() =>
      fragment(defineOtelContract({ memberPath: 'x', displayName: 'x', signals: [] })),
    ).toThrow()
    // a plain schema (no annotations) has no key:
    expect(() =>
      defineOtelContract({
        memberPath: 'x',
        displayName: 'x',
        signals: [
          span({
            id: 'span.bare',
            kind: 'internal',
            brief: 'bare',
            stability: 'development',
            attributes: { bare: required(Schema.String as never) },
          }),
        ],
      }),
    ).toThrow(WeaverMissingAnnotationError)
  })
})
