import { Option, Schema, SchemaTransformation } from 'effect'

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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('title').annotate({
    description: 'Property type identifier.',
  }),
  title: Schema.Array(RichText).annotate({
    description: 'Title content as rich text array.',
  }),
}).annotate({
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
}).annotate({
  identifier: 'Notion.TitleWrite',
  title: 'Title (Write)',
  description: 'Write payload for a title property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type TitleWrite = typeof TitleWrite.Type

/** Transforms plain string into a title write payload */
export const TitleWriteFromString = Schema.String.pipe(
  Schema.decodeTo(
    TitleWrite,
    SchemaTransformation.transform({
      decode: (str) => ({
        title: [{ type: 'text', text: { content: str } }],
      }),
      encode: (write) => write.title.map((rt) => rt.text.content).join(''),
    }),
  ),
).annotate({
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
  raw: TitleProperty.pipe(
    Schema.decodeTo(
      RichTextArray,
      SchemaTransformation.transform({
        decode: (prop) => prop.title,
        encode: () =>
          shouldNeverHappen(
            'Title.raw encode is not supported. Use TitleWrite / TitleWriteFromString.',
          ),
      }),
    ),
  ),

  /** Transform to plain string. */
  asString: TitleProperty.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (prop) => prop.title.map((rt) => rt.plain_text).join(''),
        encode: () =>
          shouldNeverHappen(
            'Title.asString encode is not supported. Use TitleWrite / TitleWriteFromString.',
          ),
      }),
    ),
  ),

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
  id: Schema.String.annotate({
    description: 'Property identifier.',
  }),
  type: Schema.Literal('rich_text').annotate({
    description: 'Property type identifier.',
  }),
  rich_text: RichTextArray.annotate({
    description: 'Content as rich text array.',
  }),
}).annotate({
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
}).annotate({
  identifier: 'Notion.RichTextWrite',
  title: 'Rich Text (Write)',
  description: 'Write payload for a rich text property (used in page create/update).',
  [docsPath]: 'page#page-property-value',
})

export type RichTextWrite = typeof RichTextWrite.Type

/** Transforms plain string into a rich text write payload */
export const RichTextWriteFromString = Schema.String.pipe(
  Schema.decodeTo(
    RichTextWrite,
    SchemaTransformation.transform({
      decode: (str) => ({
        rich_text: [{ type: 'text', text: { content: str } }],
      }),
      encode: (write) => write.rich_text.map((rt) => rt.text.content).join(''),
    }),
  ),
).annotate({
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
  raw: RichTextProperty.pipe(
    Schema.decodeTo(
      RichTextArray,
      SchemaTransformation.transform({
        decode: (prop) => prop.rich_text,
        encode: () =>
          shouldNeverHappen(
            'RichTextProp.raw encode is not supported. Use RichTextWrite / RichTextWriteFromString.',
          ),
      }),
    ),
  ),

  /** Transform to plain string. */
  asString: RichTextProperty.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (prop) => prop.rich_text.map((rt) => rt.plain_text).join(''),
        encode: () =>
          shouldNeverHappen(
            'RichTextProp.asString encode is not supported. Use RichTextWrite / RichTextWriteFromString.',
          ),
      }),
    ),
  ),

  /** Transform to required string (fails if empty after trim). */
  asNonEmptyString: RichTextProperty.pipe(
    Schema.check(
      Schema.makeFilter(
        (p) =>
          p.rich_text
            .map((rt) => rt.plain_text)
            .join('')
            .trim() !== '',
        { message: () => 'Rich text must not be empty' },
      ),
    ),
  ).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (prop) => prop.rich_text.map((rt) => rt.plain_text).join(''),
        encode: () =>
          shouldNeverHappen(
            'RichTextProp.asNonEmptyString encode is not supported. Use RichTextWrite / RichTextWriteFromString.',
          ),
      }),
    ),
  ),

  /** Transform to Option<string> (empty becomes None). */
  asOption: withOptionValueSchema({
    schema: RichTextProperty.pipe(
      Schema.decodeTo(
        Schema.Option(Schema.String),
        SchemaTransformation.transform({
          decode: (prop) => {
            const text = prop.rich_text.map((rt) => rt.plain_text).join('')
            return text.trim() === '' ? Option.none() : Option.some(text)
          },
          encode: () =>
            shouldNeverHappen(
              'RichTextProp.asOption encode is not supported. Use RichTextWrite / RichTextWriteFromString.',
            ),
        }),
      ),
    ),
    valueSchema: Schema.String,
  }),

  Write: {
    Schema: RichTextWrite,
    fromString: RichTextWriteFromString,
  },
} as const
