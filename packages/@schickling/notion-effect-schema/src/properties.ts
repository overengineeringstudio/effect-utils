import { Option, Schema } from 'effect'
import { docsPath, NotionUUID, SelectColor } from './common.ts'
import { RichText, RichTextArray } from './rich-text.ts'
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
  title: Schema.NonEmptyArray(RichText).annotations({
    description: 'Title content as rich text array.',
  }),
}).annotations({
  identifier: 'Notion.TitleProperty',
  title: 'Title Property',
  description: 'The title property of a Notion page.',
  [docsPath]: 'property-value-object#title',
})

export type TitleProperty = typeof TitleProperty.Type

/** Transforms for Title property. */
export const Title = {
  /** The raw TitleProperty schema. */
  Property: TitleProperty,

  /** Transform to raw rich text array. */
  raw: Schema.transform(TitleProperty, RichTextArray, {
    strict: false,
    decode: (prop) => prop.title,
    encode: (title) => ({
      id: 'title',
      type: 'title' as const,
      title:
        title.length > 0
          ? (title as [RichText, ...RichText[]])
          : [
              {
                type: 'text' as const,
                text: { content: '', link: null },
                annotations: {
                  bold: false,
                  italic: false,
                  strikethrough: false,
                  underline: false,
                  code: false,
                  color: 'default' as const,
                },
                plain_text: '',
                href: null,
              },
            ],
    }),
  }),

  /** Transform to plain string. */
  asString: Schema.transform(TitleProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.title.map((rt) => rt.plain_text).join(''),
    encode: (str) => ({
      id: 'title',
      type: 'title' as const,
      title: [
        {
          type: 'text' as const,
          text: { content: str, link: null },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default' as const,
          },
          plain_text: str,
          href: null,
        },
      ],
    }),
  }),
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

/** Transforms for RichText property. */
export const RichTextProp = {
  /** The raw RichTextProperty schema. */
  Property: RichTextProperty,

  /** Transform to raw rich text array. */
  raw: Schema.transform(RichTextProperty, RichTextArray, {
    strict: false,
    decode: (prop) => prop.rich_text,
    encode: (richText) => ({
      id: 'rich_text',
      type: 'rich_text' as const,
      rich_text: richText,
    }),
  }),

  /** Transform to plain string. */
  asString: Schema.transform(RichTextProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.rich_text.map((rt) => rt.plain_text).join(''),
    encode: (str) => ({
      id: 'rich_text',
      type: 'rich_text' as const,
      rich_text: [
        {
          type: 'text' as const,
          text: { content: str, link: null },
          annotations: {
            bold: false,
            italic: false,
            strikethrough: false,
            underline: false,
            code: false,
            color: 'default' as const,
          },
          plain_text: str,
          href: null,
        },
      ],
    }),
  }),

  /** Transform to Option<string> (empty becomes None). */
  asOption: Schema.transform(RichTextProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => {
      const text = prop.rich_text.map((rt) => rt.plain_text).join('')
      return text.trim() === '' ? Option.none() : Option.some(text)
    },
    encode: (opt) => ({
      id: 'rich_text',
      type: 'rich_text' as const,
      rich_text: Option.match(opt, {
        onNone: () => [],
        onSome: (str) => [
          {
            type: 'text' as const,
            text: { content: str, link: null },
            annotations: {
              bold: false,
              italic: false,
              strikethrough: false,
              underline: false,
              code: false,
              color: 'default' as const,
            },
            plain_text: str,
            href: null,
          },
        ],
      }),
    }),
  }),
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

