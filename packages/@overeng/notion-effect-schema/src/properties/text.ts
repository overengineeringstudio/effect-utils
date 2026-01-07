import { Option, Schema } from 'effect'

import { docsPath, shouldNeverHappen, withOptionValueSchema } from '../common.ts'
import { RichText, RichTextArray } from '../rich-text.ts'
import { TextRichTextWrite } from './common.ts'

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

  /** Transform to required string (fails if empty after trim). */
  asNonEmptyString: Schema.transform(
    RichTextProperty.pipe(
      Schema.filter(
        (p) =>
          p.rich_text
            .map((rt) => rt.plain_text)
            .join('')
            .trim() !== '',
        { message: () => 'Rich text must not be empty' },
      ),
    ),
    Schema.String,
    {
      strict: false,
      decode: (prop) => prop.rich_text.map((rt) => rt.plain_text).join(''),
      encode: () =>
        shouldNeverHappen(
          'RichTextProp.asNonEmptyString encode is not supported. Use RichTextWrite / RichTextWriteFromString.',
        ),
    },
  ),

  /** Transform to Option<string> (empty becomes None). */
  asOption: withOptionValueSchema({
    schema: Schema.transform(RichTextProperty, Schema.OptionFromSelf(Schema.String), {
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
    valueSchema: Schema.String,
  }),

  Write: {
    Schema: RichTextWrite,
    fromString: RichTextWriteFromString,
  },
} as const
