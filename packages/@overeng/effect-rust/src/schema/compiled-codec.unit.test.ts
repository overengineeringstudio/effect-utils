import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import { AdmissionError } from '../compiler/mod.ts'
import { Input, Transport } from '../runtime/errors.ts'
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
    if (cause instanceof Schema.SchemaError === false) throw cause
    const boundary =
      direction === 'encode'
        ? new Input({ operation: 'nestedMatch', message: cause.message, cause })
        : new Transport({ operation: 'nestedMatch', message: cause.message, cause })
    // Deep issue equality includes every Pointer path, leaf kind, union branch,
    // and first-error choice; boundary mapping is the generated service's mapping.
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

describe('compiled direct codec equivalence', () => {
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
