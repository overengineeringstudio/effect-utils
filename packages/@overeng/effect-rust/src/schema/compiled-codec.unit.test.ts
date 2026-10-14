import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import { contracts } from '../compiler/fixtures/contracts.ts'
import vectors from '../compiler/fixtures/vectors.json' with { type: 'json' }
import { AdmissionError } from '../compiler/mod.ts'
import { Input, Transport } from '../runtime/errors.ts'
import * as ContractJson from './contract-json.ts'
import * as Direct from './direct.ts'
import * as EffectRust from './effect-rust.ts'
import { decode, decodeReference, encode, encodeReference } from './validation.ts'

const u32 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 }))
const recording = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  durationMs: u32,
  isrc: Schema.optional(Schema.String),
  release: Schema.optionalKey(Schema.String),
  album: Schema.optionalKey(Schema.String),
})
const nested = Schema.NullOr(
  Schema.Struct({
    artist: Schema.Struct({ id: Schema.String, name: Schema.String }),
    artistMatchScore: EffectRust.F32,
    averageRecordingScore: Schema.NullOr(EffectRust.F32),
    recordings: Schema.Array(Schema.Struct({ recording, matchingScore: EffectRust.F32 })),
  }),
)
const sample = () => ({
  artist: { id: 'artist-1', name: 'Example Artist' },
  artistMatchScore: 0.9,
  averageRecordingScore: 0.8,
  recordings: [
    {
      recording: { id: 'recording-1', title: 'Example Recording', durationMs: 180000 },
      matchingScore: 0.8,
    },
  ],
})

const outcome = (
  run: (value: unknown) => unknown,
  value: unknown,
  direction: 'encode' | 'decode',
) => {
  try {
    return { value: run(value) }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    const boundary =
      direction === 'encode'
        ? new Input({ operation: 'nestedMatch', message, cause })
        : new Transport({ operation: 'nestedMatch', message, cause })
    if (cause instanceof Schema.SchemaError === false)
      return {
        error: boundary._tag,
        message: boundary.message,
        errorClass: cause instanceof Error ? cause.constructor : typeof cause,
        cause: cause instanceof Error ? cause.cause : cause,
      }
    // Deep issue equality includes paths, branches, ASTs and first-error choice.
    return { error: boundary._tag, message: boundary.message, issue: cause.issue }
  }
}
const compare = (schema: Schema.ConstraintCodec<unknown>, values: ReadonlyArray<unknown>) => {
  const codec = Direct.codec(schema)
  for (const direction of ['decode', 'encode'] as const) {
    const fast = direction === 'decode' ? decode(codec) : encode(codec, { omitOptional: true })
    const reference =
      direction === 'decode'
        ? decodeReference(codec)
        : encodeReference(codec, { omitOptional: true })
    for (const value of values)
      expect(outcome(fast, value, direction)).toStrictEqual(outcome(reference, value, direction))
  }
}
const compareFactory = (schema: Schema.ConstraintCodec<unknown>, create: () => unknown) => {
  const codec = Direct.codec(schema)
  for (const direction of ['decode', 'encode'] as const) {
    const fast = direction === 'decode' ? decode(codec) : encode(codec, { omitOptional: true })
    const reference =
      direction === 'decode'
        ? decodeReference(codec)
        : encodeReference(codec, { omitOptional: true })
    expect(outcome(fast, create(), direction)).toStrictEqual(
      outcome(reference, create(), direction),
    )
  }
}

