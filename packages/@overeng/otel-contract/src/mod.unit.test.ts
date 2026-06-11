import { DateTime, Duration, Effect, Option, Redacted, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { expectTrace } from '@overeng/utils-dev/otelite'

import {
  OtelAttr,
  OtelAttrEncodeError,
  OtelAttrPlanError,
  OtelAttrs,
  OtelMetric,
  OtelOperation,
  OtelSpan,
} from './mod.ts'

describe('OtelAttrs', () => {
  it('derives primitive, literal, uuid, option, date, duration, and explicit array attributes', async () => {
    const Attrs = Schema.Struct({
      label: Schema.NonEmptyTrimmedString.pipe(OtelAttr.spanLabel()),
      requestId: Schema.UUID.pipe(OtelAttr.key({ key: 'request.id' })),
      outcome: Schema.Literal('approved', 'denied', 'timeout').pipe(
        OtelAttr.key({ key: 'op.outcome' }),
      ),
      count: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'op.count' })),
      cacheHit: Schema.Boolean.pipe(OtelAttr.key({ key: 'op.cache_hit' })),
      maybeShard: Schema.OptionFromNullOr(Schema.String).pipe(OtelAttr.key({ key: 'op.shard' })),
      at: Schema.DateTimeUtc.pipe(OtelAttr.key({ key: 'op.at' })),
      latency: Schema.DurationFromMillis.pipe(OtelAttr.key({ key: 'op.latency_ms' })),
      tags: Schema.Array(Schema.String).pipe(OtelAttr.key({ key: 'op.tags', encode: 'json' })),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))
    const at = DateTime.unsafeMake('2026-06-11T10:00:00.000Z')

    await expect(
      Effect.runPromise(
        attrs.encode({
          label: 'submit',
          requestId: '123e4567-e89b-12d3-a456-426614174000',
          outcome: 'approved',
          count: 2,
          cacheHit: false,
          maybeShard: Option.some('dev3'),
          at,
          latency: Duration.millis(42),
          tags: ['safe', 'bounded'],
        }),
      ),
    ).resolves.toEqual({
      'span.label': 'submit',
      'request.id': '123e4567-e89b-12d3-a456-426614174000',
      'op.outcome': 'approved',
      'op.count': 2,
      'op.cache_hit': false,
      'op.shard': 'dev3',
      'op.at': '2026-06-11T10:00:00.000Z',
      'op.latency_ms': 42,
      'op.tags': '["safe","bounded"]',
    })

    await expect(
      Effect.runPromise(
        attrs.encode({
          label: 'submit',
          requestId: '123e4567-e89b-12d3-a456-426614174000',
          outcome: 'approved',
          count: 2,
          cacheHit: false,
          maybeShard: Option.none(),
          at,
          latency: Duration.millis(42),
          tags: [],
        }),
      ),
    ).resolves.not.toHaveProperty('op.shard')
  })

  it('rejects unsafe schemas unless policy is explicit', async () => {
    await expect(
      Effect.runPromise(
        Effect.either(
          OtelAttrs.define(
            Schema.Struct({
              nested: Schema.Struct({ id: Schema.String }).pipe(OtelAttr.key({ key: 'nested' })),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Left',
      left: expect.any(OtelAttrPlanError),
    })

    await expect(
      Effect.runPromise(
        Effect.either(
          OtelAttrs.define(
            Schema.Struct({
              secret: Schema.Redacted(Schema.String).pipe(OtelAttr.key({ key: 'secret' })),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Left',
      left: expect.any(OtelAttrPlanError),
    })

    await expect(
      Effect.runPromise(
        Effect.either(
          OtelAttrs.define(
            Schema.Struct({
              tags: Schema.Array(Schema.String).pipe(OtelAttr.key({ key: 'tags' })),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Left',
      left: expect.any(OtelAttrPlanError),
    })
  })

  it('allows explicit redacted and json policies', async () => {
    const Attrs = Schema.Struct({
      secret: Schema.Redacted(Schema.String).pipe(
        OtelAttr.key({ key: 'secret', encode: 'redacted' }),
      ),
      nested: Schema.Struct({ id: Schema.String }).pipe(
        OtelAttr.key({ key: 'nested', encode: 'json' }),
      ),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))

    await expect(
      Effect.runPromise(
        attrs.encode({
          secret: Redacted.make('do-not-leak'),
          nested: { id: 'n1' },
        }),
      ),
    ).resolves.toEqual({
      secret: '<redacted>',
      nested: '{"id":"n1"}',
    })
  })

  it('only allows redacted-safe policies for redacted values', async () => {
    await expect(
      Effect.runPromise(
        Effect.either(
          OtelAttrs.define(
            Schema.Struct({
              secret: Schema.Redacted(Schema.String).pipe(
                OtelAttr.key({ key: 'secret', encode: 'json' }),
              ),
            }),
          ),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Left',
      left: expect.any(OtelAttrPlanError),
    })

    const attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          secret: Schema.Redacted(Schema.String).pipe(
            OtelAttr.key({ key: 'secret', encode: 'drop' }),
          ),
        }),
      ),
    )

    await expect(
      Effect.runPromise(attrs.encode({ secret: Redacted.make('do-not-leak') })),
    ).resolves.toEqual({})
  })

  it('surfaces encoding errors on the error channel', async () => {
    const Attrs = Schema.Struct({
      count: Schema.Number.pipe(OtelAttr.key({ key: 'count' })),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))

    await expect(
      Effect.runPromise(Effect.either(attrs.encode({ count: Number.NaN }))),
    ).resolves.toMatchObject({
      _tag: 'Left',
      left: expect.any(OtelAttrEncodeError),
    })
  })

  it('preserves typed contract errors in sync APIs', async () => {
    expect(() =>
      OtelAttrs.defineSync(
        Schema.Struct({
          nested: Schema.Struct({ id: Schema.String }).pipe(OtelAttr.key({ key: 'nested' })),
        }),
      ),
    ).toThrow(OtelAttrPlanError)

    const attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          count: Schema.Number.pipe(OtelAttr.key({ key: 'count' })),
        }),
      ),
    )

    expect(() => attrs.encodeSync({ count: Number.NaN })).toThrow(OtelAttrEncodeError)
    expect(() => attrs.unsafeEncode({ count: Number.NaN })).toThrow(OtelAttrEncodeError)
  })

  it('validates explicit policy inputs before encoding', async () => {
    const Attrs = Schema.Struct({
      asJson: Schema.Struct({ id: Schema.String }).pipe(
        OtelAttr.key({ key: 'json', encode: 'json' }),
      ),
      asString: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'string', encode: 'string' })),
      asNumber: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'number', encode: 'number' })),
      asBoolean: Schema.Boolean.pipe(OtelAttr.key({ key: 'boolean', encode: 'boolean' })),
      secret: Schema.Redacted(Schema.String).pipe(
        OtelAttr.key({ key: 'secret', encode: 'redacted' }),
      ),
    })
    const attrs = await Effect.runPromise(OtelAttrs.define(Attrs))

    const invalidInputs = [
      {
        asJson: { id: 1 },
        asString: 1,
        asNumber: 1,
        asBoolean: true,
        secret: Redacted.make('ok'),
      },
      {
        asJson: { id: 'ok' },
        asString: -1,
        asNumber: 1,
        asBoolean: true,
        secret: Redacted.make('ok'),
      },
      {
        asJson: { id: 'ok' },
        asString: 1,
        asNumber: Number.NaN,
        asBoolean: true,
        secret: Redacted.make('ok'),
      },
      {
        asJson: { id: 'ok' },
        asString: 1,
        asNumber: 1,
        asBoolean: 'true',
        secret: Redacted.make('ok'),
      },
      {
        asJson: { id: 'ok' },
        asString: 1,
        asNumber: 1,
        asBoolean: true,
        secret: Redacted.make(1),
      },
    ]
    const results = await Promise.all(
      invalidInputs.map((invalid) =>
        Effect.runPromise(Effect.either(attrs.encode(invalid as never))),
      ),
    )

    for (const result of results) {
      expect(result).toMatchObject({
        _tag: 'Left',
        left: expect.any(OtelAttrEncodeError),
      })
    }
  })

  it('feeds compiled attributes into otelite trace expectations', async () => {
    const attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          label: Schema.String.pipe(OtelAttr.spanLabel()),
          count: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'retry.count' })),
        }),
      ),
    )
    const span = OtelSpan.define({ name: 'rpc.op.submit', attributes: attrs })
    const trace = expectTrace([
      {
        schema: 'otelite.span/v1',
        service: 'op-proxy',
        name: 'rpc.op.submit',
        trace_id: 'trace-1',
        span_id: 'span-1',
        parent_span_id: null,
        start_unix_nano: '1',
        end_unix_nano: '2',
        duration_ms: 1,
        status_code: 0,
        attrs: {
          'span.label': 'read',
          'retry.count': '2',
        },
      },
    ])

    expect(
      trace.expectAttributes({
        attributes: attrs,
        match: { label: 'read', count: 2 },
      }),
    ).toHaveLength(1)
    expect(
      trace.expectSpan({
        span,
        match: { label: 'read', count: 2 },
      }).span_id,
    ).toBe('span-1')
  })

  it('exposes compiled metadata for docs, lint, and future metric contracts', async () => {
    const attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          label: Schema.NonEmptyTrimmedString.pipe(OtelAttr.spanLabel()),
          outcome: OtelAttr.literal('op.outcome', 'success', 'retryable', 'terminal'),
          cacheHit: OtelAttr.boolean('op.cache_hit'),
          requestId: OtelAttr.string('request.id', { cardinality: 'high' }),
          payload: OtelAttr.json('op.payload', Schema.Struct({ id: Schema.String })),
        }),
      ),
    )

    expect(attrs.fields).toMatchInlineSnapshot(`
      [
        {
          "astTag": "Refinement",
          "attrKey": "span.label",
          "encodePolicy": "auto",
          "optional": false,
          "role": "span.label",
          "schemaIdentifier": "NonEmptyTrimmedString",
          "sourceKey": "label",
        },
        {
          "astTag": "Union",
          "attrKey": "op.outcome",
          "cardinality": "bounded",
          "encodePolicy": "auto",
          "optional": false,
          "sourceKey": "outcome",
        },
        {
          "astTag": "BooleanKeyword",
          "attrKey": "op.cache_hit",
          "cardinality": "low",
          "encodePolicy": "auto",
          "optional": false,
          "sourceKey": "cacheHit",
        },
        {
          "astTag": "StringKeyword",
          "attrKey": "request.id",
          "cardinality": "high",
          "encodePolicy": "auto",
          "optional": false,
          "sourceKey": "requestId",
        },
        {
          "astTag": "TypeLiteral",
          "attrKey": "op.payload",
          "encodePolicy": "json",
          "optional": false,
          "sourceKey": "payload",
        },
      ]
    `)
  })
})