/** Transforms for Number property. */
export const Num = {
  /** The raw NumberProperty schema. */
  Property: NumberProperty,

  /** Transform to raw nullable number. */
  raw: Schema.transform(NumberProperty, Schema.NullOr(Schema.Number), {
    strict: false,
    decode: (prop) => prop.number,
    encode: (num) => ({
      id: 'number',
      type: 'number' as const,
      number: num,
    }),
  }),

  /** Transform to Option<number>. */
  asOption: Schema.transform(NumberProperty, Schema.OptionFromSelf(Schema.Number), {
    strict: false,
    decode: (prop) => (prop.number === null ? Option.none() : Option.some(prop.number)),
    encode: (opt) => ({
      id: 'number',
      type: 'number' as const,
      number: Option.getOrNull(opt),
    }),
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
      encode: (num) => ({
        id: 'number',
        type: 'number' as const,
        number: num,
      }),
    },
  ),
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

/** Transforms for Checkbox property. */
export const Checkbox = {
  /** The raw CheckboxProperty schema. */
  Property: CheckboxProperty,

  /** Transform to raw boolean. */
  raw: Schema.transform(CheckboxProperty, Schema.Boolean, {
    strict: false,
    decode: (prop) => prop.checkbox,
    encode: (checked) => ({
      id: 'checkbox',
      type: 'checkbox' as const,
      checkbox: checked,
    }),
  }),

  /** Alias for raw (checkbox is always boolean). */
  asBoolean: Schema.transform(CheckboxProperty, Schema.Boolean, {
    strict: false,
    decode: (prop) => prop.checkbox,
    encode: (checked) => ({
      id: 'checkbox',
      type: 'checkbox' as const,
      checkbox: checked,
    }),
  }),
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

/** Transforms for Select property. */
export const Select = {
  /** The raw SelectProperty schema. */
  Property: SelectProperty,

  /** Transform to raw nullable SelectOption. */
  raw: Schema.transform(SelectProperty, Schema.NullOr(SelectOption), {
    strict: false,
    decode: (prop) => prop.select,
    encode: (opt) => ({
      id: 'select',
      type: 'select' as const,
      select: opt,
    }),
  }),

  /** Transform to Option<SelectOption>. */
  asOption: Schema.transform(SelectProperty, Schema.OptionFromSelf(SelectOption), {
    strict: false,
    decode: (prop) => (prop.select === null ? Option.none() : Option.some(prop.select)),
    encode: (opt) => ({
      id: 'select',
      type: 'select' as const,
      select: Option.getOrNull(opt),
    }),
  }),

  /** Transform to Option<string> (option name). */
  asString: Schema.transform(SelectProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.select === null ? Option.none() : Option.some(prop.select.name)),
    encode: (opt) => ({
      id: 'select',
      type: 'select' as const,
      select: Option.match(opt, {
        onNone: () => null,
        onSome: (name) => ({ id: '', name, color: 'default' as const }),
      }),
    }),
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
      encode: (name) => ({
        id: 'select',
        type: 'select' as const,
        select: { id: '', name, color: 'default' as const },
      }),
    },
  ),
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

/** Transforms for MultiSelect property. */
export const MultiSelect = {
  /** The raw MultiSelectProperty schema. */
  Property: MultiSelectProperty,

  /** Transform to raw array of SelectOptions. */
  raw: Schema.transform(MultiSelectProperty, Schema.Array(SelectOption), {
    strict: false,
    decode: (prop) => prop.multi_select,
    encode: (options) => ({
      id: 'multi_select',
      type: 'multi_select' as const,
      multi_select: options,
    }),
  }),

  /** Transform to array of option names. */
  asStrings: Schema.transform(MultiSelectProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.multi_select.map((opt) => opt.name),
    encode: (names) => ({
      id: 'multi_select',
      type: 'multi_select' as const,
      multi_select: names.map((name) => ({ id: '', name, color: 'default' as const })),
    }),
  }),
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

/** Transforms for Status property. */
export const Status = {
  /** The raw StatusProperty schema. */
  Property: StatusProperty,

  /** Transform to raw nullable SelectOption. */
  raw: Schema.transform(StatusProperty, Schema.NullOr(SelectOption), {
    strict: false,
    decode: (prop) => prop.status,
    encode: (opt) => ({
      id: 'status',
      type: 'status' as const,
      status: opt,
    }),
  }),

  /** Transform to Option<string> (status name). */
  asString: Schema.transform(StatusProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.status === null ? Option.none() : Option.some(prop.status.name)),
    encode: (opt) => ({
      id: 'status',
      type: 'status' as const,
      status: Option.match(opt, {
        onNone: () => null,
        onSome: (name) => ({ id: '', name, color: 'default' as const }),
      }),
    }),
  }),
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