describe('compiled direct codec equivalence', () => {
  it('retains caller-supplied decoder parse options on the reference path', () => {
    const codec = Direct.codec(Schema.Struct({ first: Schema.String, later: u32 }))
    const value = { first: 1, later: -1, extra: true }
    for (const options of [{}, { errors: 'all' }, { onExcessProperty: 'ignore' }] as const)
      expect(outcome((input) => decode(codec)(input, options), value, 'decode')).toStrictEqual(
        outcome((input) => decodeReference(codec)(input, options), value, 'decode'),
      )
    expect(
      decode(codec)({ first: 'ok', later: 1, extra: true }, { onExcessProperty: 'ignore' }),
    ).toStrictEqual({ first: 'ok', later: 1 })
  })

  it('snapshots array length despite shrinking, growing and proxy length changes', () => {
    const schema = Schema.Array(Schema.String)
    for (const change of ['shrink', 'grow'] as const)
      compareFactory(schema, () => {
        const value = ['first', 'second']
        Object.defineProperty(value, 0, {
          enumerable: true,
          configurable: true,
          get: () => {
            if (change === 'shrink') value.length = 1
            else value.push('third')
            return 'ok'
          },
        })
        return value
      })
    compareFactory(schema, () => {
      let reads = 0
      return new Proxy(['first', 'second'], {
        get: (target, key, receiver) =>
          key === 'length' ? (++reads === 1 ? 2 : 1) : Reflect.get(target, key, receiver),
      })
    })
  })

  it('retains empty-struct candidate domains and suspended nullable ordering', () => {
    const empty = Schema.Struct({})
    compare(Schema.NullOr(empty), [null, undefined, 'ok', 1, false, [], {}, () => {}])
    compare(Schema.NullOr(Schema.suspend(() => empty)), [null, undefined, 'ok', [], {}])
    compare(Schema.NullOr(EffectRust.F32), [null, undefined, 'ok', [], {}, NaN, Infinity, 0.1])
    compare(Schema.NullOr(Schema.Array(Schema.String)), [null, undefined, [], ['ok'], 1, {}])
  })

  it('keeps omission of unparsed empty-struct values after complete validation', () => {
    const defect = new Error('unparsed output accessor')
    const empty = Schema.Struct({})
    const value = {
      get extra() {
        throw defect
      },
    }
    compare(Schema.Struct({ first: empty, later: Schema.String }), [
      { first: value, later: 1 },
      { first: value, later: 'ok' },
    ])
    compare(Schema.Struct({ first: Schema.NullOr(empty), later: Schema.String }), [
      { first: value, later: 1 },
      { first: value, later: 'ok' },
    ])
    compareFactory(Schema.Struct({ first: empty, later: Schema.String }), () => {
      const root: { first: object; later: unknown } = { first: {}, later: 1 }
      root.first = {
        get extra() {
          root.later = 'changed'
          return 'ok'
        },
      }
      return root
    })
  })

  it('preserves defect wrapping for reflection without replay or schema-error confusion', () => {
    const schema = Schema.Struct({ value: Schema.String })
    let schemaError: unknown
    try {
      Schema.decodeUnknownSync(Schema.String)(1)
    } catch (cause) {
      schemaError = cause
    }
    for (const defect of [new Error('boom'), schemaError, 'boom', null, undefined]) {
      compare(schema, [
        {
          get value() {
            throw defect
          },
        },
      ])
      compare(Schema.Array(Schema.String), [
        Object.defineProperty(['ok'], 0, {
          get: () => {
            throw defect
          },
        }),
      ])
      for (const trap of ['ownKeys', 'getOwnPropertyDescriptor', 'has', 'get'] as const) {
        const handler: ProxyHandler<object> = {
          [trap]: () => {
            throw defect
          },
        }
        compare(schema, [
          new Proxy(trap === 'has' ? { value: 'ok' } : { value: 'ok', extra: 1 }, handler),
        ])
      }
      const tagged = Schema.Union([
        Schema.TaggedStruct('Item', { value: Schema.String }),
        Schema.TaggedStruct('Empty', {}),
      ])
      const tagAccess = {
        get _tag() {
          throw defect
        },
        value: 'ok',
      }
      // Root discriminator access is raw; inside a struct it becomes a defect.
      compare(tagged, [tagAccess])
      compare(Schema.Struct({ nested: tagged }), [{ nested: tagAccess }])
      for (const trap of ['has', 'get'] as const) {
        const proxy = new Proxy(
          { _tag: 'Item', value: 'ok' },
          {
            [trap]: () => {
              throw defect
            },
          },
        )
        compare(tagged, [proxy])
        compare(Schema.Struct({ nested: tagged }), [{ nested: proxy }])
      }
      const deferred = Schema.Union([
        Schema.suspend(() => Schema.TaggedStruct('Item', { value: Schema.String })),
        Schema.suspend(() => Schema.TaggedStruct('Empty', {})),
      ])
      compare(deferred, [
        {
          _tag: 'Item',
          get value() {
            throw defect
          },
        },
      ])
    }
    for (const value of [{ value: 'ok' }, ['ok']]) {
      const revocable = Proxy.revocable(value, {})
      revocable.revoke()
      compare(Array.isArray(value) ? Schema.Array(Schema.String) : schema, [revocable.proxy])
      for (const nullable of [
        Schema.NullOr(Schema.String),
        Schema.NullOr(u32),
        Schema.NullOr(schema),
        Schema.NullOr(Schema.Array(Schema.String)),
        Schema.NullOr(Schema.suspend(() => schema)),
        Schema.Union([
          Schema.suspend(() => Schema.TaggedStruct('Item', { value: Schema.String })),
          Schema.suspend(() => Schema.TaggedStruct('Empty', {})),
        ]),
      ]) {
        compare(nullable, [revocable.proxy])
        compare(Schema.Struct({ nested: nullable }), [{ nested: revocable.proxy }])
      }
    }
  })

  it('runs shared contract vectors through both directions of both paths', () => {
    for (const vector of vectors) {
      const schema = contracts[vector.contract as keyof typeof contracts]
      compare(schema, [vector.input])
      if (vector.accept) {
        const value = ContractJson.decode(schema)(JSON.stringify(vector.input))
        compare(schema, [value, Direct.encode(schema)(value)])
      }
    }
  })

  it.prop(
    'matches generated admitted schemas, values, proxies and accessors',
    {
      recipe: Schema.Struct({
        leaf: Schema.Literals(['string', 'u32', 'boolean', 'empty']),
        wrappers: Schema.Array(
          Schema.Literals(['array', 'struct', 'nullable', 'suspend', 'optional', 'tagged']),
        ).check(Schema.isMaxLength(3)),
        text: Schema.String,
        number: u32,
        flag: Schema.Boolean,
        candidate: Schema.Union([
          Schema.String,
          u32,
          Schema.Boolean,
          Schema.Null,
          Schema.Array(Schema.String),
        ]),
      }),
    },
    ({ recipe }) => {
      let schema: Schema.Codec<unknown>
      let value: unknown
      switch (recipe.leaf) {
        case 'string':
          schema = Schema.String
          value = recipe.text
          break
        case 'u32':
          schema = u32
          value = recipe.number
          break
        case 'boolean':
          schema = Schema.Boolean
          value = recipe.flag
          break
        case 'empty':
          schema = Schema.Struct({})
          value = {}
          break
      }
      for (const wrapper of recipe.wrappers) {
        const inner = schema
        switch (wrapper) {
          case 'array':
            schema = Schema.Array(inner)
            value = [value, value]
            break
          case 'struct':
            schema = Schema.Struct({ value: inner })
            value = { value }
            break
          case 'nullable':
            schema = Schema.NullOr(inner)
            if (recipe.flag) value = null
            break
          case 'suspend':
            schema = Schema.suspend(() => inner)
            break
          case 'optional':
            schema = Schema.Struct({ value: Schema.optionalKey(inner) })
            value = recipe.flag ? {} : { value }
            break
          case 'tagged':
            schema = Schema.Union([
              Schema.TaggedStruct('Item', { value: inner }),
              Schema.TaggedStruct('Empty', {}),
            ])
            value = recipe.flag ? { _tag: 'Empty' } : { _tag: 'Item', value }
            break
        }
      }
      compare(schema, [value, recipe.candidate, undefined, null, {}, [], { extra: 1 }])
      if (typeof value === 'object' && value !== null) {
        const key = Reflect.ownKeys(value).find((key) => key !== 'length')
        compare(schema, [new Proxy(value, {})])
        if (key !== undefined) {
          const item = Reflect.get(value, key)
          const defect = new Error('generated accessor defect')
          compare(schema, [
            new Proxy(value, {
              get: (target, name, receiver) => {
                if (name === key && recipe.flag) throw defect
                return Reflect.get(target, name, receiver)
              },
            }),
          ])
          compareFactory(schema, () => {
            const copy = Array.isArray(value) ? [...value] : { ...value }
            Object.defineProperty(copy, key, {
              enumerable: true,
              configurable: true,
              get: () => item,
            })
            return copy
          })
        }
      }
    },
    { timeout: 30_000, arbitrary: { runs: 200, seed: 1234 } },
  )
  it('matches the interpreter for nested containers, omission, binary32 and errors', () => {
    const valid = sample()
    const values: unknown[] = [valid, null, undefined, {}, [], 1, 'invalid']
    for (const score of [null, NaN, Infinity, -Infinity, 3.5e38, -0, 0.1, 1e-45]) {
      values.push({ ...sample(), artistMatchScore: score })
      values.push({ ...sample(), averageRecordingScore: score })
      values.push({ ...sample(), recordings: [{ ...valid.recordings[0], matchingScore: score }] })
    }
    for (const optional of [undefined, null, 'present']) {
      for (const field of ['isrc', 'release', 'album']) {
        values.push({
          ...sample(),
          recordings: [
            {
              ...valid.recordings[0],
              recording: { ...valid.recordings[0]!.recording, [field]: optional },
            },
          ],
        })
      }
    }
    const objects = [valid, valid.artist, valid.recordings[0]!, valid.recordings[0]!.recording]
    for (let level = 0; level < objects.length; level++) {
      for (const key of Object.keys(objects[level]!)) {
        const value = sample()
        const target = [value, value.artist, value.recordings[0]!, value.recordings[0]!.recording][
          level
        ]!
        Reflect.deleteProperty(target, key)
        values.push(value)
      }
      const value = sample()
      const target = [value, value.artist, value.recordings[0]!, value.recordings[0]!.recording][
        level
      ]!
      Reflect.set(target, 'excess', true)
      values.push(value)
    }
    // Earlier field errors must win over excess in a later descendant.
    values.push({ ...sample(), artist: { id: 1, name: 'bad' }, recordings: [{ excess: true }] })
    values.push({ ...sample(), artist: { id: 1, name: 'bad' }, excess: true })
    for (const durationMs of [-1, -0, 4294967296, 1.5, Infinity]) {
      values.push({
        ...sample(),
        recordings: [
          { ...valid.recordings[0], recording: { ...valid.recordings[0]!.recording, durationMs } },
        ],
      })
    }
    compare(nested, values)
    expect(
      Direct.encode(nested)({
        ...valid,
        recordings: [
          {
            ...valid.recordings[0]!,
            recording: { ...valid.recordings[0]!.recording, isrc: undefined },
          },
        ],
      }),
    ).toEqual(Direct.encode(nested)(valid))
  })

  it('matches tagged unions, recursion, records and per-object ignore fallback', () => {
    const tagged = Schema.Union([
      Schema.TaggedStruct('Item', { value: recording }),
      Schema.TaggedStruct('Empty', {}),
    ])
    compare(tagged, [
      { _tag: 'Item', value: sample().recordings[0]!.recording },
      { _tag: 'Empty' },
      { _tag: 'Empty', extra: 1 },
      { _tag: 'Item', value: {} },
      { _tag: 'Unknown' },
    ])
    const item = Schema.TaggedStruct('Item', { value: recording })
    const empty = Schema.TaggedStruct('Empty', {})
    const alternatives = [
      { _tag: 'Item', value: sample().recordings[0]!.recording },
      { _tag: 'Empty' },
      { _tag: 'Empty', extra: 1 },
      { _tag: 'Item', value: {} },
      { _tag: 'Unknown' },
      {},
      [],
      1,
      undefined,
    ]
    compare(Schema.NullOr(item), [null, ...alternatives])
    compare(Schema.Union([Schema.suspend(() => item), Schema.suspend(() => empty)]), alternatives)
    compare(Schema.NullOr(Schema.suspend(() => tagged)), [
      null,
      { _tag: 'Item', value: sample().recordings[0]!.recording },
      { _tag: 'Empty' },
      { _tag: 'Unknown' },
      {},
      1,
      undefined,
    ])
    compare(Schema.NullOr(Schema.suspend(() => recording)), [
      null,
      sample().recordings[0]!.recording,
      {},
      [],
      1,
      undefined,
    ])
    const records = Schema.Record(Schema.String, recording)
    compare(records, [{ entry: sample().recordings[0]!.recording }, { entry: {} }])
    const ignored = Schema.Struct({
      inner: recording.annotate({ [EffectRust.excess]: 'ignore' }),
      strict: recording,
    })
    compare(ignored, [
      {
        inner: { ...sample().recordings[0]!.recording, extra: 1 },
        strict: sample().recordings[0]!.recording,
      },
    ])
    interface Tree {
      readonly name: string
      readonly children: ReadonlyArray<Tree>
    }
    const tree: Schema.Codec<Tree> = Schema.Struct({
      name: Schema.String,
      children: Schema.Array(Schema.suspend(() => tree)),
    })
    compare(tree, [
      { name: 'root', children: [{ name: 'leaf', children: [] }] },
      { name: 'root', children: [{ name: 'leaf', extra: 1 }] },
    ])
  })

  it('preserves own enumerable symbols, inherited fields, non-enumerable keys and accessor reads', () => {
    const schema = Schema.Struct({
      required: Schema.String,
      optional: Schema.optional(Schema.String),
    })
    const symbol = Symbol('excess')
    const hidden = Object.defineProperty({ required: 'ok' }, 'extra', { value: 1 })
    const hiddenField = Object.defineProperty({}, 'required', { value: 'ok' })
    const inherited = Object.create({ required: 'ok', extra: 1 })
    compare(schema, [{ required: 'ok', [symbol]: 1 }, hidden, hiddenField, inherited])
    let reads = 0
    const accessor = {
      get required() {
        reads++
        return 'ok'
      },
      optional: null,
    }
    const codec = Direct.codec(schema)
    expect(() => Direct.decode(schema)(accessor)).toThrow(Schema.SchemaError)
    expect(reads).toBe(1)
    reads = 0
    expect(() => decodeReference(codec)(accessor)).toThrow(Schema.SchemaError)
    expect(reads).toBe(1)
    const special = Schema.Struct({ ['__proto__']: Schema.String, constructor: Schema.String })
    compare(special, [
      Object.fromEntries([
        ['__proto__', 'safe'],
        ['constructor', 'safe'],
      ]),
      { constructor: 'safe' },
    ])
  })

  it('does not replay an excess-key failure against mutable input', () => {
    const schema = Schema.Struct({ required: Schema.String })
    let scans = 0
    const value = new Proxy(
      { required: 'ok', extra: true },
      {
        ownKeys: () => (++scans === 1 ? ['required', 'extra'] : ['required']),
      },
    )
    expect(() => Direct.decode(schema)(value)).toThrow(Schema.SchemaError)
    expect(scans).toBe(1)
    scans = 0
    expect(() => decodeReference(Direct.codec(schema))(value)).toThrow(Schema.SchemaError)
    expect(scans).toBe(1)
  })

  it('does not bypass admission', () => {
    const unsupported = Schema.Struct({ value: Schema.Finite })
    expect(() => Direct.decode(unsupported)).toThrow(AdmissionError)
    expect(() => Direct.encode(unsupported)).toThrow(AdmissionError)
    expect(() => Direct.codec(unsupported)).toThrow(AdmissionError)
  })
})