describe('OtelSpan', () => {
  it('wraps effects with schema-backed attributes', async () => {
    const Attrs = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          label: Schema.String.pipe(OtelAttr.spanLabel()),
        }),
      ),
    )
    const span = OtelSpan.define({ name: 'test.span', attributes: Attrs })

    await expect(
      Effect.runPromise(
        OtelSpan.with({
          span,
          attributes: { label: 'contract' },
          effect: Effect.succeed('ok'),
        }),
      ),
    ).resolves.toBe('ok')

    await expect(
      Effect.runPromise(
        Effect.succeed('ok').pipe(OtelSpan.with({ span, attributes: { label: 'pipe' } })),
      ),
    ).resolves.toBe('ok')
  })

  it('requires span.label at definition and runtime', async () => {
    const WithoutLabel = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          value: Schema.String.pipe(OtelAttr.key({ key: 'value' })),
        }),
      ),
    )
    expect(() => OtelSpan.define({ name: 'test.no-label', attributes: WithoutLabel })).toThrow(
      OtelAttrPlanError,
    )

    const AccidentalLabel = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          value: Schema.String.pipe(OtelAttr.key({ key: 'span.label' })),
        }),
      ),
    )
    expect(() =>
      OtelSpan.define({ name: 'test.accidental-label', attributes: AccidentalLabel }),
    ).toThrow(OtelAttrPlanError)

    const WithOptionalLabel = await Effect.runPromise(
      OtelAttrs.define(
        Schema.Struct({
          label: Schema.optional(Schema.String.pipe(OtelAttr.spanLabel())),
        }),
      ),
    )
    const span = OtelSpan.define({ name: 'test.optional-label', attributes: WithOptionalLabel })

    await expect(
      Effect.runPromise(
        Effect.either(
          OtelSpan.with({
            span,
            attributes: {},
            effect: Effect.succeed('ok'),
          }),
        ),
      ),
    ).resolves.toMatchObject({
      _tag: 'Left',
      left: expect.any(OtelAttrEncodeError),
    })
  })

  it('wraps streams with schema-backed attributes', async () => {
    const span = OtelSpan.defineSync({
      name: 'test.stream',
      schema: Schema.Struct({
        label: OtelAttr.string('span.label', { role: 'span.label' }),
        count: OtelAttr.number('stream.count'),
      }),
    })

    await expect(
      Effect.runPromise(
        Stream.fromIterable([1, 2]).pipe(
          OtelSpan.withStream({ span, attributes: { label: 'items', count: 2 } }),
          Stream.runCollect,
        ),
      ),
    ).resolves.toBeDefined()
  })
})

