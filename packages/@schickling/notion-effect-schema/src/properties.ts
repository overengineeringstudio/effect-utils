import { Option, Schema } from 'effect'
import { docsPath, NotionUUID, SelectColor, shouldNeverHappen } from './common.ts'
import { RichText, RichTextArray, TextLink } from './rich-text.ts'
import { PartialUser, User } from './users.ts'

// -----------------------------------------------------------------------------
// Select Option
// -----------------------------------------------------------------------------

/**
 * A select or multi-select option.
 *
 * @see https://developers.notion.com/reference/property-value-object#select
 */
export const SelectOption = Schema.Struct({
  id: NotionUUID.annotations({
    description: 'Unique identifier for this option.',
  }),
  name: Schema.String.annotations({
    description: 'Name of the option as displayed in Notion.',
    examples: ['High', 'Medium', 'Low'],
  }),
  color: SelectColor.annotations({
    description: 'Color of the option.',
  }),
}).annotations({
  identifier: 'Notion.SelectOption',
  title: 'Select Option',
  description: 'An option in a select or multi-select property.',
  [docsPath]: 'property-value-object#select',
})

export type SelectOption = typeof SelectOption.Type

// -----------------------------------------------------------------------------
// Write Schemas (for create/update payloads)
// -----------------------------------------------------------------------------

/**
 * Minimal rich text schema accepted in Notion write requests.
 *
 * @see https://developers.notion.com/reference/rich-text#text
 */
export const TextRichTextWrite = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.Struct({
    content: Schema.String,
    link: Schema.optional(Schema.NullOr(TextLink)),
  }),
}).annotations({
  identifier: 'Notion.TextRichTextWrite',
  title: 'Text Rich Text (Write)',
  description: 'Minimal text rich text object accepted in Notion write requests.',
  [docsPath]: 'rich-text#text',
})

export type TextRichTextWrite = typeof TextRichTextWrite.Type

// -----------------------------------------------------------------------------
// Title Property
// -----------------------------------------------------------------------------

/**
 * Title property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#title
 */
export const TitleProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('title').annotations({
    description: 'Property type identifier.',
  }),
  title: Schema.Array(RichText).annotations({
    description: 'Title content as rich text array.',
  }),
}).annotations({
  identifier: 'Notion.TitleProperty',
  title: 'Title Property',
  description: 'The title property of a Notion page.',
  [docsPath]: 'property-value-object#title',
})

export type TitleProperty = typeof TitleProperty.Type

/**
 * Title property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const TitleWrite = Schema.Struct({
  title: Schema.Array(TextRichTextWrite),
}).annotations({
  identifier: 'Notion.TitleWrite',
  title: 'Title (Write)',
  description: 'Write payload for a title property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type TitleWrite = typeof TitleWrite.Type

export const TitleWriteFromString = Schema.transform(Schema.String, TitleWrite, {
  strict: false,
  decode: (str) => ({
    title: [{ type: 'text', text: { content: str } }],
  }),
  encode: (write) => write.title.map((rt) => rt.text.content).join(''),
}).annotations({
  identifier: 'Notion.TitleWriteFromString',
  title: 'Title (Write) From String',
  description: 'Transform a plain string into a title write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Title property. */
export const Title = {
  /** The raw TitleProperty schema. */
  Property: TitleProperty,

  /** Transform to raw rich text array. */
  raw: Schema.transform(TitleProperty, RichTextArray, {
    strict: false,
    decode: (prop) => prop.title,
    encode: () =>
      shouldNeverHappen(
        'Title.raw encode is not supported. Use TitleWrite / TitleWriteFromString.',
      ),
  }),

  /** Transform to plain string. */
  asString: Schema.transform(TitleProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.title.map((rt) => rt.plain_text).join(''),
    encode: () =>
      shouldNeverHappen(
        'Title.asString encode is not supported. Use TitleWrite / TitleWriteFromString.',
      ),
  }),

  Write: {
    Schema: TitleWrite,
    fromString: TitleWriteFromString,
  },
} as const

// -----------------------------------------------------------------------------
// Rich Text Property
// -----------------------------------------------------------------------------

/**
 * Rich text property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#rich-text
 */
export const RichTextProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('rich_text').annotations({
    description: 'Property type identifier.',
  }),
  rich_text: RichTextArray.annotations({
    description: 'Content as rich text array.',
  }),
}).annotations({
  identifier: 'Notion.RichTextProperty',
  title: 'Rich Text Property',
  description: 'A rich text property value.',
  [docsPath]: 'property-value-object#rich-text',
})

export type RichTextProperty = typeof RichTextProperty.Type

/**
 * Rich text property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const RichTextWrite = Schema.Struct({
  rich_text: Schema.Array(TextRichTextWrite),
}).annotations({
  identifier: 'Notion.RichTextWrite',
  title: 'Rich Text (Write)',
  description: 'Write payload for a rich text property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type RichTextWrite = typeof RichTextWrite.Type

export const RichTextWriteFromString = Schema.transform(Schema.String, RichTextWrite, {
  strict: false,
  decode: (str) => ({
    rich_text: [{ type: 'text', text: { content: str } }],
  }),
  encode: (write) => write.rich_text.map((rt) => rt.text.content).join(''),
}).annotations({
  identifier: 'Notion.RichTextWriteFromString',
  title: 'Rich Text (Write) From String',
  description: 'Transform a plain string into a rich text write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for RichText property. */
export const RichTextProp = {
  /** The raw RichTextProperty schema. */
  Property: RichTextProperty,

  /** Transform to raw rich text array. */
  raw: Schema.transform(RichTextProperty, RichTextArray, {
    strict: false,
    decode: (prop) => prop.rich_text,
    encode: () =>
      shouldNeverHappen(
        'RichTextProp.raw encode is not supported. Use RichTextWrite / RichTextWriteFromString.',
      ),
  }),

  /** Transform to plain string. */
  asString: Schema.transform(RichTextProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.rich_text.map((rt) => rt.plain_text).join(''),
    encode: () =>
      shouldNeverHappen(
        'RichTextProp.asString encode is not supported. Use RichTextWrite / RichTextWriteFromString.',
      ),
  }),

  /** Transform to Option<string> (empty becomes None). */
  asOption: Schema.transform(RichTextProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => {
      const text = prop.rich_text.map((rt) => rt.plain_text).join('')
      return text.trim() === '' ? Option.none() : Option.some(text)
    },
    encode: () =>
      shouldNeverHappen(
        'RichTextProp.asOption encode is not supported. Use RichTextWrite / RichTextWriteFromString.',
      ),
  }),

  Write: {
    Schema: RichTextWrite,
    fromString: RichTextWriteFromString,
  },
} as const

