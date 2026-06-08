import * as restate from '@restatedev/restate-sdk'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { Restate } from './Annotations.ts'
import { normalizeStateSchema } from './RestateContext.ts'
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