describe('OtelOperation', () => {
  it('defines the normal user-facing operation API without a schema-level span label', async () => {
    const PullPage = OtelOperation.define({
      name: 'notion-md.pull-page',
      schema: Schema.Struct({
        pageId: OtelAttr.string('notion_md.page_id', { cardinality: 'high' }),
        basename: OtelAttr.string('notion_md.path.basename'),
        cacheHit: OtelAttr.boolean('notion_md.cache_hit'),
        outcome: OtelAttr.literal('notion_md.outcome', 'created', 'updated', 'skipped'),
      }),
      label: ({ basename }) => basename,
    })

    await expect(
      Effect.runPromise(
        PullPage.encode({
          pageId: 'page-1',
          basename: 'README.md',
          cacheHit: true,
          outcome: 'updated',
        }),
      ),
    ).resolves.toEqual({
      'span.label': 'README.md',
      'notion_md.page_id': 'page-1',
      'notion_md.path.basename': 'README.md',
      'notion_md.cache_hit': true,
      'notion_md.outcome': 'updated',
    })

    await expect(
      Effect.runPromise(
        PullPage.with({
          attributes: {
            pageId: 'page-1',
            basename: 'README.md',
            cacheHit: true,
            outcome: 'updated',
          },
          effect: Effect.succeed('ok'),
        }),
      ),
    ).resolves.toBe('ok')

    await expect(
      Effect.runPromise(
        Effect.succeed('ok').pipe(
          PullPage.with({
            pageId: 'page-1',
            basename: 'README.md',
            cacheHit: true,
            outcome: 'updated',
          }),
        ),
      ),
    ).resolves.toBe('ok')

    expect(PullPage.metadata).toMatchObject({
      kind: 'operation',
      name: 'notion-md.pull-page',
      root: false,
      derivesSpanLabel: true,
      attributeKeys: [
        'notion_md.page_id',
        'notion_md.path.basename',
        'notion_md.cache_hit',
        'notion_md.outcome',
        'span.label',
      ],
    })
  })

  it('rejects empty derived labels', async () => {
    const Operation = OtelOperation.define({
      name: 'test.empty-label',
      schema: Schema.Struct({
        value: OtelAttr.string('test.value'),
      }),
      label: () => '   ',
    })

    await expect(
      Effect.runPromise(Effect.either(Operation.encode({ value: 'ok' }))),
    ).resolves.toMatchObject({
      _tag: 'Left',
      left: expect.any(OtelAttrEncodeError),
    })
  })

  it('wraps root spans and streams through the operation contract', async () => {
    const Operation = OtelOperation.define({
      name: 'test.operation.stream',
      schema: Schema.Struct({
        value: OtelAttr.string('test.value'),
      }),
      label: ({ value }) => value,
    })

    await expect(
      Effect.runPromise(
        Operation.withRoot({
          attributes: { value: 'root' },
          effect: Effect.succeed('ok'),
        }),
      ),
    ).resolves.toBe('ok')

    await expect(
      Effect.runPromise(
        Stream.fromIterable(['a', 'b']).pipe(
          Operation.withStream({ value: 'stream' }),
          Stream.runCollect,
        ),
      ),
    ).resolves.toBeDefined()
  })
})