// -----------------------------------------------------------------------------
// Number Property
// -----------------------------------------------------------------------------

/**
 * Number property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#number
 */
export const NumberProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('number').annotations({
    description: 'Property type identifier.',
  }),
  number: Schema.NullOr(Schema.Number).annotations({
    description: 'The numeric value, or null if empty.',
    examples: [42, 3.14, null],
  }),
}).annotations({
  identifier: 'Notion.NumberProperty',
  title: 'Number Property',
  description: 'A number property value.',
  [docsPath]: 'property-value-object#number',
})

export type NumberProperty = typeof NumberProperty.Type

/**
 * Number property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const NumberWrite = Schema.Struct({
  number: Schema.NullOr(Schema.Number),
}).annotations({
  identifier: 'Notion.NumberWrite',
  title: 'Number (Write)',
  description: 'Write payload for a number property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type NumberWrite = typeof NumberWrite.Type

export const NumberWriteFromNumber = Schema.transform(Schema.NullOr(Schema.Number), NumberWrite, {
  strict: false,
  decode: (number) => ({ number }),
  encode: (write) => write.number,
}).annotations({
  identifier: 'Notion.NumberWriteFromNumber',
  title: 'Number (Write) From Number',
  description: 'Transform a number (or null) into a number write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Number property. */
export const Num = {
  /** The raw NumberProperty schema. */
  Property: NumberProperty,

  /** Transform to raw nullable number. */
  raw: Schema.transform(NumberProperty, Schema.NullOr(Schema.Number), {
    strict: false,
    decode: (prop) => prop.number,
    encode: () =>
      shouldNeverHappen(
        'Num.raw encode is not supported. Use NumberWrite / NumberWriteFromNumber.',
      ),
  }),

  /** Transform to Option<number>. */
  asOption: Schema.transform(NumberProperty, Schema.OptionFromSelf(Schema.Number), {
    strict: false,
    decode: (prop) => (prop.number === null ? Option.none() : Option.some(prop.number)),
    encode: () =>
      shouldNeverHappen(
        'Num.asOption encode is not supported. Use NumberWrite / NumberWriteFromNumber.',
      ),
  }),

  /** Transform to required number (fails if null). */
  asNumber: Schema.transform(
    NumberProperty.pipe(
      Schema.filter((p): p is typeof p & { number: number } => p.number !== null, {
        message: () => 'Number is required',
      }),
    ),
    Schema.Number,
    {
      strict: false,
      decode: (prop) => prop.number,
      encode: () =>
        shouldNeverHappen(
          'Num.asNumber encode is not supported. Use NumberWrite / NumberWriteFromNumber.',
        ),
    },
  ),

  Write: {
    Schema: NumberWrite,
    fromNumber: NumberWriteFromNumber,
  },
} as const

// -----------------------------------------------------------------------------
// Checkbox Property
// -----------------------------------------------------------------------------

/**
 * Checkbox property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#checkbox
 */
export const CheckboxProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('checkbox').annotations({
    description: 'Property type identifier.',
  }),
  checkbox: Schema.Boolean.annotations({
    description: 'The checkbox value (checked or unchecked).',
  }),
}).annotations({
  identifier: 'Notion.CheckboxProperty',
  title: 'Checkbox Property',
  description: 'A checkbox property value.',
  [docsPath]: 'property-value-object#checkbox',
})

export type CheckboxProperty = typeof CheckboxProperty.Type

/**
 * Checkbox property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const CheckboxWrite = Schema.Struct({
  checkbox: Schema.Boolean,
}).annotations({
  identifier: 'Notion.CheckboxWrite',
  title: 'Checkbox (Write)',
  description: 'Write payload for a checkbox property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type CheckboxWrite = typeof CheckboxWrite.Type

export const CheckboxWriteFromBoolean = Schema.transform(Schema.Boolean, CheckboxWrite, {
  strict: false,
  decode: (checkbox) => ({ checkbox }),
  encode: (write) => write.checkbox,
}).annotations({
  identifier: 'Notion.CheckboxWriteFromBoolean',
  title: 'Checkbox (Write) From Boolean',
  description: 'Transform a boolean into a checkbox write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Checkbox property. */
export const Checkbox = {
  /** The raw CheckboxProperty schema. */
  Property: CheckboxProperty,

  /** Transform to raw boolean. */
  raw: Schema.transform(CheckboxProperty, Schema.Boolean, {
    strict: false,
    decode: (prop) => prop.checkbox,
    encode: () =>
      shouldNeverHappen(
        'Checkbox.raw encode is not supported. Use CheckboxWrite / CheckboxWriteFromBoolean.',
      ),
  }),

  /** Alias for raw (checkbox is always boolean). */
  asBoolean: Schema.transform(CheckboxProperty, Schema.Boolean, {
    strict: false,
    decode: (prop) => prop.checkbox,
    encode: () =>
      shouldNeverHappen(
        'Checkbox.asBoolean encode is not supported. Use CheckboxWrite / CheckboxWriteFromBoolean.',
      ),
  }),

  Write: {
    Schema: CheckboxWrite,
    fromBoolean: CheckboxWriteFromBoolean,
  },
} as const

// -----------------------------------------------------------------------------
// Select Property
// -----------------------------------------------------------------------------

/**
 * Select property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#select
 */
