import { Option, Schema } from 'effect'

import { docsPath, shouldNeverHappen } from '../common.ts'
import { SelectOption, SelectOptionWrite } from './common.ts'

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
