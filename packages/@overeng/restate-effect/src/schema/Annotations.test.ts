/**
 * Contract-annotation PLACEMENT validation (decision 0020). A field-level
 * annotation (`Restate.idempotencyKey` / `Restate.sensitive`) applied to the
 * STRUCT instead of a field, or a DUPLICATE idempotency-key field, is otherwise a
 * SILENT no-op (the field-walking readers never see a struct-level annotation; the
 * first idempotency hit wins). `validateInputAnnotations` surfaces each as a clear
 * diagnostic so `materialize*` can fail loudly.
 */
import { Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import { Restate, validateInputAnnotations } from './Annotations.ts'

describe('validateInputAnnotations (decision 0020)', () => {
  it('a correctly-placed idempotencyKey FIELD passes (no violations)', () => {
    const input = Schema.Struct({ key: Restate.idempotencyKey(Schema.String), n: Schema.Number })
    expect(validateInputAnnotations(input.ast, 'Svc.handler')).toEqual([])
  })

  it('a correctly-placed sensitive FIELD passes (no violations)', () => {
    const input = Schema.Struct({ token: Restate.sensitive(Schema.String) })
    expect(validateInputAnnotations(input.ast, 'Svc.handler')).toEqual([])
  })

  it('REJECTS Restate.idempotencyKey applied to the STRUCT (wrong AST node)', () => {
    /* The annotation lands on the TypeLiteral, not a field → silently ignored. */
    const input = Restate.idempotencyKey(Schema.Struct({ key: Schema.String }))
    const violations = validateInputAnnotations(input.ast, 'Svc.handler')
    expect(violations.map((v) => v._tag)).toEqual(['idempotencyKeyOnStruct'])
    expect(violations[0]!.message).toContain('Svc.handler')
    expect(violations[0]!.message).toContain('STRUCT')
  })

  it('REJECTS Restate.sensitive applied to the STRUCT (wrong AST node)', () => {
    const input = Restate.sensitive(Schema.Struct({ token: Schema.String }))
    const violations = validateInputAnnotations(input.ast, 'Svc.handler')
    expect(violations.map((v) => v._tag)).toEqual(['sensitiveOnStruct'])
    expect(violations[0]!.message).toContain('NOT encrypted')
  })

  it('REJECTS DUPLICATE idempotency-key fields (ambiguous single source)', () => {
    const input = Schema.Struct({
      a: Restate.idempotencyKey(Schema.String),
      b: Restate.idempotencyKey(Schema.String),
    })
    const violations = validateInputAnnotations(input.ast, 'Svc.handler')
    expect(violations.map((v) => v._tag)).toEqual(['duplicateIdempotencyKey'])
    expect(violations[0]!.message).toContain('[a, b]')
  })

  it('a non-struct input (e.g. Schema.String) yields no violations', () => {
    expect(validateInputAnnotations(Schema.String.ast, 'Svc.handler')).toEqual([])
    expect(validateInputAnnotations(Schema.Void.ast, 'Svc.handler')).toEqual([])
  })
})
