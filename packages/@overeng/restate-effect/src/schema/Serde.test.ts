import { it as fcIt } from '@effect/vitest'
import * as restate from '@restatedev/restate-sdk'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { normalizeStateSchema } from '../authoring/RestateContext.ts'
import { Restate } from './Annotations.ts'
import { aesGcmCipher } from './Redaction.ts'
import { effectSerde, ingressSerde, internalSerde } from './Serde.ts'

describe('effectSerde', () => {
  it('round-trips a plain struct', () => {
    const schema = Schema.Struct({ name: Schema.String, age: Schema.Number })
    const serde = effectSerde(schema)
    const value = { name: 'Sarah', age: 42 }
    const bytes = serde.serialize(value)
    expect(serde.deserialize(bytes)).toStrictEqual(value)
    expect(serde.contentType).toBe('application/json')
    expect(serde.jsonSchema).toBeDefined()
  })

  it('handles a transformed schema where encoded ≠ decoded', () => {
    /* Date <-> ISO string: encode produces the wire (`I`) shape, decode
     * reconstructs the rich (`A`) value. */
    const schema = Schema.Struct({ at: Schema.Date })
    const serde = effectSerde(schema)
    const value = { at: new Date('2026-06-08T12:00:00.000Z') }

    const bytes = serde.serialize(value)
    const wire = JSON.parse(new TextDecoder().decode(bytes)) as { at: string }
    expect(wire.at).toBe('2026-06-08T12:00:00.000Z')

    const back = serde.deserialize(bytes)
    expect(back.at).toBeInstanceOf(Date)
    expect(back.at.getTime()).toBe(value.at.getTime())
  })

  it('round-trips a branded schema', () => {
    const UserId = Schema.String.pipe(Schema.brand('UserId'))
    const schema = Schema.Struct({ id: UserId })
    const serde = effectSerde(schema)
    const value = { id: Schema.decodeSync(UserId)('u_1') }
    expect(serde.deserialize(serde.serialize(value))).toStrictEqual(value)
  })

  it('honors the Restate.serde annotation contentType override', () => {
    const schema = Restate.serde(Schema.Struct({ n: Schema.Number }), {
      contentType: 'application/vnd.custom+json',
    })
    expect(effectSerde(schema).contentType).toBe('application/vnd.custom+json')
  })

  it('throws TerminalError(400) on a malformed INGRESS input', () => {
    const serde = ingressSerde(Schema.Struct({ n: Schema.Number }))
    const badBytes = new TextEncoder().encode(JSON.stringify({ n: 'not-a-number' }))
    try {
      serde.deserialize(badBytes)
      expect.unreachable('expected a TerminalError')
    } catch (error) {
      expect(error).toBeInstanceOf(restate.TerminalError)
      expect((error as restate.TerminalError).code).toBe(400)
    }
  })

  it('rethrows a raw defect (not a TerminalError) on a malformed INTERNAL slot', () => {
    /* A corrupt-journal decode failure must NOT become a 400 to the caller. */
    const serde = internalSerde(Schema.Struct({ n: Schema.Number }))
    const badBytes = new TextEncoder().encode(JSON.stringify({ n: 'not-a-number' }))
    try {
      serde.deserialize(badBytes)
      expect.unreachable('expected a thrown defect')
    } catch (error) {
      expect(error).not.toBeInstanceOf(restate.TerminalError)
    }
  })
})

describe('State.for optional field serde (papercut)', () => {
  it('a plain Schema state field passes through normalize unchanged', () => {
    const serde = effectSerde(normalizeStateSchema(Schema.Number))
    expect(serde.deserialize(serde.serialize(42))).toBe(42)
  })

  it('a Schema.optional state field round-trips its value type via the recovered schema', () => {
    /* `State.for({ note: Schema.optional(Schema.String) })` — the optional field's
     * value schema is recovered from the PropertySignature AST so the State serde
     * round-trips a present value. (Absent state is read as `undefined` by the
     * State combinator, which never reaches the serde.) */
    const serde = effectSerde(normalizeStateSchema(Schema.optional(Schema.String)))
    expect(serde.deserialize(serde.serialize('hi'))).toBe('hi')
  })
})