export const SelectProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('select').annotations({
    description: 'Property type identifier.',
  }),
  select: Schema.NullOr(SelectOption).annotations({
    description: 'The selected option, or null if none selected.',
  }),
}).annotations({
  identifier: 'Notion.SelectProperty',
  title: 'Select Property',
  description: 'A select property value.',
  [docsPath]: 'property-value-object#select',
})

export type SelectProperty = typeof SelectProperty.Type

/**
 * Select option write object accepted by Notion.
 * Can reference an option by name (commonly used) or by id.
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const SelectOptionWrite = Schema.Union(
  Schema.Struct({ id: NotionUUID }),
  Schema.Struct({ name: Schema.String }),
).annotations({
  identifier: 'Notion.SelectOptionWrite',
  title: 'Select Option (Write)',
  description: 'A select option reference for write requests.',
  [docsPath]: 'page#page-property-value',
})

export type SelectOptionWrite = typeof SelectOptionWrite.Type

/**
 * Select property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const SelectWrite = Schema.Struct({
  select: Schema.NullOr(SelectOptionWrite),
}).annotations({
  identifier: 'Notion.SelectWrite',
  title: 'Select (Write)',
  description: 'Write payload for a select property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type SelectWrite = typeof SelectWrite.Type

export const SelectWriteFromName = Schema.transform(Schema.NullOr(Schema.String), SelectWrite, {
  strict: false,
  decode: (name) => ({
    select: name === null ? null : { name },
  }),
  encode: (write) => {
    if (write.select === null) {
      return null
    }

    if ('name' in write.select) {
      return write.select.name
    }

    return shouldNeverHappen('SelectWriteFromName cannot encode option referenced by id.')
  },
}).annotations({
  identifier: 'Notion.SelectWriteFromName',
  title: 'Select (Write) From Name',
  description: 'Transform an option name (or null) into a select write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Select property. */
export const Select = {
  /** The raw SelectProperty schema. */
  Property: SelectProperty,

  /** Transform to raw nullable SelectOption. */
  raw: Schema.transform(SelectProperty, Schema.NullOr(SelectOption), {
    strict: false,
    decode: (prop) => prop.select,
    encode: () =>
      shouldNeverHappen(
        'Select.raw encode is not supported. Use SelectWrite / SelectWriteFromName.',
      ),
  }),

  /** Transform to Option<SelectOption>. */
  asOption: Schema.transform(SelectProperty, Schema.OptionFromSelf(SelectOption), {
    strict: false,
    decode: (prop) => (prop.select === null ? Option.none() : Option.some(prop.select)),
    encode: () =>
      shouldNeverHappen(
        'Select.asOption encode is not supported. Use SelectWrite / SelectWriteFromName.',
      ),
  }),

  /** Transform to Option<string> (option name). */
  asString: Schema.transform(SelectProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.select === null ? Option.none() : Option.some(prop.select.name)),
    encode: () =>
      shouldNeverHappen(
        'Select.asString encode is not supported. Use SelectWrite / SelectWriteFromName.',
      ),
  }),

  /** Transform to required string (fails if null). */
  asStringRequired: Schema.transform(
    SelectProperty.pipe(
      Schema.filter((p): p is typeof p & { select: SelectOption } => p.select !== null, {
        message: () => 'Select is required',
      }),
    ),
    Schema.String,
    {
      strict: false,
      decode: (prop) => prop.select.name,
      encode: () =>
        shouldNeverHappen(
          'Select.asStringRequired encode is not supported. Use SelectWrite / SelectWriteFromName.',
        ),
    },
  ),

  Write: {
    Schema: SelectWrite,
    fromName: SelectWriteFromName,
  },
} as const

// -----------------------------------------------------------------------------
// Multi-Select Property
// -----------------------------------------------------------------------------

/**
 * Multi-select property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#multi-select
 */
export const MultiSelectProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('multi_select').annotations({
    description: 'Property type identifier.',
  }),
  multi_select: Schema.Array(SelectOption).annotations({
    description: 'Array of selected options.',
  }),
}).annotations({
  identifier: 'Notion.MultiSelectProperty',
  title: 'Multi-Select Property',
  description: 'A multi-select property value.',
  [docsPath]: 'property-value-object#multi-select',
})

export type MultiSelectProperty = typeof MultiSelectProperty.Type

/**
 * Multi-select property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const MultiSelectWrite = Schema.Struct({
  multi_select: Schema.Array(SelectOptionWrite),
}).annotations({
  identifier: 'Notion.MultiSelectWrite',
  title: 'Multi-Select (Write)',
  description: 'Write payload for a multi-select property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type MultiSelectWrite = typeof MultiSelectWrite.Type

export const MultiSelectWriteFromNames = Schema.transform(
  Schema.Array(Schema.String),
  MultiSelectWrite,
  {
    strict: false,
    decode: (names) => ({
      multi_select: names.map((name) => ({ name })),
    }),
    encode: (write) =>
      write.multi_select.map((opt) => {
        if ('name' in opt) {
          return opt.name
        }

        return shouldNeverHappen('MultiSelectWriteFromNames cannot encode option referenced by id.')
      }),
  },
).annotations({
  identifier: 'Notion.MultiSelectWriteFromNames',
  title: 'Multi-Select (Write) From Names',
  description: 'Transform option names into a multi-select write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for MultiSelect property. */
export const MultiSelect = {
  /** The raw MultiSelectProperty schema. */
  Property: MultiSelectProperty,

  /** Transform to raw array of SelectOptions. */
  raw: Schema.transform(MultiSelectProperty, Schema.Array(SelectOption), {
    strict: false,
    decode: (prop) => prop.multi_select,
    encode: () =>
      shouldNeverHappen(
        'MultiSelect.raw encode is not supported. Use MultiSelectWrite / MultiSelectWriteFromNames.',
      ),
  }),

  /** Transform to array of option names. */
  asStrings: Schema.transform(MultiSelectProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.multi_select.map((opt) => opt.name),
    encode: () =>
      shouldNeverHappen(
        'MultiSelect.asStrings encode is not supported. Use MultiSelectWrite / MultiSelectWriteFromNames.',
      ),
  }),

  Write: {
    Schema: MultiSelectWrite,
    fromNames: MultiSelectWriteFromNames,
  },
} as const

