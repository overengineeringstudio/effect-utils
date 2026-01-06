import { describe, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { expect } from 'vitest'

import {
  Checkbox,
  CheckboxWriteFromBoolean,
  DateProp,
  DateWriteFromStart,
  Email,
  EmailWriteFromString,
  Formula,
  MultiSelect,
  MultiSelectWriteFromNames,
  Num,
  NumberWriteFromNumber,
  PhoneNumber,
  PhoneNumberWriteFromString,
  Relation,
  RelationWriteFromIds,
  Required,
  RichTextProp,
  RichTextWriteFromString,
  Rollup,
  Select,
  SelectWriteFromName,
  Status,
  StatusWriteFromName,
  Title,
  TitleWrite,
  TitleWriteFromString,
  Url,
  UrlWriteFromString,
} from './mod.ts'

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

  describe('Title.asString', () => {
    it.effect('decodes title property to string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Title.asString)(sampleTitleProperty)
        expect(result).toBe('Hello World')
      }),
    )

    it.effect('handles empty title array', () =>
      Effect.gen(function* () {
        const emptyTitle = { ...sampleTitleProperty, title: [] }
        const result = yield* Schema.decodeUnknown(Title.asString)(emptyTitle)
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
        const result = yield* Schema.decodeUnknown(Title.asString)(multiSegment)
        expect(result).toBe('Hello World')
      }),
    )
  })

  describe('TitleWriteFromString', () => {
    it.effect('encodes string to title write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(TitleWriteFromString)('Test Title')
        expect(result).toEqual({
          title: [{ type: 'text', text: { content: 'Test Title' } }],
        })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'My Page Title'
        const encoded = yield* Schema.decodeUnknown(TitleWriteFromString)(original)
        const decoded = yield* Schema.encode(TitleWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )

    it.effect('handles empty string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(TitleWriteFromString)('')
        expect(result).toEqual({
          title: [{ type: 'text', text: { content: '' } }],
        })
      }),
    )
  })

  describe('TitleWrite schema', () => {
    it.effect('validates valid title write payload', () =>
      Effect.gen(function* () {
        const payload = {
          title: [{ type: 'text' as const, text: { content: 'Test' } }],
        }
        const result = yield* Schema.decodeUnknown(TitleWrite)(payload)
        expect(result).toEqual(payload)
      }),
    )

    it.effect('accepts title with link', () =>
      Effect.gen(function* () {
        const payload = {
          title: [
            {
              type: 'text' as const,
              text: { content: 'Click here', link: { url: 'https://example.com' } },
            },
          ],
        }
        const result = yield* Schema.decodeUnknown(TitleWrite)(payload)
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

  describe('RichTextProp.asString', () => {
    it.effect('decodes rich text property to string', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(RichTextProp.asString)(sampleRichTextProperty)
        expect(result).toBe('Sample text')
      }),
    )
  })

  describe('RichTextProp.asOption', () => {
    it.effect('returns Some for non-empty text', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(RichTextProp.asOption)(sampleRichTextProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('Sample text')
      }),
    )

    it.effect('returns None for empty text', () =>
      Effect.gen(function* () {
        const emptyProp = { ...sampleRichTextProperty, rich_text: [] }
        const result = yield* Schema.decodeUnknown(RichTextProp.asOption)(emptyProp)
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
        const result = yield* Schema.decodeUnknown(RichTextProp.asOption)(whitespaceProp)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('RichTextWriteFromString', () => {
    it.effect('encodes string to rich text write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(RichTextWriteFromString)('Test content')
        expect(result).toEqual({
          rich_text: [{ type: 'text', text: { content: 'Test content' } }],
        })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Some text content'
        const encoded = yield* Schema.decodeUnknown(RichTextWriteFromString)(original)
        const decoded = yield* Schema.encode(RichTextWriteFromString)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })

  describe('RichTextProp.asNonEmptyString', () => {
    it.effect('returns string for non-empty text', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(RichTextProp.asNonEmptyString)(
          sampleRichTextProperty,
        )
        expect(result).toBe('Sample text')
      }),
    )

    it.effect('fails for empty text', () =>
      Effect.gen(function* () {
        const emptyProp = { ...sampleRichTextProperty, rich_text: [] }
        const result = yield* Schema.decodeUnknown(RichTextProp.asNonEmptyString)(emptyProp).pipe(
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

  describe('Num.asNumber', () => {
    it.effect('decodes non-null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Num.asNumber)(sampleNumberProperty)
        expect(result).toBe(42)
      }),
    )

    it.effect('fails on null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Num.asNumber)(nullNumberProperty).pipe(
          Effect.flip,
        )
        expect(result).toBeDefined()
      }),
    )

    it.effect('decodes decimal numbers', () =>
      Effect.gen(function* () {
        const decimalProp = { ...sampleNumberProperty, number: 3.14 }
        const result = yield* Schema.decodeUnknown(Num.asNumber)(decimalProp)
        expect(result).toBe(3.14)
      }),
    )
  })

  describe('Num.asOption', () => {
    it.effect('returns Some for non-null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Num.asOption)(sampleNumberProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe(42)
      }),
    )

    it.effect('returns None for null number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Num.asOption)(nullNumberProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('NumberWriteFromNumber', () => {
    it.effect('encodes number to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NumberWriteFromNumber)(100)
        expect(result).toEqual({ number: 100 })
      }),
    )

    it.effect('encodes null to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(NumberWriteFromNumber)(null)
        expect(result).toEqual({ number: null })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 99
        const encoded = yield* Schema.decodeUnknown(NumberWriteFromNumber)(original)
        const decoded = yield* Schema.encode(NumberWriteFromNumber)(encoded)
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

  describe('Checkbox.asBoolean', () => {
    it.effect('decodes checked checkbox', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Checkbox.asBoolean)(checkedProperty)
        expect(result).toBe(true)
      }),
    )

    it.effect('decodes unchecked checkbox', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Checkbox.asBoolean)(uncheckedProperty)
        expect(result).toBe(false)
      }),
    )
  })

  describe('CheckboxWriteFromBoolean', () => {
    it.effect('encodes true to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(CheckboxWriteFromBoolean)(true)
        expect(result).toEqual({ checkbox: true })
      }),
    )

    it.effect('encodes false to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(CheckboxWriteFromBoolean)(false)
        expect(result).toEqual({ checkbox: false })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = true
        const encoded = yield* Schema.decodeUnknown(CheckboxWriteFromBoolean)(original)
        const decoded = yield* Schema.encode(CheckboxWriteFromBoolean)(encoded)
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

  describe('Select.asString', () => {
    it.effect('returns Some with option name', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Select.asString)(selectedProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('High')
      }),
    )

    it.effect('returns None for null select', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Select.asString)(nullSelectProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('Select.asName', () => {
    const Allowed = Schema.Literal('High', 'Low')

    it.effect('returns Some with allowed name', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Select.asName(Allowed))(selectedProperty)
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
        const result = yield* Schema.decodeUnknown(Select.asName(Allowed))(invalidProperty).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('Select.asOptionNamed', () => {
    const Allowed = Schema.Literal('High', 'Low')

    it.effect('returns Some with typed option', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Select.asOptionNamed(Allowed))(selectedProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)?.name).toBe('High')
      }),
    )

    it.effect('fails when option name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...selectedProperty,
          select: { ...selectedProperty.select, name: 'Medium' },
        }
        const result = yield* Schema.decodeUnknown(Select.asOptionNamed(Allowed))(
          invalidProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('Select.asPropertyNamed', () => {
    const Allowed = Schema.Literal('High', 'Low')

    it.effect('returns property with typed option', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Select.asPropertyNamed(Allowed))(
          selectedProperty,
        )
        expect(result.select?.name).toBe('High')
      }),
    )

    it.effect('fails when option name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...selectedProperty,
          select: { ...selectedProperty.select, name: 'Medium' },
        }
        const result = yield* Schema.decodeUnknown(Select.asPropertyNamed(Allowed))(
          invalidProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('SelectWriteFromName', () => {
    it.effect('encodes option name to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(SelectWriteFromName)('Medium')
        expect(result).toEqual({ select: { name: 'Medium' } })
      }),
    )

    it.effect('encodes null to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(SelectWriteFromName)(null)
        expect(result).toEqual({ select: null })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Low'
        const encoded = yield* Schema.decodeUnknown(SelectWriteFromName)(original)
        const decoded = yield* Schema.encode(SelectWriteFromName)(encoded)
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

  describe('MultiSelect.asStrings', () => {
    it.effect('decodes to array of names', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(MultiSelect.asStrings)(multiSelectProperty)
        expect(result).toEqual(['Tag1', 'Tag2'])
      }),
    )

    it.effect('handles empty array', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(MultiSelect.asStrings)(emptyMultiSelectProperty)
        expect(result).toEqual([])
      }),
    )
  })

  describe('MultiSelect.asNames', () => {
    const Allowed = Schema.Literal('Tag1', 'Tag2')

    it.effect('decodes to array of allowed names', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(MultiSelect.asNames(Allowed))(
          multiSelectProperty,
        )
        expect(result).toEqual(['Tag1', 'Tag2'])
      }),
    )

    it.effect('fails when option name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...multiSelectProperty,
          multi_select: [{ ...multiSelectProperty.multi_select[0], name: 'Tag3' }],
        }
        const result = yield* Schema.decodeUnknown(MultiSelect.asNames(Allowed))(
          invalidProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('MultiSelect.asPropertyNamed', () => {
    const Allowed = Schema.Literal('Tag1', 'Tag2')

    it.effect('returns property with typed options', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(MultiSelect.asPropertyNamed(Allowed))(
          multiSelectProperty,
        )
        expect(result.multi_select).toHaveLength(2)
        expect(result.multi_select[0]?.name).toBe('Tag1')
      }),
    )

    it.effect('fails when option name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...multiSelectProperty,
          multi_select: [{ ...multiSelectProperty.multi_select[0], name: 'Tag3' }],
        }
        const result = yield* Schema.decodeUnknown(MultiSelect.asPropertyNamed(Allowed))(
          invalidProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('MultiSelectWriteFromNames', () => {
    it.effect('encodes names to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(MultiSelectWriteFromNames)(['A', 'B', 'C'])
        expect(result).toEqual({
          multi_select: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        })
      }),
    )

    it.effect('handles empty array', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(MultiSelectWriteFromNames)([])
        expect(result).toEqual({ multi_select: [] })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = ['X', 'Y', 'Z']
        const encoded = yield* Schema.decodeUnknown(MultiSelectWriteFromNames)(original)
        const decoded = yield* Schema.encode(MultiSelectWriteFromNames)(encoded)
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

  describe('Status.asString', () => {
    it.effect('returns Some with status name', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Status.asString)(statusProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('In Progress')
      }),
    )

    it.effect('returns None for null status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Status.asString)(nullStatusProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('Status.asName', () => {
    const Allowed = Schema.Literal('In Progress', 'Blocked')

    it.effect('returns Some with allowed status name', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Status.asName(Allowed))(statusProperty)
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
        const result = yield* Schema.decodeUnknown(Status.asName(Allowed))(invalidProperty).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('Status.asOption', () => {
    it.effect('returns Some with status option', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Status.asOption)(statusProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)?.name).toBe('In Progress')
      }),
    )

    it.effect('returns None for null status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Status.asOption)(nullStatusProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('Status.asPropertyNamed', () => {
    const Allowed = Schema.Literal('In Progress', 'Blocked')

    it.effect('returns property with typed status', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Status.asPropertyNamed(Allowed))(statusProperty)
        expect(result.status?.name).toBe('In Progress')
      }),
    )

    it.effect('fails when status name is not allowed', () =>
      Effect.gen(function* () {
        const invalidProperty = {
          ...statusProperty,
          status: { ...statusProperty.status, name: 'Done' },
        }
        const result = yield* Schema.decodeUnknown(Status.asPropertyNamed(Allowed))(
          invalidProperty,
        ).pipe(Effect.either)
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('StatusWriteFromName', () => {
    it.effect('encodes status name to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(StatusWriteFromName)('Done')
        expect(result).toEqual({ status: { name: 'Done' } })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'Blocked'
        const encoded = yield* Schema.decodeUnknown(StatusWriteFromName)(original)
        const decoded = yield* Schema.encode(StatusWriteFromName)(encoded)
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

  describe('Formula.asNumber', () => {
    it.effect('decodes number formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Formula.asNumber)(numberFormulaProperty)
        expect(result).toBe(42)
      }),
    )

    it.effect('fails for non-number formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Formula.asNumber)(stringFormulaProperty).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('Formula.asString', () => {
    it.effect('decodes string formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Formula.asString)(stringFormulaProperty)
        expect(result).toBe('hello')
      }),
    )

    it.effect('fails for non-string formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Formula.asString)(numberFormulaProperty).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('Formula.asBoolean', () => {
    it.effect('decodes boolean formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Formula.asBoolean)(booleanFormulaProperty)
        expect(result).toBe(true)
      }),
    )
  })

  describe('Formula.asDate', () => {
    it.effect('decodes date formula', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Formula.asDate)(dateFormulaProperty)
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

  describe('Rollup.asNumber', () => {
    it.effect('decodes number rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Rollup.asNumber)(numberRollupProperty)
        expect(result).toBe(7)
      }),
    )

    it.effect('fails for non-number rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Rollup.asNumber)(stringRollupProperty).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('Rollup.asString', () => {
    it.effect('decodes string rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Rollup.asString)(stringRollupProperty)
        expect(result).toBe('hello')
      }),
    )
  })

  describe('Rollup.asBoolean', () => {
    it.effect('decodes boolean rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Rollup.asBoolean)(booleanRollupProperty)
        expect(result).toBe(true)
      }),
    )
  })

  describe('Rollup.asDate', () => {
    it.effect('decodes date rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Rollup.asDate)(dateRollupProperty)
        expect(result.start).toBe('2024-01-15')
      }),
    )
  })

  describe('Rollup.asArray', () => {
    it.effect('decodes array rollup', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Rollup.asArray)(arrayRollupProperty)
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

  describe('DateProp.asOption', () => {
    it.effect('returns Some with date value', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(DateProp.asOption)(dateProperty)
        expect(Option.isSome(result)).toBe(true)
        const value = Option.getOrNull(result)
        expect(value?.start).toBe('2024-01-15')
      }),
    )

    it.effect('returns None for null date', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(DateProp.asOption)(nullDateProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('Required.some', () => {
    const schema = DateProp.asOption.pipe(Required.some('Date is required'))

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

  describe('DateProp.asDate', () => {
    it.effect('parses start date to Date object', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(DateProp.asDate)(dateProperty)
        expect(Option.isSome(result)).toBe(true)
        const date = Option.getOrNull(result)
        expect(date).toBeInstanceOf(Date)
        expect(date?.toISOString()).toContain('2024-01-15')
      }),
    )

    it.effect('returns None for null date', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(DateProp.asDate)(nullDateProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('DateWriteFromStart', () => {
    it.effect('encodes date string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(DateWriteFromStart)('2024-06-01')
        expect(result).toEqual({ date: { start: '2024-06-01' } })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = '2024-12-25'
        const encoded = yield* Schema.decodeUnknown(DateWriteFromStart)(original)
        const decoded = yield* Schema.encode(DateWriteFromStart)(encoded)
        expect(decoded).toBe(original)
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Required Helpers
// ---------------------------------------------------------------------------

describe('Required.nullable', () => {
  const schema = Schema.NullOr(Schema.String).pipe(
    Required.nullable(Schema.String, 'String is required'),
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

  describe('Url.asOption', () => {
    it.effect('returns Some with URL', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Url.asOption)(urlProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('https://example.com')
      }),
    )

    it.effect('returns None for null URL', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Url.asOption)(nullUrlProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('UrlWriteFromString', () => {
    it.effect('encodes URL string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(UrlWriteFromString)('https://notion.so')
        expect(result).toEqual({ url: 'https://notion.so' })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'https://github.com'
        const encoded = yield* Schema.decodeUnknown(UrlWriteFromString)(original)
        const decoded = yield* Schema.encode(UrlWriteFromString)(encoded)
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

  describe('Email.asOption', () => {
    it.effect('returns Some with email', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Email.asOption)(emailProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('user@example.com')
      }),
    )

    it.effect('returns None for null email', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Email.asOption)(nullEmailProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('EmailWriteFromString', () => {
    it.effect('encodes email string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(EmailWriteFromString)('test@test.com')
        expect(result).toEqual({ email: 'test@test.com' })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = 'alice@wonderland.com'
        const encoded = yield* Schema.decodeUnknown(EmailWriteFromString)(original)
        const decoded = yield* Schema.encode(EmailWriteFromString)(encoded)
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

  describe('PhoneNumber.asOption', () => {
    it.effect('returns Some with phone number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(PhoneNumber.asOption)(phoneProperty)
        expect(Option.isSome(result)).toBe(true)
        expect(Option.getOrNull(result)).toBe('+1-555-123-4567')
      }),
    )

    it.effect('returns None for null phone number', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(PhoneNumber.asOption)(nullPhoneProperty)
        expect(Option.isNone(result)).toBe(true)
      }),
    )
  })

  describe('PhoneNumberWriteFromString', () => {
    it.effect('encodes phone string to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(PhoneNumberWriteFromString)('+44-20-1234-5678')
        expect(result).toEqual({ phone_number: '+44-20-1234-5678' })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = '+1-800-CALL-NOW'
        const encoded = yield* Schema.decodeUnknown(PhoneNumberWriteFromString)(original)
        const decoded = yield* Schema.encode(PhoneNumberWriteFromString)(encoded)
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

  describe('Relation.asIds', () => {
    it.effect('extracts page IDs', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Relation.asIds)(relationProperty)
        expect(result).toEqual(['page-1', 'page-2'])
      }),
    )
  })

  describe('Relation.asSingle', () => {
    it.effect('extracts single relation object', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Relation.asSingle)(singleRelationProperty)
        expect(result).toEqual({ id: 'page-1' })
      }),
    )

    it.effect('fails for multiple relations', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Relation.asSingle)(relationProperty).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('Relation.asSingleId', () => {
    it.effect('extracts single relation ID', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Relation.asSingleId)(singleRelationProperty)
        expect(result).toBe('page-1')
      }),
    )

    it.effect('fails for multiple relations', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(Relation.asSingleId)(relationProperty).pipe(
          Effect.either,
        )
        expect(result._tag).toBe('Left')
      }),
    )
  })

  describe('RelationWriteFromIds', () => {
    it.effect('encodes page IDs to write payload', () =>
      Effect.gen(function* () {
        const result = yield* Schema.decodeUnknown(RelationWriteFromIds)(['rel-1', 'rel-2'])
        expect(result).toEqual({
          relation: [{ id: 'rel-1' }, { id: 'rel-2' }],
        })
      }),
    )

    it.effect('roundtrip: encode and decode', () =>
      Effect.gen(function* () {
        const original = ['xyz-789', 'uvw-101']
        const encoded = yield* Schema.decodeUnknown(RelationWriteFromIds)(original)
        const decoded = yield* Schema.encode(RelationWriteFromIds)(encoded)
        expect(decoded).toEqual(original)
      }),
    )
  })
})