/**
 * Property-based serde round-trips (spec §4, §11.4). The claim "`decode(encode(x))
 * ≡ x` over an `Arbitrary` derived from the schema is first-class" is made REAL
 * here: `@effect/vitest` `it.prop` derives a `fast-check` arbitrary from each
 * schema and asserts `deserialize(serialize(x))` is equivalent to `x` for every
 * generated value. Comparison uses `Schema.equivalence(schema)` — NOT
 * `toStrictEqual` — so transformed/branded values compare by their decoded VALUE,
 * the property that actually matters for a serde.
 */
describe('effectSerde property round-trips (§11.4)', () => {
  /* A plain struct of primitives. */
  const Plain = Schema.Struct({
    name: Schema.String,
    age: Schema.Int,
    active: Schema.Boolean,
    tags: Schema.Array(Schema.String),
  })
  fcIt.prop('round-trips a plain struct', [Plain], ([value]) => {
    const serde = effectSerde(Plain)
    const eq = Schema.equivalence(Plain)
    expect(eq(serde.deserialize(serde.serialize(value)), value)).toBe(true)
  })

  /* A TRANSFORMED schema (encoded ≠ decoded): Date ↔ ISO, a bigint, a branded id. */
  const UserId = Schema.String.pipe(Schema.brand('UserId'))
  const Transformed = Schema.Struct({
    id: UserId,
    createdAt: Schema.Date,
    score: Schema.BigInt,
  })
  fcIt.prop('round-trips a transformed schema (encoded ≠ decoded)', [Transformed], ([value]) => {
    const serde = effectSerde(Transformed)
    const eq = Schema.equivalence(Transformed)
    expect(eq(serde.deserialize(serde.serialize(value)), value)).toBe(true)
  })

  /* An OPTIONAL state field (the `normalizeStateSchema` papercut path): a present
   * value must round-trip through the recovered value schema. Constrained to a
   * FINITE number — `NaN`/`±Infinity` have no JSON representation (`JSON.stringify`
   * emits `null`), so they are outside the serde's round-trippable domain by
   * design, not a bug. */
  const FiniteValue = Schema.Finite
  const OptionalState = normalizeStateSchema(Schema.optional(FiniteValue))
  fcIt.prop(
    'round-trips an optional state field value (normalizeStateSchema)',
    [FiniteValue],
    ([value]) => {
      const serde = effectSerde(OptionalState)
      const eq = Schema.equivalence(OptionalState)
      expect(eq(serde.deserialize(serde.serialize(value)), value)).toBe(true)
    },
  )

  /* CRITICAL: the redaction transform itself — `encrypt(decrypt(x)) ≡ x`. A fresh
   * IV per encrypt means the wire bytes differ each time, so the round-trip holds
   * by VALUE (the whole point of `Schema.equivalence` over byte equality). */
  const Redacted = Schema.Struct({
    to: Schema.String,
    body: Restate.sensitive(Schema.String),
    /* Finite — a redacted `NaN`/`±Infinity` JSON-stringifies to `null` inside the
     * cipher payload too, so it is outside the round-trippable domain by design. */
    pin: Restate.redacted(Schema.Finite),
  })
  const cipher = aesGcmCipher(new Uint8Array(32).fill(7))
  fcIt.prop(
    'round-trips the redaction transform by value (encrypt∘decrypt ≡ id)',
    [Redacted],
    ([value]) => {
      const serde = effectSerde(Redacted, 'internal', { redaction: cipher })
      const eq = Schema.equivalence(Redacted)
      expect(eq(serde.deserialize(serde.serialize(value)), value)).toBe(true)
    },
  )
})