// -----------------------------------------------------------------------------
// Status Property
// -----------------------------------------------------------------------------

/**
 * Status property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#status
 */
export const StatusProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('status').annotations({
    description: 'Property type identifier.',
  }),
  status: Schema.NullOr(SelectOption).annotations({
    description: 'The current status, or null if none.',
  }),
}).annotations({
  identifier: 'Notion.StatusProperty',
  title: 'Status Property',
  description: 'A status property value.',
  [docsPath]: 'property-value-object#status',
})

export type StatusProperty = typeof StatusProperty.Type

/**
 * Status property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const StatusWrite = Schema.Struct({
  status: Schema.NullOr(SelectOptionWrite),
}).annotations({
  identifier: 'Notion.StatusWrite',
  title: 'Status (Write)',
  description: 'Write payload for a status property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type StatusWrite = typeof StatusWrite.Type

export const StatusWriteFromName = Schema.transform(Schema.NullOr(Schema.String), StatusWrite, {
  strict: false,
  decode: (name) => ({
    status: name === null ? null : { name },
  }),
  encode: (write) => {
    if (write.status === null) {
      return null
    }

    if ('name' in write.status) {
      return write.status.name
    }

    return shouldNeverHappen('StatusWriteFromName cannot encode option referenced by id.')
  },
}).annotations({
  identifier: 'Notion.StatusWriteFromName',
  title: 'Status (Write) From Name',
  description: 'Transform a status name (or null) into a status write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Status property. */
export const Status = {
  /** The raw StatusProperty schema. */
  Property: StatusProperty,

  /** Transform to raw nullable SelectOption. */
  raw: Schema.transform(StatusProperty, Schema.NullOr(SelectOption), {
    strict: false,
    decode: (prop) => prop.status,
    encode: () =>
      shouldNeverHappen(
        'Status.raw encode is not supported. Use StatusWrite / StatusWriteFromName.',
      ),
  }),

  /** Transform to Option<string> (status name). */
  asString: Schema.transform(StatusProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.status === null ? Option.none() : Option.some(prop.status.name)),
    encode: () =>
      shouldNeverHappen(
        'Status.asString encode is not supported. Use StatusWrite / StatusWriteFromName.',
      ),
  }),

  Write: {
    Schema: StatusWrite,
    fromName: StatusWriteFromName,
  },
} as const

// -----------------------------------------------------------------------------
// Date Property
// -----------------------------------------------------------------------------

/**
 * Date value object used in date properties.
 *
 * @see https://developers.notion.com/reference/property-value-object#date
 */
export const DateValue = Schema.Struct({
  start: Schema.String.annotations({
    description: 'Start date in ISO 8601 format.',
    examples: ['2024-01-15', '2024-01-15T10:30:00.000Z'],
  }),
  end: Schema.NullOr(Schema.String).annotations({
    description: 'End date for date ranges, or null for single dates.',
  }),
  time_zone: Schema.NullOr(Schema.String).annotations({
    description: 'IANA time zone, or null for dates without time.',
    examples: ['America/New_York', 'Europe/London'],
  }),
}).annotations({
  identifier: 'Notion.DateValue',
  title: 'Date Value',
  description: 'A date or date range value.',
  [docsPath]: 'property-value-object#date',
})

export type DateValue = typeof DateValue.Type

/**
 * Date property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#date
 */
export const DateProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('date').annotations({
    description: 'Property type identifier.',
  }),
  date: Schema.NullOr(DateValue).annotations({
    description: 'The date value, or null if empty.',
  }),
}).annotations({
  identifier: 'Notion.DateProperty',
  title: 'Date Property',
  description: 'A date property value.',
  [docsPath]: 'property-value-object#date',
})

export type DateProperty = typeof DateProperty.Type

/**
 * Date value write object accepted by Notion.
 * In write requests, `end` / `time_zone` are optional.
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const DateValueWrite = Schema.Struct({
  start: Schema.String,
  end: Schema.optional(Schema.NullOr(Schema.String)),
  time_zone: Schema.optional(Schema.NullOr(Schema.String)),
}).annotations({
  identifier: 'Notion.DateValueWrite',
  title: 'Date Value (Write)',
  description: 'Date value object accepted in Notion write requests.',
  [docsPath]: 'page#page-property-value',
})

export type DateValueWrite = typeof DateValueWrite.Type

/**
 * Date property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const DateWrite = Schema.Struct({
  date: Schema.NullOr(DateValueWrite),
}).annotations({
  identifier: 'Notion.DateWrite',
  title: 'Date (Write)',
  description: 'Write payload for a date property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type DateWrite = typeof DateWrite.Type

export const DateWriteFromStart = Schema.transform(Schema.String, DateWrite, {
  strict: false,
  decode: (start) => ({ date: { start } }),
  encode: (write) => {
    if (write.date === null) {
      return ''
    }

    return write.date.start
  },
}).annotations({
  identifier: 'Notion.DateWriteFromStart',
  title: 'Date (Write) From Start',
  description: 'Transform a start date/time string into a date write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Date property. */
export const DateProp = {
  /** The raw DateProperty schema. */
  Property: DateProperty,

  /** Transform to raw nullable DateValue. */
  raw: Schema.transform(DateProperty, Schema.NullOr(DateValue), {
    strict: false,
    decode: (prop) => prop.date,
    encode: () =>
      shouldNeverHappen(
        'DateProp.raw encode is not supported. Use DateWrite / DateWriteFromStart.',
      ),
  }),

  /** Transform to Option<DateValue>. */
  asOption: Schema.transform(DateProperty, Schema.OptionFromSelf(DateValue), {
    strict: false,
    decode: (prop) => (prop.date === null ? Option.none() : Option.some(prop.date)),
    encode: () =>
      shouldNeverHappen(
        'DateProp.asOption encode is not supported. Use DateWrite / DateWriteFromStart.',
      ),
  }),

  /** Transform to Option<Date> (start date only, parsed). */
  asDate: Schema.transform(DateProperty, Schema.OptionFromSelf(Schema.DateFromSelf), {
    strict: false,
    decode: (prop) => (prop.date === null ? Option.none() : Option.some(new Date(prop.date.start))),
    encode: () =>
      shouldNeverHappen(
        'DateProp.asDate encode is not supported. Use DateWrite / DateWriteFromStart.',
      ),
  }),

  Write: {
    Schema: DateWrite,
    fromStart: DateWriteFromStart,
  },
} as const