/** Transforms for Date property. */
export const DateProp = {
  /** The raw DateProperty schema. */
  Property: DateProperty,

  /** Transform to raw nullable DateValue. */
  raw: Schema.transform(DateProperty, Schema.NullOr(DateValue), {
    strict: false,
    decode: (prop) => prop.date,
    encode: (date) => ({
      id: 'date',
      type: 'date' as const,
      date,
    }),
  }),

  /** Transform to Option<DateValue>. */
  asOption: Schema.transform(DateProperty, Schema.OptionFromSelf(DateValue), {
    strict: false,
    decode: (prop) => (prop.date === null ? Option.none() : Option.some(prop.date)),
    encode: (opt) => ({
      id: 'date',
      type: 'date' as const,
      date: Option.getOrNull(opt),
    }),
  }),

  /** Transform to Option<Date> (start date only, parsed). */
  asDate: Schema.transform(DateProperty, Schema.OptionFromSelf(Schema.DateFromSelf), {
    strict: false,
    decode: (prop) => (prop.date === null ? Option.none() : Option.some(new Date(prop.date.start))),
    encode: (opt) => ({
      id: 'date',
      type: 'date' as const,
      date: Option.match(opt, {
        onNone: () => null,
        onSome: (d) => ({ start: d.toISOString(), end: null, time_zone: null }),
      }),
    }),
  }),
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

/** Transforms for URL property. */
export const Url = {
  /** The raw UrlProperty schema. */
  Property: UrlProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(UrlProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.url,
    encode: (url) => ({
      id: 'url',
      type: 'url' as const,
      url,
    }),
  }),

  /** Transform to Option<string>. */
  asOption: Schema.transform(UrlProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.url === null ? Option.none() : Option.some(prop.url)),
    encode: (opt) => ({
      id: 'url',
      type: 'url' as const,
      url: Option.getOrNull(opt),
    }),
  }),
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

/** Transforms for Email property. */
export const Email = {
  /** The raw EmailProperty schema. */
  Property: EmailProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(EmailProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.email,
    encode: (email) => ({
      id: 'email',
      type: 'email' as const,
      email,
    }),
  }),

  /** Transform to Option<string>. */
  asOption: Schema.transform(EmailProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.email === null ? Option.none() : Option.some(prop.email)),
    encode: (opt) => ({
      id: 'email',
      type: 'email' as const,
      email: Option.getOrNull(opt),
    }),
  }),
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

