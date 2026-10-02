import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { importRustSchema } from './import-rust.ts'
import { AdmissionError } from './ir.ts'
import type { ContractIR } from './ir.ts'
import { emitJsonSchema } from './json-schema.ts'

describe('Rust-owned JSON Schema admission', () => {
  it('preserves recursive wire semantics across JSON export and import', () => {
    const ir: ContractIR = {
      irVersion: 1,
      contract: 'Tree',
      defs: {
        Label: { kind: 'string', pattern: '^[a-z]+$', flags: 'iu', minLength: 2, maxLength: 8 },
        Tree: {
          kind: 'struct',
          excess: 'error',
          fields: [
            { wire: 'id', presence: 'required', type: { kind: 'u64' } },
            { wire: 'balance', presence: 'required', type: { kind: 'i64' } },
            { wire: 'count', presence: 'required', type: { kind: 'int', width: 'u32' } },
            { wire: 'at', presence: 'required', type: { kind: 'dateTime' } },
            { wire: 'label', presence: 'required', type: { kind: 'ref', name: 'Label' } },
            {
              wire: 'requiredNullable',
              presence: 'required',
              type: { kind: 'nullable', inner: { kind: 'string' } },
            },
            { wire: 'missingOnly', presence: 'optional', type: { kind: 'string' } },
            {
              wire: 'patch',
              presence: 'required',
              type: { kind: 'patch', inner: { kind: 'string' } },
            },
            {
              wire: 'children',
              presence: 'required',
              type: { kind: 'array', item: { kind: 'ref', name: 'Tree' } },
            },
          ],
        },
      },
    }
    expect(importRustSchema(emitJsonSchema(ir, 'Tree')).ir).toEqual(ir)
  })

  it('does not collapse optional, nullable and Patch properties', () => {
    const { ir } = importRustSchema({
      title: 'Presence',
      type: 'object',
      additionalProperties: false,
      required: ['nullable'],
      properties: {
        optional: { type: 'string' },
        nullable: { type: ['string', 'null'] },
        patch: { 'x-effect-rust-patch': true, anyOf: [{ type: 'null' }, { type: 'string' }] },
      },
    })
    expect(ir.defs.Presence).toEqual({
      kind: 'struct',
      excess: 'error',
      fields: [
        { wire: 'optional', presence: 'optional', type: { kind: 'string' } },
        {
          wire: 'nullable',
          presence: 'required',
          type: { kind: 'nullable', inner: { kind: 'string' } },
        },
        { wire: 'patch', presence: 'required', type: { kind: 'patch', inner: { kind: 'string' } } },
      ],
    })
  })

  it('keeps named nullable roots separate from their inner definitions', () => {
    const { ir } = importRustSchema({ title: 'MaybeLabel', type: ['string', 'null'], minLength: 2 })
    expect(ir.defs.MaybeLabel).toEqual({
      kind: 'alias',
      type: { kind: 'nullable', inner: { kind: 'ref', name: 'MaybeLabel_Value' } },
    })
    expect(ir.defs.MaybeLabel_Value).toEqual({ kind: 'string', minLength: 2 })
    expect(importRustSchema(emitJsonSchema(ir, ir.contract)).ir).toEqual(ir)
  })

  it('rejects a nullable Patch value that cannot be distinguished from the Null state', () => {
    expect(() =>
      importRustSchema({
        type: 'object',
        additionalProperties: false,
        properties: {
          patch: {
            'x-effect-rust-patch': true,
            anyOf: [{ type: 'null' }, { type: ['string', 'null'] }],
          },
        },
      }),
    ).toThrow(AdmissionError)
  })

  it.each([
    { schema: { type: 'integer' }, path: '$', remedy: /Wire\.U64\/I64/u },
    {
      schema: { type: 'integer', format: 'uint64' },
      path: '$/format',
      remedy: /canonical string/u,
    },
    {
      schema: { type: 'integer', minimum: 0, maximum: 9007199254740992 },
      path: '$',
      remedy: /Wire\.U64\/I64/u,
    },
    {
      schema: { type: 'string', format: 'custom-transform' },
      path: '$/format',
      remedy: /x-effect-rust-format/u,
    },
    {
      schema: { type: 'string', 'x-opaque-transform': 'trim' },
      path: '$/x-opaque-transform',
      remedy: /lossless lowering/u,
    },
    {
      schema: { type: 'string', title: 'Pattern', pattern: '^(?=a)a$' },
      path: '$/pattern',
      remedy: /portable.*grammar/u,
    },
    {
      schema: { $vocabulary: { 'https://unknown.example/v1': false }, type: 'string' },
      path: '$/$vocabulary/https:~1~1unknown.example~1v1',
      remedy: /effect-rust\.dev/u,
    },
    {
      schema: { type: 'array', items: { type: 'string' }, contains: { type: 'string' } },
      path: '$/contains',
      remedy: /lossless lowering/u,
    },
    {
      schema: { type: 'object', properties: {} },
      path: '$/additionalProperties',
      remedy: /deny_unknown_fields/u,
    },
  ])(
    'rejects lossy or unsupported contracts at $path with a remedy',
    ({ schema, path, remedy }) => {
      let caught: unknown
      try {
        importRustSchema(schema)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(AdmissionError)
      if (!(caught instanceof AdmissionError)) return
      expect(caught.path).toBe(path)
      expect(caught.remedy).toMatch(remedy)
    },
  )

  it('rejects unsupported constraints reached through a recursive definition', () => {
    expect(() =>
      importRustSchema({
        title: 'Tree',
        $ref: '#/$defs/Tree',
        $defs: {
          Tree: {
            type: 'object',
            additionalProperties: false,
            properties: {
              children: { type: 'array', items: { $ref: '#/$defs/Tree' }, maxItems: 3 },
            },
          },
        },
      }),
    ).toThrow(AdmissionError)
  })

  it('rejects unproductive alias recursion rather than emitting a self-referential type', () => {
    expect(() =>
      importRustSchema({
        title: 'Cycle',
        $ref: '#/$defs/Cycle',
        $defs: {
          Cycle: { $ref: '#/$defs/Other' },
          Other: { $ref: '#/$defs/Cycle' },
        },
      }),
    ).toThrow(AdmissionError)
  })

  it('requires distinct tags on every discriminated union variant', () => {
    const branch = (tag: string) => ({
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: tag } },
    })
    const { ir } = importRustSchema({
      title: 'Event',
      oneOf: [branch('Created'), branch('Removed')],
    })
    const event = ir.defs.Event
    expect(event?.kind).toBe('taggedUnion')
    if (event?.kind !== 'taggedUnion') return
    expect(event.tagField).toBe('kind')
    expect(event.variants.map((variant) => variant.tag)).toEqual(['Created', 'Removed'])
    expect(() =>
      importRustSchema({ title: 'Event', oneOf: [branch('Created'), branch('Created')] }),
    ).toThrow(AdmissionError)
    expect(importRustSchema(emitJsonSchema(ir, ir.contract)).ir).toEqual(ir)
    for (const variant of event.variants)
      expect(ir.defs[variant.ref]).toEqual({ kind: 'struct', fields: [], excess: 'error' })
  })
})