describe('OtelMetric', () => {
  it('defines runtime-light counter metadata with schema-backed labels', async () => {
    const Invocations = OtelMetric.counter({
      name: 'restate_invocations_total',
      description: 'Restate invocations by service, handler, and outcome.',
      unit: '1',
      labels: Schema.Struct({
        service: OtelAttr.string('restate.service', { cardinality: 'bounded' }),
        handler: OtelAttr.string('restate.handler', { cardinality: 'bounded' }),
        outcome: OtelAttr.literal(
          'restate.outcome',
          'success',
          'terminal',
          'retryable',
          'cancelled',
        ),
        cacheHit: OtelAttr.boolean('restate.cache_hit'),
      }),
    })

    await expect(
      Effect.runPromise(
        Invocations.encodeLabels({
          service: 'notion-sync',
          handler: 'pull',
          outcome: 'success',
          cacheHit: true,
        }),
      ),
    ).resolves.toEqual({
      'restate.service': 'notion-sync',
      'restate.handler': 'pull',
      'restate.outcome': 'success',
      'restate.cache_hit': true,
    })

    expect(Invocations.metadata).toMatchInlineSnapshot(`
      {
        "description": "Restate invocations by service, handler, and outcome.",
        "instrument": "counter",
        "kind": "metric",
        "labelKeys": [
          "restate.service",
          "restate.handler",
          "restate.outcome",
          "restate.cache_hit",
        ],
        "labels": [
          {
            "astTag": "StringKeyword",
            "attrKey": "restate.service",
            "cardinality": "bounded",
            "encodePolicy": "auto",
            "optional": false,
            "sourceKey": "service",
          },
          {
            "astTag": "StringKeyword",
            "attrKey": "restate.handler",
            "cardinality": "bounded",
            "encodePolicy": "auto",
            "optional": false,
            "sourceKey": "handler",
          },
          {
            "astTag": "Union",
            "attrKey": "restate.outcome",
            "cardinality": "bounded",
            "encodePolicy": "auto",
            "optional": false,
            "sourceKey": "outcome",
          },
          {
            "astTag": "BooleanKeyword",
            "attrKey": "restate.cache_hit",
            "cardinality": "low",
            "encodePolicy": "auto",
            "optional": false,
            "sourceKey": "cacheHit",
          },
        ],
        "name": "restate_invocations_total",
        "unit": "1",
      }
    `)
  })

  it('defines histogram metadata without owning runtime emission', () => {
    const labels = OtelMetric.labels(
      Schema.Struct({
        operation: OtelAttr.literal('operation', 'pull', 'push'),
      }),
    )
    const DurationMs = OtelMetric.histogram({
      name: 'operation_duration_ms',
      description: 'Operation duration.',
      unit: 'ms',
      boundaries: [10, 50, 100, 500, 1000],
      labels,
    })

    expect(DurationMs).not.toHaveProperty('increment')
    expect(DurationMs).not.toHaveProperty('record')
    expect(DurationMs.metadata).toMatchObject({
      kind: 'metric',
      instrument: 'histogram',
      name: 'operation_duration_ms',
      unit: 'ms',
      labelKeys: ['operation'],
      boundaries: [10, 50, 100, 500, 1000],
    })
  })

  it('rejects high-cardinality and unspecified-cardinality metric labels', () => {
    expect(() =>
      OtelMetric.labels(
        Schema.Struct({
          workflowId: OtelAttr.string('restate.workflow.id', { cardinality: 'high' }),
        }),
      ),
    ).toThrow(OtelAttrPlanError)

    expect(() =>
      OtelMetric.labels(
        Schema.Struct({
          service: OtelAttr.string('restate.service'),
        }),
      ),
    ).toThrow(OtelAttrPlanError)
  })

  it('rejects invalid histogram boundaries', () => {
    expect(() =>
      OtelMetric.histogram({
        name: 'bad_histogram',
        boundaries: [10, 5],
        labels: Schema.Struct({
          status: OtelAttr.literal('status', 'ok', 'failed'),
        }),
      }),
    ).toThrow(OtelAttrPlanError)

    expect(() =>
      OtelMetric.histogram({
        name: 'nan_histogram',
        boundaries: [Number.NaN],
        labels: Schema.Struct({
          status: OtelAttr.literal('status', 'ok', 'failed'),
        }),
      }),
    ).toThrow(OtelAttrPlanError)
  })
})
