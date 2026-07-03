import { deepStrictEqual } from 'node:assert'

import { Redacted, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { OtelAttr, OtelAttrs, type OtelOperationDefinition } from './mod.ts'
import demoContract, { AcmeProbeName, ProbeSpan, ProbesTotal } from './registry-demo.contract.ts'
import {
  attr,
  conditionally,
  defineOtelContract,
  fragment,
  metric,
  operation,
  optIn,
  recommended,
  required,
  span,
  toAttrDef,
  WeaverMissingAnnotationError,
  WeaverStrayNamespaceKeyError,
  WeaverUnsupportedInstrumentError,
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

  it('rejects the updowncounter instrument at author time (no OtelMetric constructor for it)', () => {
    // `updowncounter` stays valid in the Layer-1 `Instrument` type (weaver supports it) but the
    // Layer-2 builder must reject it rather than silently building a gauge (which would disagree
    // with the emitted `updowncounter` registry SignalDef).
    expect(() =>
      metric({
        id: 'metric.acme.inflight',
        name: 'acme.inflight',
        instrument: 'updowncounter',
        unit: '{probe}',
        brief: 'In-flight probes.',
        stability: 'development',
        labels: { probeName: required(AcmeProbeName) },
      }),
    ).toThrow(WeaverUnsupportedInstrumentError)
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

// ---------------------------------------------------------------------------
// The shape union (SC-R14): what the retired per-namespace equivalence bridges collectively
// covered — every `attr.*` builder, every `OtelAttr.*` encode policy, every requirement level,
// and the span / operation / metric product surfaces — proven ONCE here against an INDEPENDENT
// hand-authored baseline (raw `OtelAttr.*` + `OtelAttrs.defineSync` / `OtelOperation.define` /
// `OtelMetric.*`, never via the Layer-2 builders, so the proof is real and not vacuous).
// Plain vitest with a deterministic present/absent × enum branch matrix stands in for the
// per-package `@effect/vitest` `it.prop` witnesses (this Layer-1 package has no @effect/vitest);
// same branch coverage.
// ---------------------------------------------------------------------------

describe('Layer 2 span encoder derives the full shape union ≡ hand-authored baseline (SC-R14)', () => {
  // `attr.*` builders (weaver-annotated) + raw `OtelAttr.*` encode policies (redacted/json/drop
  // carry NO weaver metadata, so they compose in a span — `keyOf` needs only the otel key — and
  // ONLY their encoder derivation is asserted here, kept off the catalog-projection path).
  const shapeSpan = span({
    id: 'span.acme.shape',
    kind: 'internal',
    brief: 'every shape',
    stability: 'development',
    attributes: {
      // attr.string (bounded), attr.number int + double, attr.boolean:
      name: required(
        attr.string({
          key: 'acme.name',
          cardinality: 'bounded',
          brief: 'n',
          stability: 'development',
          examples: ['x'],
        }),
      ),
      count: required(
        attr.number({
          key: 'acme.count',
          weaverType: 'int',
          cardinality: 'low',
          brief: 'c',
          stability: 'development',
          examples: [1],
        }),
      ),
      ratio: required(
        attr.number({
          key: 'acme.ratio',
          weaverType: 'double',
          brief: 'r',
          stability: 'development',
        }),
      ),
      enabled: required(
        attr.boolean({ key: 'acme.enabled', brief: 'e', stability: 'development' }),
      ),
      // multi-member enum + single-member literal + template (encodes as a plain string):
      region: recommended(
        attr.enum({
          key: 'acme.region',
          values: ['us_east', 'us_west', 'eu_central'],
          briefs: { us_east: 'US East.', us_west: 'US West.', eu_central: 'EU Central.' },
          brief: 'region',
          stability: 'development',
        }),
      ),
      mode: recommended(
        attr.enum({
          key: 'acme.mode',
          values: ['solo'],
          briefs: { solo: 'Solo.' },
          brief: 'single-member',
          stability: 'development',
        }),
      ),
      header: recommended(
        attr.template({
          key: 'acme.header',
          templateType: 'string',
          cardinality: 'high',
          brief: 'h',
          stability: 'development',
        }),
      ),
      // raw encode policies: json (array), redacted (masked), drop (absent):
      payload: required(
        OtelAttr.json({ key: 'acme.payload', schema: Schema.Array(Schema.String) }),
      ),
      secret: required(OtelAttr.redacted('acme.secret')),
      source: required(OtelAttr.drop(OtelAttr.string({ key: 'acme.source' }))),
    },
  })

  // INDEPENDENT baseline: the exact field plan the Layer-2 builders compile, authored from raw
  // primitives (weaverType is design-time only; it does not affect the encoder).
  const baseline = OtelAttrs.defineSync(
    Schema.Struct({
      name: OtelAttr.string({ key: 'acme.name', metadata: { cardinality: 'bounded' } }),
      count: OtelAttr.number({ key: 'acme.count', metadata: { cardinality: 'low' } }),
      ratio: OtelAttr.number({ key: 'acme.ratio' }),
      enabled: OtelAttr.boolean({ key: 'acme.enabled' }),
      region: Schema.optional(OtelAttr.literal('acme.region', 'us_east', 'us_west', 'eu_central')),
      mode: Schema.optional(OtelAttr.literal('acme.mode', 'solo')),
      header: Schema.optional(
        OtelAttr.string({ key: 'acme.header', metadata: { cardinality: 'high' } }),
      ),
      payload: OtelAttr.json({ key: 'acme.payload', schema: Schema.Array(Schema.String) }),
      secret: OtelAttr.redacted('acme.secret'),
      source: OtelAttr.drop(OtelAttr.string({ key: 'acme.source' })),
    }),
  )

  const regions = ['us_east', 'us_west', 'eu_central'] as const
  const inputs = regions.flatMap((region) =>
    [true, false].flatMap((hasRegion) =>
      [true, false].flatMap((hasMode) =>
        [true, false].map((hasHeader) =>
          Object.assign(
            {
              name: `liveness`,
              count: 2,
              ratio: 1.5,
              enabled: true,
              payload: [`a`, `b`],
              secret: Redacted.make(`topsecret`),
              source: `ignored-source`,
            },
            hasRegion === true ? { region } : {},
            hasMode === true ? { mode: `solo` as const } : {},
            hasHeader === true ? { header: `application/json` } : {},
          ),
        ),
      ),
    ),
  )

  it.each(inputs)('derived .encoder.encodeSync ≡ hand-authored baseline — %o', (input) => {
    deepStrictEqual(
      shapeSpan.encoder.encodeSync(input as never),
      baseline.encodeSync(input as never),
    )
  })

  it('applies every encode policy (redacted mask / json string / drop / bool / double / enum)', () => {
    const enc = shapeSpan.encoder.encodeSync({
      name: 'liveness',
      count: 2,
      ratio: 1.5,
      enabled: true,
      region: 'us_east',
      mode: 'solo',
      header: 'application/json',
      payload: ['a', 'b'],
      secret: Redacted.make('topsecret'),
      source: 'ignored-source',
    } as never)
    expect(enc['acme.secret']).toBe('<redacted>') // redacted → masked, never the raw value
    expect(enc['acme.payload']).toBe(JSON.stringify(['a', 'b'])) // json → a JSON *string*
    expect('acme.source' in enc).toBe(false) // drop → absent from the map
    expect(enc['acme.enabled']).toBe(true) // boolean
    expect(enc['acme.ratio']).toBe(1.5) // double
    expect(enc['acme.region']).toBe('us_east') // enum member
    expect(enc['acme.header']).toBe('application/json') // template encodes as a string
  })

  it('derived and baseline agree on emitted attribute keys', () => {
    expect([...shapeSpan.encoder.keys].toSorted()).toStrictEqual([...baseline.keys].toSorted())
  })
})

describe('requirement_level (registry axis) maps required/recommended/opt_in/conditionally', () => {
  const a = (key: string) =>
    attr.string({ key, cardinality: 'low', brief: 'x', stability: 'development', examples: ['x'] })
  const s = span({
    id: 'span.acme.req',
    kind: 'internal',
    brief: 'requirement levels',
    stability: 'development',
    attributes: {
      a: required(a('acme.a')),
      b: recommended(a('acme.b')),
      c: optIn(a('acme.c')),
      d: conditionally({ schema: a('acme.d'), when: 'When known.' }),
    },
  })

  it('projects each requirement level onto the signal attribute ref', () => {
    const byRef = new Map(s.signal().attributes.map((r) => [r.ref, r.requirement_level]))
    expect(byRef.get('acme.a')).toBe('required')
    expect(byRef.get('acme.b')).toBe('recommended')
    expect(byRef.get('acme.c')).toBe('opt_in')
    expect(byRef.get('acme.d')).toEqual({ conditionally_required: 'When known.' })
  })

  it('maps required→non-optional and recommended/opt_in/conditionally→optional in the encoder', () => {
    // the required field is non-optional: omitting it is a decode failure.
    expect(() => s.encoder.encodeSync({} as never)).toThrow()
    // the optional fields may all be absent.
    const enc = s.encoder.encodeSync({ a: 'x' } as never)
    expect(enc['acme.a']).toBe('x')
    expect('acme.b' in enc).toBe(false)
    expect('acme.c' in enc).toBe(false)
    expect('acme.d' in enc).toBe(false)
  })
})

describe('enum projection carries per-member stability (weaver 0.24.2)', () => {
  it('toAttrDef projects each enum member with id/value/brief/stability', () => {
    const def = toAttrDef(
      attr.enum({
        key: 'acme.tier',
        values: ['low', 'high'],
        briefs: { low: 'Low tier.', high: 'High tier.' },
        brief: 'tier',
        stability: 'development',
      }),
    )
    expect(def.type).toEqual({
      members: [
        { id: 'low', value: 'low', brief: 'Low tier.', stability: 'development' },
        { id: 'high', value: 'high', brief: 'High tier.', stability: 'development' },
      ],
    })
  })
})

describe('metric derivation + label invariants (SC-R14)', () => {
  const probeName = attr.string({
    key: 'acme.probe.name',
    cardinality: 'bounded',
    brief: 'n',
    stability: 'development',
    examples: ['x'],
  })

  it('derives a GAUGE label encoder ≡ hand-authored baseline', () => {
    const g = metric({
      id: 'metric.acme.inflight',
      name: 'acme.inflight',
      instrument: 'gauge',
      unit: '{probe}',
      brief: 'In-flight probes.',
      stability: 'development',
      labels: { probeName: required(probeName) },
    })
    const baseline = OtelAttrs.defineSync(
      Schema.Struct({
        probeName: OtelAttr.string({
          key: 'acme.probe.name',
          metadata: { cardinality: 'bounded' },
        }),
      }),
    )
    const sample = { probeName: 'liveness' }
    deepStrictEqual(
      g.metric.encodeLabelsSync(sample as never),
      baseline.encodeSync(sample as never),
    )
    expect(g.metric.instrument).toBe('gauge')
    expect(g.metric.name).toBe('acme.inflight')
  })

  it('derives a HISTOGRAM with boundaries', () => {
    const h = metric({
      id: 'metric.acme.probe.duration',
      name: 'acme.probe.duration',
      instrument: 'histogram',
      unit: 's',
      brief: 'Probe duration.',
      stability: 'development',
      boundaries: [0.005, 0.05, 0.5, 5],
      labels: { probeName: required(probeName) },
    })
    expect(h.metric.instrument).toBe('histogram')
    expect(h.metric.encodeLabelsSync({ probeName: 'liveness' } as never)).toEqual({
      'acme.probe.name': 'liveness',
    })
  })

  it('rejects a HIGH-cardinality metric label at author time', () => {
    expect(() =>
      metric({
        id: 'metric.acme.bad',
        name: 'acme.bad',
        instrument: 'counter',
        unit: '{probe}',
        brief: 'bad label',
        stability: 'development',
        labels: {
          traceId: required(
            attr.string({
              key: 'acme.trace.id',
              cardinality: 'high',
              brief: 'high card',
              stability: 'development',
              examples: ['x'],
            }),
          ),
        },
      }),
    ).toThrow(/high cardinality/)
  })

  it('rejects a DROP-encoded metric label at author time', () => {
    expect(() =>
      metric({
        id: 'metric.acme.bad2',
        name: 'acme.bad2',
        instrument: 'counter',
        unit: '{probe}',
        brief: 'bad drop label',
        stability: 'development',
        labels: {
          dropped: required(
            Schema.String.pipe(OtelAttr.key({ key: 'acme.dropped', encode: 'drop' })) as never,
          ),
        },
      }),
    ).toThrow(/drop encoder/)
  })
})

describe('operation label extractor: trim + non-finite rejection (SC-R14 mechanism parity)', () => {
  const op = operation({
    id: 'span.acme.op2',
    name: 'acme.op2',
    brief: 'op',
    stability: 'development',
    attributes: {
      count: required(
        attr.number({
          key: 'acme.op.count',
          weaverType: 'int',
          cardinality: 'low',
          brief: 'c',
          stability: 'development',
          examples: [1],
        }),
      ),
    },
    // runtime-only label source (dropped), read by the extractor:
    labelFields: { label: OtelAttr.drop(Schema.NonEmptyString) },
    label: (v: { label: string }) => v.label,
  })

  it('derives a span.label from the extractor and trims it (whitespace parity)', () => {
    const enc = (op.operation as OtelOperationDefinition<never>).encodeSync({
      label: '  generate  ',
      count: 1,
    } as never)
    expect(enc['span.label']).toBe('generate')
    expect(enc['acme.op.count']).toBe(1)
    expect('label' in enc).toBe(false) // the label source is dropped
  })

  it('rejects a non-finite numeric attribute (trusted-path parity)', () => {
    expect(() =>
      (op.operation as OtelOperationDefinition<never>).encodeSync({
        label: 'gen',
        count: Number.POSITIVE_INFINITY,
      } as never),
    ).toThrow()
  })
})