// -----------------------------------------------------------------------------
// URL Property
// -----------------------------------------------------------------------------

/**
 * URL property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#url
 */
export const UrlProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('url').annotations({
    description: 'Property type identifier.',
  }),
  url: Schema.NullOr(Schema.String).annotations({
    description: 'The URL value, or null if empty.',
    examples: ['https://example.com'],
  }),
}).annotations({
  identifier: 'Notion.UrlProperty',
  title: 'URL Property',
  description: 'A URL property value.',
  [docsPath]: 'property-value-object#url',
})

export type UrlProperty = typeof UrlProperty.Type

/**
 * URL property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const UrlWrite = Schema.Struct({
  url: Schema.NullOr(Schema.String),
}).annotations({
  identifier: 'Notion.UrlWrite',
  title: 'URL (Write)',
  description: 'Write payload for a URL property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type UrlWrite = typeof UrlWrite.Type

export const UrlWriteFromString = Schema.transform(Schema.NullOr(Schema.String), UrlWrite, {
  strict: false,
  decode: (url) => ({ url }),
  encode: (write) => write.url,
}).annotations({
  identifier: 'Notion.UrlWriteFromString',
  title: 'URL (Write) From String',
  description: 'Transform a URL string (or null) into a URL write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for URL property. */
export const Url = {
  /** The raw UrlProperty schema. */
  Property: UrlProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(UrlProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.url,
    encode: () =>
      shouldNeverHappen('Url.raw encode is not supported. Use UrlWrite / UrlWriteFromString.'),
  }),

  /** Transform to Option<string>. */
  asOption: Schema.transform(UrlProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.url === null ? Option.none() : Option.some(prop.url)),
    encode: () =>
      shouldNeverHappen('Url.asOption encode is not supported. Use UrlWrite / UrlWriteFromString.'),
  }),

  Write: {
    Schema: UrlWrite,
    fromString: UrlWriteFromString,
  },
} as const

// -----------------------------------------------------------------------------
// Email Property
// -----------------------------------------------------------------------------

/**
 * Email property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#email
 */
export const EmailProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('email').annotations({
    description: 'Property type identifier.',
  }),
  email: Schema.NullOr(Schema.String).annotations({
    description: 'The email address, or null if empty.',
    examples: ['user@example.com'],
  }),
}).annotations({
  identifier: 'Notion.EmailProperty',
  title: 'Email Property',
  description: 'An email property value.',
  [docsPath]: 'property-value-object#email',
})

export type EmailProperty = typeof EmailProperty.Type

/**
 * Email property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const EmailWrite = Schema.Struct({
  email: Schema.NullOr(Schema.String),
}).annotations({
  identifier: 'Notion.EmailWrite',
  title: 'Email (Write)',
  description: 'Write payload for an email property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type EmailWrite = typeof EmailWrite.Type

export const EmailWriteFromString = Schema.transform(Schema.NullOr(Schema.String), EmailWrite, {
  strict: false,
  decode: (email) => ({ email }),
  encode: (write) => write.email,
}).annotations({
  identifier: 'Notion.EmailWriteFromString',
  title: 'Email (Write) From String',
  description: 'Transform an email string (or null) into an email write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Email property. */
export const Email = {
  /** The raw EmailProperty schema. */
  Property: EmailProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(EmailProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.email,
    encode: () =>
      shouldNeverHappen(
        'Email.raw encode is not supported. Use EmailWrite / EmailWriteFromString.',
      ),
  }),

  /** Transform to Option<string>. */
  asOption: Schema.transform(EmailProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.email === null ? Option.none() : Option.some(prop.email)),
    encode: () =>
      shouldNeverHappen(
        'Email.asOption encode is not supported. Use EmailWrite / EmailWriteFromString.',
      ),
  }),

  Write: {
    Schema: EmailWrite,
    fromString: EmailWriteFromString,
  },
} as const

// -----------------------------------------------------------------------------
// Phone Number Property
// -----------------------------------------------------------------------------

/**
 * Phone number property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#phone-number
 */
export const PhoneNumberProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('phone_number').annotations({
    description: 'Property type identifier.',
  }),
  phone_number: Schema.NullOr(Schema.String).annotations({
    description: 'The phone number, or null if empty.',
    examples: ['+1 555-123-4567'],
  }),
}).annotations({
  identifier: 'Notion.PhoneNumberProperty',
  title: 'Phone Number Property',
  description: 'A phone number property value.',
  [docsPath]: 'property-value-object#phone-number',
})

export type PhoneNumberProperty = typeof PhoneNumberProperty.Type

/**
 * Phone number property write payload (for create/update page requests).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const PhoneNumberWrite = Schema.Struct({
  phone_number: Schema.NullOr(Schema.String),
}).annotations({
  identifier: 'Notion.PhoneNumberWrite',
  title: 'Phone Number (Write)',
  description: 'Write payload for a phone number property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type PhoneNumberWrite = typeof PhoneNumberWrite.Type

export const PhoneNumberWriteFromString = Schema.transform(
  Schema.NullOr(Schema.String),
  PhoneNumberWrite,
  {
    strict: false,
    decode: (phone_number) => ({ phone_number }),
    encode: (write) => write.phone_number,
  },
).annotations({
  identifier: 'Notion.PhoneNumberWriteFromString',
  title: 'Phone Number (Write) From String',
  description: 'Transform a phone number string (or null) into a phone number write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for PhoneNumber property. */