/** Transforms for PhoneNumber property. */
export const PhoneNumber = {
  /** The raw PhoneNumberProperty schema. */
  Property: PhoneNumberProperty,

  /** Transform to raw nullable string. */
  raw: Schema.transform(PhoneNumberProperty, Schema.NullOr(Schema.String), {
    strict: false,
    decode: (prop) => prop.phone_number,
    encode: (phone) => ({
      id: 'phone_number',
      type: 'phone_number' as const,
      phone_number: phone,
    }),
  }),

  /** Transform to Option<string>. */
  asOption: Schema.transform(PhoneNumberProperty, Schema.OptionFromSelf(Schema.String), {
    strict: false,
    decode: (prop) => (prop.phone_number === null ? Option.none() : Option.some(prop.phone_number)),
    encode: (opt) => ({
      id: 'phone_number',
      type: 'phone_number' as const,
      phone_number: Option.getOrNull(opt),
    }),
  }),
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

/** Transforms for People property. */
export const People = {
  /** The raw PeopleProperty schema. */
  Property: PeopleProperty,

  /** Transform to raw array of Users. */
  raw: Schema.transform(PeopleProperty, Schema.Array(User), {
    strict: false,
    decode: (prop) => prop.people,
    encode: (users) => ({
      id: 'people',
      type: 'people' as const,
      people: users,
    }),
  }),

  /** Transform to array of user IDs. */
  asIds: Schema.transform(PeopleProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.people.map((u) => u.id),
    encode: (ids) => ({
      id: 'people',
      type: 'people' as const,
      people: ids.map((id) => ({
        object: 'user' as const,
        id,
      })) as User[],
    }),
  }),
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

/** Transforms for Relation property. */
export const Relation = {
  /** The raw RelationProperty schema. */
  Property: RelationProperty,

  /** Transform to array of page IDs. */
  asIds: Schema.transform(RelationProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.relation.map((r) => r.id),
    encode: (ids) => ({
      id: 'relation',
      type: 'relation' as const,
      relation: ids.map((id) => ({ id })),
    }),
  }),
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

/** Transforms for Files property. */
export const Files = {
  /** The raw FilesProperty schema. */
  Property: FilesProperty,

  /** Transform to raw array of FileObjects. */
  raw: Schema.transform(FilesProperty, Schema.Array(FileObject), {
    strict: false,
    decode: (prop) => prop.files,
    encode: (files) => ({
      id: 'files',
      type: 'files' as const,
      files,
    }),
  }),

  /** Transform to array of URLs. */
  asUrls: Schema.transform(FilesProperty, Schema.Array(Schema.String), {
    strict: false,
    decode: (prop) => prop.files.map((f) => (f.type === 'external' ? f.external.url : f.file.url)),
    encode: (urls) => ({
      id: 'files',
      type: 'files' as const,
      files: urls.map((url) => ({
        type: 'external' as const,
        name: url.split('/').pop() ?? 'file',
        external: { url },
      })),
    }),
  }),
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
    encode: (formula) => ({
      id: 'formula',
      type: 'formula' as const,
      formula,
    }),
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
    encode: (time) => ({
      id: 'created_time',
      type: 'created_time' as const,
      created_time: time,
    }),
  }),

  /** Transform to Date object. */
  asDate: Schema.transform(CreatedTimeProperty, Schema.DateFromSelf, {
    strict: false,
    decode: (prop) => new Date(prop.created_time),
    encode: (date) => ({
      id: 'created_time',
      type: 'created_time' as const,
      created_time: date.toISOString(),
    }),
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
    encode: (user) => ({
      id: 'created_by',
      type: 'created_by' as const,
      created_by: user,
    }),
  }),

  /** Transform to user ID. */
  asId: Schema.transform(CreatedByProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.created_by.id,
    encode: (id) => ({
      id: 'created_by',
      type: 'created_by' as const,
      created_by: { object: 'user' as const, id },
    }),
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
    encode: (time) => ({
      id: 'last_edited_time',
      type: 'last_edited_time' as const,
      last_edited_time: time,
    }),
  }),

  /** Transform to Date object. */
  asDate: Schema.transform(LastEditedTimeProperty, Schema.DateFromSelf, {
    strict: false,
    decode: (prop) => new Date(prop.last_edited_time),
    encode: (date) => ({
      id: 'last_edited_time',
      type: 'last_edited_time' as const,
      last_edited_time: date.toISOString(),
    }),
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
    encode: (user) => ({
      id: 'last_edited_by',
      type: 'last_edited_by' as const,
      last_edited_by: user,
    }),
  }),

  /** Transform to user ID. */
  asId: Schema.transform(LastEditedByProperty, Schema.String, {
    strict: false,
    decode: (prop) => prop.last_edited_by.id,
    encode: (id) => ({
      id: 'last_edited_by',
      type: 'last_edited_by' as const,
      last_edited_by: { object: 'user' as const, id },
    }),
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
    encode: (str) => {
      const match = str.match(/^([A-Z]+)-(\d+)$/)
      if (match?.[1] && match[2]) {
        return {
          id: 'unique_id',
          type: 'unique_id' as const,
          unique_id: { prefix: match[1], number: parseInt(match[2], 10) },
        }
      }
      return {
        id: 'unique_id',
        type: 'unique_id' as const,
        unique_id: { prefix: null, number: parseInt(str, 10) },
      }
    },
  }),

  /** Transform to just the number. */
  asNumber: Schema.transform(UniqueIdProperty, Schema.Number, {
    strict: false,
    decode: (prop) => prop.unique_id.number,
    encode: (num) => ({
      id: 'unique_id',
      type: 'unique_id' as const,
      unique_id: { prefix: null, number: num },
    }),
  }),
} as const
