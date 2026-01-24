import { describe, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { NotionSchema } from './mod.ts'

// -----------------------------------------------------------------------------
// Title Property Tests
// -----------------------------------------------------------------------------

describe('Title', () => {
  const sampleTitleProperty = {
    id: 'title',
    type: 'title' as const,
    title: [
      {
        type: 'text' as const,
        text: { content: 'Hello World', link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default' as const,
        },
        plain_text: 'Hello World',
        href: null,
      },
    ],
  }

  describe('NotionSchema.title', () => {
    it.effect('decodes title property to string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.title)(sampleTitleProperty)
        expect(result).toBe('Hello World')
      }),
    )

    it.effect('handles empty title array', () =>
      Effect.gen(function* () {
        const emptyTitle = { ...sampleTitleProperty, title: [] }
        const result = yield* Schema.decodeUnknown(NotionSchema.title)(emptyTitle)
        expect(result).toBe('')
      }),
    )

    it.effect('concatenates multiple rich text segments', () =>
      Effect.gen(function* () {
        const multiSegment = {
          ...sampleTitleProperty,
          title: [
            {
              type: 'text' as const,
              text: { content: 'Hello ', link: null },
              annotations: {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: 'default' as const,
              },
              plain_text: 'Hello ',
              href: null,
            },
            {
              type: 'text' as const,
              text: { content: 'World', link: null },
              annotations: {
                bold: true,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: 'default' as const,
              },
              plain_text: 'World',
              href: null,
            },
          ],
        }
        const result = yield* Schema.decodeUnknown(NotionSchema.title)(multiSegment)
        expect(result).toBe('Hello World')
      }),
    )
  })

  describe('NotionSchema.titleWriteFromString', () => {
    it.effect('encodes string to title write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.titleWriteFromString)('Test Title')
        expect(result).toEqual({
          title: [{ type: 'text', text: { content: 'Test Title' } }],
        })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'My Page Title'
        const encoded = yield* Schema.decodeUnknown(NotionSchema.titleWriteFromString)(original)
        const decoded = yield* Schema.encode(NotionSchema.titleWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )

    it.effect('handles empty string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.titleWriteFromString)('')
        expect(result).toEqual({
          title: [{ type: 'text', text: { content: '' } }],
        })
      }),
    )
  })

  describe('NotionSchema.titleWrite schema', () => {
    it.effect('validates valid title write payload', () =>
      Effect.gen(function* () {
        const payload = {
          title: [{ type: 'text' as const, text: { content: 'Test' } }],
        }
        const result = yield* Schema.decodeUnknown(NotionSchema.titleWrite)(payload)
        expect(result).toEqual(payload)
      }),
    )

    it.effect('accepts title with link', () =>
      Effect.gen(function* () {
        const payload = {
          title: [
            {
              type: 'text' as const,
              text: {
                content: 'Click here',
                link: { url: 'https://example.com' },
              },
            },
          ],
        }
        const result = yield* Schema.decodeUnknown(NotionSchema.titleWrite)(payload)
        expect(result).toEqual(payload)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Rich Text Property Tests
// -----------------------------------------------------------------------------

describe('RichText Property', () => {
  const sampleRichTextProperty = {
    id: 'rich_text',
    type: 'rich_text' as const,
    rich_text: [
      {
        type: 'text' as const,
        text: { content: 'Sample text', link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default' as const,
        },
        plain_text: 'Sample text',
        href: null,
      },
    ],
  }

  describe('NotionSchema.richTextString', () => {
    it.effect('decodes rich text property to string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.richTextString)(
          sampleRichTextProperty,
        )
        expect(result).toBe('Sample text')
      }),
    )
  })

  describe('NotionSchema.richTextOption', () => {
    it.effect('returns Some for non-empty text', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.richTextOption)(
          sampleRichTextProperty,
        )
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('Sample text')
      }),
    )

    it.effect('returns None for empty text', () =>
      Effect.gen(function* () {
        const emptyProp = { ...sampleRichTextProperty, rich_text: [] }
        const result = yield* Schema.decodeUnknown(NotionSchema.richTextOption)(emptyProp)
        expect(Option.isNone(result)).toBe(true)
      }),
    )

    it.effect('returns None for whitespace-only text', () =>
      Effect.gen(function* () {
        const whitespaceProp = {
          ...sampleRichTextProperty,
          rich_text: [
            {
              type: 'text' as const,
              text: { content: '   ', link: null },
              annotations: {
                bold: false,
                italic: false,
                strikethrough: false,
                underline: false,
                code: false,
                color: 'default' as const,
              },
              plain_text: '   ',
              href: null,
            },
          ],
        }
        const result = yield* Schema.decodeUnknown(NotionSchema.richTextOption)(whitespaceProp)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.richTextWriteFromString', () => {
    it.effect('encodes string to rich text write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.richTextWriteFromString)(
          'Test content',
        )
        expect(result).toEqual({
          rich_text: [{ type: 'text', text: { content: 'Test content' } }],
        })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Some text content'
        const encoded = yield* Schema.decodeUnknown(NotionSchema.richTextWriteFromString)(original)
        const decoded = yield* Schema.encode(NotionSchema.richTextWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })

  describe('NotionSchema.richTextNonEmpty', () => {
    it.effect('returns string for non-empty text', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.richTextNonEmpty)(
          sampleRichTextProperty,
        )
        expect(result).toBe('Sample text')
      }),
    )

    it.effect('fails for empty text', () =>
      Effect.gen(function* () {
        const emptyProp = { ...sampleRichTextProperty, rich_text: [] }
        const result = yield* Schema.decodeUnknown(NotionSchema.richTextNonEmpty)(emptyProp).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Number Property Tests
// -----------------------------------------------------------------------------

describe('Number Property', () => {
  const sampleNumberProperty = {
    id: 'number',
    type: 'number' as const,
    number: 42,
  }

  const nullNumberProperty = {
    id: 'number',
    type: 'number' as const,
    number: null,
  }

  describe('NotionSchema.number', () => {
    it.effect('decodes non-null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.number)(sampleNumberProperty)
        expect(result).toBe(42)
      }),
    )

    it.effect('fails on null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.number)(nullNumberProperty).pipe(
          Effect.flip,
        )
        expect(result).toBeDefined()
      }),
    )

    it.effect('decodes decimal numbers', () =>
      Effect.gen(function* () {
        const decimalProp = { ...sampleNumberProperty, number: 3.14 }
        const result = yield* Schema.decodeUnknown(NotionSchema.number)(decimalProp)
        expect(result).toBe(3.14)
      }),
    )
  })

  describe('NotionSchema.numberOption', () => {
    it.effect('returns Some for non-null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.numberOption)(sampleNumberProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe(42)
      }),
    )

    it.effect('returns None for null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.numberOption)(nullNumberProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.numberWriteFromNumber', () => {
    it.effect('encodes number to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.numberWriteFromNumber)(100)
        expect(result).toEqual({ number: 100 })
      }),
    )

    it.effect('encodes null to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.numberWriteFromNumber)(null)
        expect(result).toEqual({ number: null })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 99
        const encoded = yield* Schema.decodeUnknown(NotionSchema.numberWriteFromNumber)(original)
        const decoded = yield* Schema.encode(NotionSchema.numberWriteFromNumber)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Checkbox Property Tests
// -----------------------------------------------------------------------------

describe('Checkbox Property', () => {
  const checkedProperty = {
    id: 'checkbox',
    type: 'checkbox' as const,
    checkbox: true,
  }

  const uncheckedProperty = {
    id: 'checkbox',
    type: 'checkbox' as const,
    checkbox: false,
  }

  describe('NotionSchema.checkbox', () => {
    it.effect('decodes checked checkbox', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.checkbox)(checkedProperty)
        expect(result).toBe(true)
      }),
    )

    it.effect('decodes unchecked checkbox', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.checkbox)(uncheckedProperty)
        expect(result).toBe(false)
      }),
    )
  })

  describe('NotionSchema.checkboxWriteFromBoolean', () => {
    it.effect('encodes true to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.checkboxWriteFromBoolean)(true)
        expect(result).toEqual({ checkbox: true })
      }),
    )

    it.effect('encodes false to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.checkboxWriteFromBoolean)(false)
        expect(result).toEqual({ checkbox: false })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = true
        const encoded = yield* Schema.decodeUnknown(NotionSchema.checkboxWriteFromBoolean)(original)
        const decoded = yield* Schema.encode(NotionSchema.checkboxWriteFromBoolean)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Select Property Tests
// -----------------------------------------------------------------------------

describe('Select Property', () => {
  const selectedProperty = {
    id: 'select',
    type: 'select' as const,
    select: {
      id: 'opt-123',
      name: 'High',
      color: 'red' as const,
    },
  }

  const nullSelectProperty = {
    id: 'select',
    type: 'select' as const,
    select: null,
  }

  describe('NotionSchema.select', () => {
    it.effect('returns Some with option', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.select())(selectedProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)?.name).toBe('High')
      }),
    )

    it.effect('returns None for null select', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.select())(nullSelectProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.select(...).pipe(NotionSchema.asName)', () => {
    const Allowed = Schema.Literal('High', 'Low')

    it.effect('returns Some with allowed name', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(
          NotionSchema.select(Allowed).pipe(NotionSchema.asName),
        )(selectedProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('High')
      }),
    )

    it.effect('fails when option name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...selectedProperty,
          select: { ...selectedProperty.select, name: 'Medium' },
        }
        const result = yield* Schema.decodeUnknown(
          NotionSchema.select(Allowed).pipe(NotionSchema.asName),
        )(invalidProperty).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.select(...).pipe(NotionSchema.asNullable)', () => {
    it.effect('returns option for selected property', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(
          NotionSchema.select().pipe(NotionSchema.asNullable),
        )(selectedProperty)
        expect(result?.name).toBe('High')
      }),
    )

    it.effect('returns null for null select', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(
          NotionSchema.select().pipe(NotionSchema.asNullable),
        )(nullSelectProperty)
        expect(result).toBeNull()
      }),
    )
  })

  describe('NotionSchema.selectWriteFromName', () => {
    it.effect('encodes option name to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.selectWriteFromName)('Medium')
        expect(result).toEqual({ select: { name: 'Medium' } })
      }),
    )

    it.effect('encodes null to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.selectWriteFromName)(null)
        expect(result).toEqual({ select: null })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Low'
        const encoded = yield* Schema.decodeUnknown(NotionSchema.selectWriteFromName)(original)
        const decoded = yield* Schema.encode(NotionSchema.selectWriteFromName)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Multi-Select Property Tests
// -----------------------------------------------------------------------------

describe('MultiSelect Property', () => {
  const multiSelectProperty = {
    id: 'multi_select',
    type: 'multi_select' as const,
    multi_select: [
      { id: 'opt-1', name: 'Tag1', color: 'blue' as const },
      { id: 'opt-2', name: 'Tag2', color: 'green' as const },
    ],
  }

  const emptyMultiSelectProperty = {
    id: 'multi_select',
    type: 'multi_select' as const,
    multi_select: [],
  }

  describe('NotionSchema.multiSelect', () => {
    it.effect('decodes to array of options', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.multiSelect())(multiSelectProperty)
        expect(result).toHaveLength(2)
        expect(result[0]?.name).toBe('Tag1')
      }),
    )

    it.effect('handles empty array', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.multiSelect())(
          emptyMultiSelectProperty,
        )
        expect(result).toEqual([])
      }),
    )
  })

  describe('NotionSchema.multiSelect(...).pipe(NotionSchema.asNames)', () => {
    const Allowed = Schema.Literal('Tag1', 'Tag2')

    it.effect('decodes to array of allowed names', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(
          NotionSchema.multiSelect(Allowed).pipe(NotionSchema.asNames),
        )(multiSelectProperty)
        expect(result).toEqual(['Tag1', 'Tag2'])
      }),
    )

    it.effect('fails when option name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...multiSelectProperty,
          multi_select: [{ ...multiSelectProperty.multi_select[0], name: 'Tag3' }],
        }
        const result = yield* Schema.decodeUnknown(
          NotionSchema.multiSelect(Allowed).pipe(NotionSchema.asNames),
        )(invalidProperty).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.multiSelectWriteFromNames', () => {
    it.effect('encodes names to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.multiSelectWriteFromNames)([
          'A',
          'B',
          'C',
        ])
        expect(result).toEqual({
          multi_select: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        })
      }),
    )

    it.effect('handles empty array', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.multiSelectWriteFromNames)([])
        expect(result).toEqual({ multi_select: [] })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = ['X', 'Y', 'Z']
        const encoded = yield* Schema.decodeUnknown(NotionSchema.multiSelectWriteFromNames)(
          original,
        )
        const decoded = yield* Schema.encode(NotionSchema.multiSelectWriteFromNames)(encoded)
        expect(decoded).toEqual(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Status Property Tests
// -----------------------------------------------------------------------------

describe('Status Property', () => {
  const statusProperty = {
    id: 'status',
    type: 'status' as const,
    status: {
      id: 'stat-123',
      name: 'In Progress',
      color: 'yellow' as const,
    },
  }

  const nullStatusProperty = {
    id: 'status',
    type: 'status' as const,
    status: null,
  }

  describe('NotionSchema.status', () => {
    it.effect('returns Some with status option', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.status())(statusProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)?.name).toBe('In Progress')
      }),
    )

    it.effect('returns None for null status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.status())(nullStatusProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.status(...).pipe(NotionSchema.asName)', () => {
    const Allowed = Schema.Literal('In Progress', 'Blocked')

    it.effect('returns Some with allowed status name', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(
          NotionSchema.status(Allowed).pipe(NotionSchema.asName),
        )(statusProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('In Progress')
      }),
    )

    it.effect('fails when status name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...statusProperty,
          status: { ...statusProperty.status, name: 'Done' },
        }
        const result = yield* Schema.decodeUnknown(
          NotionSchema.status(Allowed).pipe(NotionSchema.asName),
        )(invalidProperty).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.status(...).pipe(NotionSchema.asNullable)', () => {
    it.effect('returns status option for selected status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(
          NotionSchema.status().pipe(NotionSchema.asNullable),
        )(statusProperty)
        expect(result?.name).toBe('In Progress')
      }),
    )

    it.effect('returns null for null status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(
          NotionSchema.status().pipe(NotionSchema.asNullable),
        )(nullStatusProperty)
        expect(result).toBeNull()
      }),
    )
  })

  describe('NotionSchema.statusWriteFromName', () => {
    it.effect('encodes status name to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.statusWriteFromName)('Done')
        expect(result).toEqual({ status: { name: 'Done' } })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Blocked'
        const encoded = yield* Schema.decodeUnknown(NotionSchema.statusWriteFromName)(original)
        const decoded = yield* Schema.encode(NotionSchema.statusWriteFromName)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Formula Property Tests
// -----------------------------------------------------------------------------

describe('Formula Property', () => {
  const numberFormulaProperty = {
    id: 'formula',
    type: 'formula' as const,
    formula: {
      type: 'number' as const,
      number: 42,
    },
  }

  const stringFormulaProperty = {
    id: 'formula',
    type: 'formula' as const,
    formula: {
      type: 'string' as const,
      string: 'hello',
    },
  }

  const booleanFormulaProperty = {
    id: 'formula',
    type: 'formula' as const,
    formula: {
      type: 'boolean' as const,
      boolean: true,
    },
  }

  const dateFormulaProperty = {
    id: 'formula',
    type: 'formula' as const,
    formula: {
      type: 'date' as const,
      date: {
        start: '2024-01-15',
        end: null,
        time_zone: null,
      },
    },
  }

  describe('NotionSchema.formulaNumber', () => {
    it.effect('decodes number formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.formulaNumber)(
          numberFormulaProperty,
        )
        expect(result).toBe(42)
      }),
    )

    it.effect('fails for non-number formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.formulaNumber)(
          stringFormulaProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.formulaString', () => {
    it.effect('decodes string formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.formulaString)(
          stringFormulaProperty,
        )
        expect(result).toBe('hello')
      }),
    )

    it.effect('fails for non-string formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.formulaString)(
          numberFormulaProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.formulaBoolean', () => {
    it.effect('decodes boolean formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.formulaBoolean)(
          booleanFormulaProperty,
        )
        expect(result).toBe(true)
      }),
    )
  })

  describe('NotionSchema.formulaDate', () => {
    it.effect('decodes date formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.formulaDate)(dateFormulaProperty)
        expect(result.start).toBe('2024-01-15')
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Rollup Property Tests
// -----------------------------------------------------------------------------

describe('Rollup Property', () => {
  const numberRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'number' as const,
      number: 7,
    },
  }

  const stringRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'string' as const,
      string: 'hello',
    },
  }

  const booleanRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'boolean' as const,
      boolean: true,
    },
  }

  const dateRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'date' as const,
      date: {
        start: '2024-01-15',
        end: null,
        time_zone: null,
      },
    },
  }

  const arrayRollupProperty = {
    id: 'rollup',
    type: 'rollup' as const,
    rollup: {
      type: 'array' as const,
      array: ['a', 'b'],
    },
  }

  describe('NotionSchema.rollupNumber', () => {
    it.effect('decodes number rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.rollupNumber)(numberRollupProperty)
        expect(result).toBe(7)
      }),
    )

    it.effect('fails for non-number rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.rollupNumber)(
          stringRollupProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.rollupString', () => {
    it.effect('decodes string rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.rollupString)(stringRollupProperty)
        expect(result).toBe('hello')
      }),
    )
  })

  describe('NotionSchema.rollupBoolean', () => {
    it.effect('decodes boolean rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.rollupBoolean)(
          booleanRollupProperty,
        )
        expect(result).toBe(true)
      }),
    )
  })

  describe('NotionSchema.rollupDate', () => {
    it.effect('decodes date rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.rollupDate)(dateRollupProperty)
        expect(result.start).toBe('2024-01-15')
      }),
    )
  })

  describe('NotionSchema.rollupArray', () => {
    it.effect('decodes array rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.rollupArray)(arrayRollupProperty)
        expect(result).toEqual(['a', 'b'])
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Date Property Tests
// -----------------------------------------------------------------------------

describe('Date Property', () => {
  const dateProperty = {
    id: 'date',
    type: 'date' as const,
    date: {
      start: '2024-01-15',
      end: null,
      time_zone: null,
    },
  }

  const nullDateProperty = {
    id: 'date',
    type: 'date' as const,
    date: null,
  }

  describe('NotionSchema.dateOption', () => {
    it.effect('returns Some with date value', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.dateOption)(dateProperty)
        expect(Option.isSome(result)).toBe(true)
        const value = Option.getOrNull(result)
        expect(value?.start).toBe('2024-01-15')
      }),
    )

    it.effect('returns None for null date', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.dateOption)(nullDateProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.requiredMessage', () => {
    const schema = NotionSchema.dateOption.pipe(NotionSchema.requiredMessage('Date is required'))

    it.effect('returns date value', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(schema)(dateProperty)
        expect(result.start).toBe('2024-01-15')
      }),
    )

    it.effect('fails for null date', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(schema)(nullDateProperty).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.dateDate', () => {
    it.effect('parses start date to Date object', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.dateDate)(dateProperty)
        expect(Option.isSome(result)).toBe(true)
        const date = Option.getOrNull(result)
        expect(date).toBeInstanceOf(Date)
        expect(date?.toISOString()).toContain('2024-01-15')
      }),
    )

    it.effect('returns None for null date', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.dateDate)(nullDateProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.dateWriteFromStart', () => {
    it.effect('encodes date string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.dateWriteFromStart)('2024-06-01')
        expect(result).toEqual({ date: { start: '2024-06-01' } })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = '2024-12-25'
        const encoded = yield* Schema.decodeUnknown(NotionSchema.dateWriteFromStart)(original)
        const decoded = yield* Schema.encode(NotionSchema.dateWriteFromStart)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Required Helpers
// ---------------------------------------------------------------------------

describe('NotionSchema.nullable', () => {
  const schema = Schema.NullOr(Schema.String).pipe(
    NotionSchema.nullable({
      valueSchema: Schema.String,
      message: 'String is required',
    }),
  )

  it.effect('returns value when present', () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknown(schema)('hello')
      expect(result).toBe('hello')
    }),
  )

  it.effect('fails for null', () =>
    Effect.gen(function* () {
      const result = yield* Schema.decodeUnknown(schema)(null).pipe(Effect.either)
      expect(result._tag).toBe('Left')
    }),
  )
})

// -----------------------------------------------------------------------------
// URL Property Tests
// -----------------------------------------------------------------------------

describe('URL Property', () => {
  const urlProperty = {
    id: 'url',
    type: 'url' as const,
    url: 'https://example.com',
  }

  const nullUrlProperty = {
    id: 'url',
    type: 'url' as const,
    url: null,
  }

  describe('NotionSchema.urlOption', () => {
    it.effect('returns Some with URL', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.urlOption)(urlProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('https://example.com')
      }),
    )

    it.effect('returns None for null URL', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.urlOption)(nullUrlProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.urlWriteFromString', () => {
    it.effect('encodes URL string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.urlWriteFromString)(
          'https://notion.so',
        )
        expect(result).toEqual({ url: 'https://notion.so' })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'https://github.com'
        const encoded = yield* Schema.decodeUnknown(NotionSchema.urlWriteFromString)(original)
        const decoded = yield* Schema.encode(NotionSchema.urlWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Email Property Tests
// -----------------------------------------------------------------------------

describe('Email Property', () => {
  const emailProperty = {
    id: 'email',
    type: 'email' as const,
    email: 'user@example.com',
  }

  const nullEmailProperty = {
    id: 'email',
    type: 'email' as const,
    email: null,
  }

  describe('NotionSchema.emailOption', () => {
    it.effect('returns Some with email', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.emailOption)(emailProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('user@example.com')
      }),
    )

    it.effect('returns None for null email', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.emailOption)(nullEmailProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.emailWriteFromString', () => {
    it.effect('encodes email string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.emailWriteFromString)(
          'test@test.com',
        )
        expect(result).toEqual({ email: 'test@test.com' })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'alice@wonderland.com'
        const encoded = yield* Schema.decodeUnknown(NotionSchema.emailWriteFromString)(original)
        const decoded = yield* Schema.encode(NotionSchema.emailWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Phone Number Property Tests
// -----------------------------------------------------------------------------

describe('PhoneNumber Property', () => {
  const phoneProperty = {
    id: 'phone_number',
    type: 'phone_number' as const,
    phone_number: '+1-555-123-4567',
  }

  const nullPhoneProperty = {
    id: 'phone_number',
    type: 'phone_number' as const,
    phone_number: null,
  }

  describe('NotionSchema.phoneNumberOption', () => {
    it.effect('returns Some with phone number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.phoneNumberOption)(phoneProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('+1-555-123-4567')
      }),
    )

    it.effect('returns None for null phone number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.phoneNumberOption)(
          nullPhoneProperty,
        )
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NotionSchema.phoneNumberWriteFromString', () => {
    it.effect('encodes phone string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.phoneNumberWriteFromString)(
          '+44-20-1234-5678',
        )
        expect(result).toEqual({ phone_number: '+44-20-1234-5678' })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = '+1-800-CALL-NOW'
        const encoded = yield* Schema.decodeUnknown(NotionSchema.phoneNumberWriteFromString)(
          original,
        )
        const decoded = yield* Schema.encode(NotionSchema.phoneNumberWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// -----------------------------------------------------------------------------
// Relation Property Tests
// -----------------------------------------------------------------------------

describe('Relation Property', () => {
  const relationProperty = {
    id: 'relation',
    type: 'relation' as const,
    relation: [{ id: 'page-1' }, { id: 'page-2' }],
  }

  const singleRelationProperty = {
    id: 'relation',
    type: 'relation' as const,
    relation: [{ id: 'page-1' }],
  }

  describe('NotionSchema.relationIds', () => {
    it.effect('extracts page IDs', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.relationIds)(relationProperty)
        expect(result).toEqual(['page-1', 'page-2'])
      }),
    )
  })

  describe('NotionSchema.relationSingle', () => {
    it.effect('extracts single relation object', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.relationSingle)(
          singleRelationProperty,
        )
        expect(result).toEqual({ id: 'page-1' })
      }),
    )

    it.effect('fails for multiple relations', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.relationSingle)(
          relationProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.relationSingleId', () => {
    it.effect('extracts single relation ID', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.relationSingleId)(
          singleRelationProperty,
        )
        expect(result).toBe('page-1')
      }),
    )

    it.effect('fails for multiple relations', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.relationSingleId)(
          relationProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('NotionSchema.relationWriteFromIds', () => {
    it.effect('encodes page IDs to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NotionSchema.relationWriteFromIds)([
          'rel-1',
          'rel-2',
        ])
        expect(result).toEqual({
          relation: [{ id: 'rel-1' }, { id: 'rel-2' }],
        })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = ['xyz-789', 'uvw-101']
        const encoded = yield* Schema.decodeUnknown(NotionSchema.relationWriteFromIds)(original)
        const decoded = yield* Schema.encode(NotionSchema.relationWriteFromIds)(encoded)
        expect(decoded).toEqual(original)
      }),
    )
  })
})