export const PhoneNumber = {
  /** The raw PhoneNumberProperty schema. */
  Property: PhoneNumberProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(PhoneNumberProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.phone_number,
    encode: () =>
      shouldNeverHappen(
        'PhoneNumber.raw encode is not supported. Use PhoneNumberWrite / PhoneNumberWriteFromString.',
      ),
  }),

  /** Transform to Option<string>. */
  asOption: Schema.transform(PhoneNumberProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.phone_number === null ? Option.none() : Option.some(prop.phone_number)),
    encode: () =>
      shouldNeverHappen(
        'PhoneNumber.asOption encode is not supported. Use PhoneNumberWrite / PhoneNumberWriteFromString.',
      ),
  }),

  Write: {
    Schema: PhoneNumberWrite,
    fromString: PhoneNumberWriteFromString,
  },
} as const

// -----------------------------------------------------------------------------
// People Property
// -----------------------------------------------------------------------------

/**
 * People property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#people
 */
export const PeopleProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('people').annotations({
    description: 'Property type identifier.',
  }),
  people: Schema.Array(User).annotations({
    description: 'Array of assigned users.',
  }),
}).annotations({
  identifier: 'Notion.PeopleProperty',
  title: 'People Property',
  description: 'A people property value.',
  [docsPath]: 'property-value-object#people',
})

export type PeopleProperty = typeof PeopleProperty.Type

/**
 * People property write payload (for create/update page requests).
 * Notion expects an array of user references (by id).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const PeopleWrite = Schema.Struct({
  people: Schema.Array(
    Schema.Struct({
      id: NotionUUID,
    }),
  ),
}).annotations({
  identifier: 'Notion.PeopleWrite',
  title: 'People (Write)',
  description: 'Write payload for a people property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type PeopleWrite = typeof PeopleWrite.Type

export const PeopleWriteFromIds = Schema.transform(Schema.Array(NotionUUID), PeopleWrite, {
  strict: false,
  decode: (ids) => ({
    people: ids.map((id) => ({ id })),
  }),
  encode: (write) => write.people.map((p) => p.id),
}).annotations({
  identifier: 'Notion.PeopleWriteFromIds',
  title: 'People (Write) From IDs',
  description: 'Transform user IDs into a people write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for People property. */
export const People = {
  /** The raw PeopleProperty schema. */
  Property: PeopleProperty,

  /** Transform to raw array of Users. */
  raw: Schema.transform(PeopleProperty, Schema.Array(User), {
    strict: false,
    decode: (prop) => prop.people,
    encode: () =>
      shouldNeverHappen(
        'People.raw encode is not supported. Use PeopleWrite / PeopleWriteFromIds.',
      ),
  }),

  /** Transform to array of user IDs. */
  asIds: Schema.transform(PeopleProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.people.map((u) => u.id),
    encode: () =>
      shouldNeverHappen(
        'People.asIds encode is not supported. Use PeopleWrite / PeopleWriteFromIds.',
      ),
  }),

  Write: {
    Schema: PeopleWrite,
    fromIds: PeopleWriteFromIds,
  },
} as const

// -----------------------------------------------------------------------------
// Relation Property
// -----------------------------------------------------------------------------

/**
 * Relation property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#relation
 */
export const RelationProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('relation').annotations({
    description: 'Property type identifier.',
  }),
  relation: Schema.Array(
    Schema.Struct({
      id: NotionUUID.annotations({
        description: 'ID of the related page.',
      }),
    }),
  ).annotations({
    description: 'Array of related page references.',
  }),
  has_more: Schema.optionalWith(Schema.Boolean, { as: 'Option' }).annotations({
    description: 'Whether there are more relations than returned.',
  }),
}).annotations({
  identifier: 'Notion.RelationProperty',
  title: 'Relation Property',
  description: 'A relation property value linking to other pages.',
  [docsPath]: 'property-value-object#relation',
})

export type RelationProperty = typeof RelationProperty.Type

/**
 * Relation property write payload (for create/update page requests).
 * Notion expects an array of page references (by id).
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const RelationWrite = Schema.Struct({
  relation: Schema.Array(
    Schema.Struct({
      id: NotionUUID,
    }),
  ),
}).annotations({
  identifier: 'Notion.RelationWrite',
  title: 'Relation (Write)',
  description: 'Write payload for a relation property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type RelationWrite = typeof RelationWrite.Type

export const RelationWriteFromIds = Schema.transform(Schema.Array(NotionUUID), RelationWrite, {
  strict: false,
  decode: (ids) => ({
    relation: ids.map((id) => ({ id })),
  }),
  encode: (write) => write.relation.map((r) => r.id),
}).annotations({
  identifier: 'Notion.RelationWriteFromIds',
  title: 'Relation (Write) From IDs',
  description: 'Transform page IDs into a relation write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Relation property. */
export const Relation = {
  /** The raw RelationProperty schema. */
  Property: RelationProperty,

  /** Transform to array of page IDs. */
  asIds: Schema.transform(RelationProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.relation.map((r) => r.id),
    encode: () =>
      shouldNeverHappen(
        'Relation.asIds encode is not supported. Use RelationWrite / RelationWriteFromIds.',
      ),
  }),

  Write: {
    Schema: RelationWrite,
    fromIds: RelationWriteFromIds,
  },
} as const

// -----------------------------------------------------------------------------
// Files Property
// -----------------------------------------------------------------------------

/**
 * External file object.
 */
export const ExternalFile = Schema.Struct({
  type: Schema.Literal('external'),
  name: Schema.String.annotations({
    description: 'Name of the file.',
  }),
  external: Schema.Struct({
    url: Schema.String.annotations({
      description: 'External URL of the file.',
      examples: ['https://example.com/image.png'],
    }),
  }),
}).annotations({
  identifier: 'Notion.ExternalFile',
  title: 'External File',
  description: 'A file hosted externally.',
  [docsPath]: 'property-value-object#files',
})

export type ExternalFile = typeof ExternalFile.Type

/**
 * Notion-hosted file object.
 */
