import * as restate from '@restatedev/restate-sdk'
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { effectSerde } from './Serde.ts'

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
    /* Date <-> ISO string: proves encode produces the wire (`I`) shape and
     * decode reconstructs the rich (`A`) value. */
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

  it('throws a TerminalError(400) on malformed input', () => {
    const serde = effectSerde(Schema.Struct({ n: Schema.Number }))
    const badBytes = new TextEncoder().encode(JSON.stringify({ n: 'not-a-number' }))
    try {
      serde.deserialize(badBytes)
      expect.unreachable('expected a TerminalError')
    } catch (error) {
      expect(error).toBeInstanceOf(restate.TerminalError)
      expect((error as restate.TerminalError).code).toBe(400)
    }
  })
})
