import { Schema } from 'effect'

import { docsPath, NotionUUID, SelectColor } from '../common.ts'
import { TextLink } from '../rich-text.ts'

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