export const NotionFile = Schema.Struct({
  type: Schema.Literal('file'),
  name: Schema.String.annotations({
    description: 'Name of the file.',
  }),
  file: Schema.Struct({
    url: Schema.String.annotations({
      description: 'Notion-hosted URL of the file (expires).',
    }),
    expiry_time: Schema.String.annotations({
      description: 'When the URL expires (ISO 8601).',
    }),
  }),
}).annotations({
  identifier: 'Notion.NotionFile',
  title: 'Notion File',
  description: 'A file hosted on Notion (URL expires).',
  [docsPath]: 'property-value-object#files',
})

export type NotionFile = typeof NotionFile.Type

/**
 * File object (either external or Notion-hosted).
 */
export const FileObject = Schema.Union(ExternalFile, NotionFile).annotations({
  identifier: 'Notion.FileObject',
  title: 'File Object',
  description: 'A file, either external or Notion-hosted.',
  [docsPath]: 'property-value-object#files',
})

export type FileObject = typeof FileObject.Type

/**
 * Files property value from the Notion API.
 *
 * @see https://developers.notion.com/reference/property-value-object#files
 */
export const FilesProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('files').annotations({
    description: 'Property type identifier.',
  }),
  files: Schema.Array(FileObject).annotations({
    description: 'Array of file objects.',
  }),
}).annotations({
  identifier: 'Notion.FilesProperty',
  title: 'Files Property',
  description: 'A files property value.',
  [docsPath]: 'property-value-object#files',
})

export type FilesProperty = typeof FilesProperty.Type

/**
 * Files property write payload (for create/update page requests).
 * Notion accepts external files in write requests.
 *
 * @see https://developers.notion.com/reference/page#page-property-value
 */
export const FilesWrite = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      type: Schema.Literal('external'),
      name: Schema.optional(Schema.String),
      external: Schema.Struct({
        url: Schema.String,
      }),
    }),
  ),
}).annotations({
  identifier: 'Notion.FilesWrite',
  title: 'Files (Write)',
  description: 'Write payload for a files property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type FilesWrite = typeof FilesWrite.Type

export const FilesWriteFromUrls = Schema.transform(Schema.Array(Schema.String), FilesWrite, {
  strict: false,
  decode: (urls) => ({
    files: urls.map((url) => ({
      type: 'external' as const,
      external: { url },
    })),
  }),
  encode: (write) => write.files.map((f) => f.external.url),
}).annotations({
  identifier: 'Notion.FilesWriteFromUrls',
  title: 'Files (Write) From URLs',
  description: 'Transform external URLs into a files write payload.',
  [docsPath]: 'page#page-property-value',
})

/** Transforms for Files property. */
export const Files = {
  /** The raw FilesProperty schema. */
  Property: FilesProperty,

  /** Transform to raw array of FileObjects. */
  raw: Schema.transform(FilesProperty, Schema.Array(FileObject), {
    strict: false,
    decode: (prop) => prop.files,
    encode: () =>
      shouldNeverHappen('Files.raw encode is not supported. Use FilesWrite / FilesWriteFromUrls.'),
  }),

  /** Transform to array of URLs. */
  asUrls: Schema.transform(FilesProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.files.map((f) => (f.type === 'external' ? f.external.url : f.file.url)),
    encode: () =>
      shouldNeverHappen(
        'Files.asUrls encode is not supported. Use FilesWrite / FilesWriteFromUrls.',
      ),
  }),

  Write: {
    Schema: FilesWrite,
    fromUrls: FilesWriteFromUrls,
  },
} as const

// -----------------------------------------------------------------------------
// Formula Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Formula result value.
 */
export const FormulaValue = Schema.Union(
  Schema.Struct({ type: Schema.Literal('string'), string: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal('number'), number: Schema.NullOr(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal('boolean'), boolean: Schema.NullOr(Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal('date'), date: Schema.NullOr(DateValue) }),
).annotations({
  identifier: 'Notion.FormulaValue',
  title: 'Formula Value',
  description: 'The computed result of a formula.',
  [docsPath]: 'property-value-object#formula',
})

export type FormulaValue = typeof FormulaValue.Type

/**
 * Formula property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#formula
 */
export const FormulaProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('formula').annotations({
    description: 'Property type identifier.',
  }),
  formula: FormulaValue.annotations({
    description: 'The computed formula result.',
  }),
}).annotations({
  identifier: 'Notion.FormulaProperty',
  title: 'Formula Property',
  description: 'A formula property value (read-only, computed).',
  [docsPath]: 'property-value-object#formula',
})

export type FormulaProperty = typeof FormulaProperty.Type

/** Transforms for Formula property. */
export const Formula = {
  /** The raw FormulaProperty schema. */
  Property: FormulaProperty,

  /** Transform to raw FormulaValue. */
  raw: Schema.transform(FormulaProperty, FormulaValue, {
    strict: false,
    decode: (prop) => prop.formula,
    encode: () => shouldNeverHappen('Formula.raw encode is not supported (formula is read-only).'),
  }),
} as const

// -----------------------------------------------------------------------------
// Created Time Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Created time property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#created-time
 */
export const CreatedTimeProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('created_time').annotations({
    description: 'Property type identifier.',
  }),
  created_time: Schema.String.annotations({
    description: 'When the page was created (ISO 8601).',
    examples: ['2024-01-15T10:30:00.000Z'],
  }),
}).annotations({
  identifier: 'Notion.CreatedTimeProperty',
  title: 'Created Time Property',
  description: 'The creation timestamp (read-only).',
  [docsPath]: 'property-value-object#created-time',
})

export type CreatedTimeProperty = typeof CreatedTimeProperty.Type

/** Transforms for CreatedTime property. */
export const CreatedTime = {
  /** The raw CreatedTimeProperty schema. */
  Property: CreatedTimeProperty,

  /** Transform to raw ISO string. */
  raw: Schema.transform(CreatedTimeProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.created_time,
    encode: () =>
      shouldNeverHappen('CreatedTime.raw encode is not supported (created_time is read-only).'),
  }),

  /** Transform to Date object. */
  asDate: Schema.transform(CreatedTimeProperty, Schema.DateFromSelf, {
    strict: false,
    decode: (prop) => new Date(prop.created_time),
    encode: () =>
      shouldNeverHappen('CreatedTime.asDate encode is not supported (created_time is read-only).'),
  }),
} as const

