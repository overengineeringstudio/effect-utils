import { runInNewContext } from 'node:vm'

import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import { renderJsonSchemaValidator } from './mod.ts'

const RecordSchema = Schema.Struct({
  _tag: Schema.Literal('record/v1'),
  level: Schema.Literals(['warning', 'critical']),
  id: Schema.String.check(Schema.isPattern(/^[a-z]+$/), Schema.isMinLength(2), Schema.isMaxLength(4)),
})
const generatedIs = (input: unknown): boolean =>
  Schema.decodeUnknownSync(Schema.Boolean)(runInNewContext(
    renderJsonSchemaValidator('isRecord', RecordSchema) + '\nisRecord(input)', { input },
  ))

describe('standalone JSON schema validator projection', () => {
  it('derives closed string-record validation including enum, pattern, and length constraints', () => {
    expect(generatedIs({ _tag: 'record/v1', level: 'critical', id: 'abcd' })).toBe(true)
    for (const invalid of [
      {}, { _tag: 'record/v1', level: 'critical' },
      { _tag: 'record/v2', level: 'critical', id: 'abc' },
      { _tag: 'record/v1', level: 'unknown', id: 'abc' },
      { _tag: 'record/v1', level: 'critical', id: 'a' },
      { _tag: 'record/v1', level: 'critical', id: 'abcde' },
      { _tag: 'record/v1', level: 'critical', id: 'a1' },
      { _tag: 'record/v1', level: 'critical', id: 'abc', extra: true },
    ]) expect(generatedIs(invalid)).toBe(false)
  })

  it('preserves UTF-16 length checks and Unicode regexp flags from the authority', () => {
    const schema = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(2), Schema.isPattern(/^.$/u))
    const isValue = (input: unknown) => runInNewContext(
      renderJsonSchemaValidator('isValue', schema) + '\nisValue(input)', { input },
    )
    expect(isValue(String.fromCodePoint(0x1f600))).toBe(true)
    expect(isValue('a')).toBe(false)
    expect(isValue('ab')).toBe(false)
    expect(isValue(String.fromCodePoint(0x1f600, 0x1f600))).toBe(false)
  })

  it('rejects unsafe declaration names at generation time', () => {
    expect(() => renderJsonSchemaValidator('validator; injected()', RecordSchema)).toThrow('Invalid validator declaration name')
  })
})
