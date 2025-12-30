import { Schema } from 'effect'
import { docsPath, shouldNeverHappen } from '../common.ts'

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