// -----------------------------------------------------------------------------
// Created By Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Created by property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#created-by
 */
export const CreatedByProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('created_by').annotations({
    description: 'Property type identifier.',
  }),
  created_by: PartialUser.annotations({
    description: 'The user who created the page.',
  }),
}).annotations({
  identifier: 'Notion.CreatedByProperty',
  title: 'Created By Property',
  description: 'The user who created the page (read-only).',
  [docsPath]: 'property-value-object#created-by',
})

export type CreatedByProperty = typeof CreatedByProperty.Type

/** Transforms for CreatedBy property. */
export const CreatedBy = {
  /** The raw CreatedByProperty schema. */
  Property: CreatedByProperty,

  /** Transform to raw PartialUser. */
  raw: Schema.transform(CreatedByProperty, PartialUser, {
    strict: false,
    decode: (prop) => prop.created_by,
    encode: () =>
      shouldNeverHappen('CreatedBy.raw encode is not supported (created_by is read-only).'),
  }),

  /** Transform to user ID. */
  asId: Schema.transform(CreatedByProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.created_by.id,
    encode: () =>
      shouldNeverHappen('CreatedBy.asId encode is not supported (created_by is read-only).'),
  }),
} as const

// -----------------------------------------------------------------------------
// Last Edited Time Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Last edited time property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#last-edited-time
 */
export const LastEditedTimeProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('last_edited_time').annotations({
    description: 'Property type identifier.',
  }),
  last_edited_time: Schema.String.annotations({
    description: 'When the page was last edited (ISO 8601).',
    examples: ['2024-01-15T10:30:00.000Z'],
  }),
}).annotations({
  identifier: 'Notion.LastEditedTimeProperty',
  title: 'Last Edited Time Property',
  description: 'The last edit timestamp (read-only).',
  [docsPath]: 'property-value-object#last-edited-time',
})

export type LastEditedTimeProperty = typeof LastEditedTimeProperty.Type

/** Transforms for LastEditedTime property. */
export const LastEditedTime = {
  /** The raw LastEditedTimeProperty schema. */
  Property: LastEditedTimeProperty,

  /** Transform to raw ISO string. */
  raw: Schema.transform(LastEditedTimeProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.last_edited_time,
    encode: () =>
      shouldNeverHappen(
        'LastEditedTime.raw encode is not supported (last_edited_time is read-only).',
      ),
  }),

  /** Transform to Date object. */
  asDate: Schema.transform(LastEditedTimeProperty, Schema.DateFromSelf, {
    strict: false,
    decode: (prop) => new Date(prop.last_edited_time),
    encode: () =>
      shouldNeverHappen(
        'LastEditedTime.asDate encode is not supported (last_edited_time is read-only).',
      ),
  }),
} as const

// -----------------------------------------------------------------------------
// Last Edited By Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Last edited by property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#last-edited-by
 */
export const LastEditedByProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('last_edited_by').annotations({
    description: 'Property type identifier.',
  }),
  last_edited_by: PartialUser.annotations({
    description: 'The user who last edited the page.',
  }),
}).annotations({
  identifier: 'Notion.LastEditedByProperty',
  title: 'Last Edited By Property',
  description: 'The user who last edited the page (read-only).',
  [docsPath]: 'property-value-object#last-edited-by',
})

export type LastEditedByProperty = typeof LastEditedByProperty.Type

/** Transforms for LastEditedBy property. */
export const LastEditedBy = {
  /** The raw LastEditedByProperty schema. */
  Property: LastEditedByProperty,

  /** Transform to raw PartialUser. */
  raw: Schema.transform(LastEditedByProperty, PartialUser, {
    strict: false,
    decode: (prop) => prop.last_edited_by,
    encode: () =>
      shouldNeverHappen('LastEditedBy.raw encode is not supported (last_edited_by is read-only).'),
  }),

  /** Transform to user ID. */
  asId: Schema.transform(LastEditedByProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.last_edited_by.id,
    encode: () =>
      shouldNeverHappen('LastEditedBy.asId encode is not supported (last_edited_by is read-only).'),
  }),
} as const

// -----------------------------------------------------------------------------
// Unique ID Property (Read-only)
// -----------------------------------------------------------------------------

/**
 * Unique ID property value from the Notion API (read-only).
 *
 * @see https://developers.notion.com/reference/property-value-object#unique-id
 */
export const UniqueIdProperty = Schema.Struct({
  id: Schema.String.annotations({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('unique_id').annotations({
    description: 'Property type identifier.',
  }),
  unique_id: Schema.Struct({
    prefix: Schema.NullOr(Schema.String).annotations({
      description: 'Optional text prefix for the ID.',
      examples: ['TASK', 'BUG'],
    }),
    number: Schema.Number.annotations({
      description: 'Auto-incrementing number.',
      examples: [1, 42, 100],
    }),
  }).annotations({
    description: 'The unique ID value.',
  }),
}).annotations({
  identifier: 'Notion.UniqueIdProperty',
  title: 'Unique ID Property',
  description: 'An auto-incrementing unique ID (read-only).',
  [docsPath]: 'property-value-object#unique-id',
})

export type UniqueIdProperty = typeof UniqueIdProperty.Type

/** Transforms for UniqueId property. */
export const UniqueId = {
  /** The raw UniqueIdProperty schema. */
  Property: UniqueIdProperty,

  /** Transform to formatted string (e.g., "TASK-42"). */
  asString: Schema.transform(UniqueIdProperty, Schema.String, {
    strict: false,
    decode: (prop) => {
      const { prefix, number } = prop.unique_id
      return prefix ? `${prefix}-${number}` : String(number)
    },
    encode: () =>
      shouldNeverHappen('UniqueId.asString encode is not supported (unique_id is read-only).'),
  }),

  /** Transform to just the number. */
  asNumber: Schema.transform(UniqueIdProperty, Schema.Number, {
    strict: false,
    decode: (prop) => prop.unique_id.number,
    encode: () =>
      shouldNeverHappen('UniqueId.asNumber encode is not supported (unique_id is read-only).'),
  }),
} as const
