import { Schema } from 'effect'

import { docsPath, NotionColor, NotionUUID } from './common.ts'

// -----------------------------------------------------------------------------
// Text Annotations
// -----------------------------------------------------------------------------

/**
 * Styling annotations for rich text content.
 *
 * @see https://developers.notion.com/reference/rich-text#the-annotation-object
 */
export const TextAnnotations = Schema.Struct({
  bold: Schema.Boolean.annotations({
    description: 'Whether the text is bolded.',
  }),
  italic: Schema.Boolean.annotations({
    description: 'Whether the text is italicized.',
  }),
  strikethrough: Schema.Boolean.annotations({
    description: 'Whether the text has a strikethrough.',
  }),
  underline: Schema.Boolean.annotations({
    description: 'Whether the text is underlined.',
  }),
  code: Schema.Boolean.annotations({
    description: 'Whether the text is formatted as inline code.',
  }),
  color: NotionColor.annotations({
    description: 'Color of the text or background.',
  }),
}).annotations({
  identifier: 'Notion.TextAnnotations',
  title: 'Text Annotations',
  description: 'Styling properties applied to rich text content.',
  [docsPath]: 'rich-text#the-annotation-object',
})

export type TextAnnotations = typeof TextAnnotations.Type

// -----------------------------------------------------------------------------
// Rich Text Types
// -----------------------------------------------------------------------------

/**
 * Link object for text content.
 */
export const TextLink = Schema.Struct({
  url: Schema.String.annotations({
    description: 'The URL the text links to.',
    examples: ['https://example.com'],
  }),
}).annotations({
  identifier: 'Notion.TextLink',
  title: 'Text Link',
  description: 'A hyperlink associated with text content.',
  [docsPath]: 'rich-text#text',
})

export type TextLink = typeof TextLink.Type

/**
 * Text-type rich text content.
 *
 * @see https://developers.notion.com/reference/rich-text#text
 */
export const TextRichText = Schema.Struct({
  type: Schema.Literal('text').annotations({
    description: 'Type identifier for text rich text.',
  }),
  text: Schema.Struct({
    content: Schema.String.annotations({
      description: 'The actual text content.',
      examples: ['Hello, world!'],
    }),
    link: Schema.NullOr(TextLink).annotations({
      description: 'Optional link for the text.',
    }),
  }),
  annotations: TextAnnotations,
  plain_text: Schema.String.annotations({
    description: 'Plain text without styling.',
  }),
  href: Schema.NullOr(Schema.String).annotations({
    description: 'URL if this text is a link.',
  }),
}).annotations({
  identifier: 'Notion.TextRichText',
  title: 'Text Rich Text',
  description: 'Rich text content of type text.',
  [docsPath]: 'rich-text#text',
})

export type TextRichText = typeof TextRichText.Type

// -----------------------------------------------------------------------------
// Mention Types
// -----------------------------------------------------------------------------

/**
 * Database mention within rich text.
 */
export const DatabaseMention = Schema.Struct({
  type: Schema.Literal('database'),
  database: Schema.Struct({
    id: NotionUUID,
  }),
}).annotations({
  identifier: 'Notion.DatabaseMention',
  title: 'Database Mention',
  description: 'A mention referencing a Notion database.',
  [docsPath]: 'rich-text#mention',
})

export type DatabaseMention = typeof DatabaseMention.Type

/**
 * Page mention within rich text.
 */
export const PageMention = Schema.Struct({
  type: Schema.Literal('page'),
  page: Schema.Struct({
    id: NotionUUID,
  }),
}).annotations({
  identifier: 'Notion.PageMention',
  title: 'Page Mention',
  description: 'A mention referencing a Notion page.',
  [docsPath]: 'rich-text#mention',
})

export type PageMention = typeof PageMention.Type

/**
 * User mention within rich text.
 */
export const UserMention = Schema.Struct({
  type: Schema.Literal('user'),
  user: Schema.Struct({
    object: Schema.Literal('user'),
    id: NotionUUID,
  }),
}).annotations({
  identifier: 'Notion.UserMention',
  title: 'User Mention',
  description: 'A mention referencing a Notion user.',
  [docsPath]: 'rich-text#mention',
})

export type UserMention = typeof UserMention.Type

/**
 * Date mention within rich text.
 */
export const DateMention = Schema.Struct({
  type: Schema.Literal('date'),
  date: Schema.Struct({
    start: Schema.String.annotations({
      description: 'Start date in ISO 8601 format.',
      examples: ['2024-01-15'],
    }),
    end: Schema.NullOr(Schema.String).annotations({
      description: 'Optional end date for date ranges.',
    }),
    time_zone: Schema.NullOr(Schema.String).annotations({
      description: 'Optional IANA time zone.',
      examples: ['America/New_York'],
    }),
  }),
}).annotations({
  identifier: 'Notion.DateMention',
  title: 'Date Mention',
  description: 'A mention referencing a date or date range.',
  [docsPath]: 'rich-text#mention',
})

export type DateMention = typeof DateMention.Type

/**
 * Link preview mention within rich text.
 */
export const LinkPreviewMention = Schema.Struct({
  type: Schema.Literal('link_preview'),
  link_preview: Schema.Struct({
    url: Schema.String.annotations({
      description: 'The URL being previewed.',
      examples: ['https://github.com/example/repo'],
    }),
  }),
}).annotations({
  identifier: 'Notion.LinkPreviewMention',
  title: 'Link Preview Mention',
  description: 'A mention displaying a link preview.',
  [docsPath]: 'rich-text#mention',
})

export type LinkPreviewMention = typeof LinkPreviewMention.Type

/**
 * Template mention date type.
 */
export const TemplateMentionDate = Schema.Struct({
  type: Schema.Literal('template_mention_date'),
  template_mention_date: Schema.Literal('today', 'now'),
}).annotations({
  identifier: 'Notion.TemplateMentionDate',
  title: 'Template Mention Date',
  description: 'A template mention for dynamic dates.',
  [docsPath]: 'rich-text#mention',
})

export type TemplateMentionDate = typeof TemplateMentionDate.Type

/**
 * Template mention user type.
 */
export const TemplateMentionUser = Schema.Struct({
  type: Schema.Literal('template_mention_user'),
  template_mention_user: Schema.Literal('me'),
}).annotations({
  identifier: 'Notion.TemplateMentionUser',
  title: 'Template Mention User',
  description: 'A template mention for the current user.',
  [docsPath]: 'rich-text#mention',
})

export type TemplateMentionUser = typeof TemplateMentionUser.Type

/**
 * Template mention within rich text.
 */
export const TemplateMention = Schema.Struct({
  type: Schema.Literal('template_mention'),
  template_mention: Schema.Union(TemplateMentionDate, TemplateMentionUser),
}).annotations({
  identifier: 'Notion.TemplateMention',
  title: 'Template Mention',
  description: 'A template mention for dynamic content.',
  [docsPath]: 'rich-text#mention',
})

export type TemplateMention = typeof TemplateMention.Type

/**
 * Union of all mention types.
 */
export const MentionContent = Schema.Union(
  DatabaseMention,
  PageMention,
  UserMention,
  DateMention,
  LinkPreviewMention,
  TemplateMention,
).annotations({
  identifier: 'Notion.MentionContent',
  title: 'Mention Content',
  description: 'The content of a mention, varying by mention type.',
  [docsPath]: 'rich-text#mention',
})

export type MentionContent = typeof MentionContent.Type

/**
 * Mention-type rich text content.
 *
 * @see https://developers.notion.com/reference/rich-text#mention
 */
export const MentionRichText = Schema.Struct({
  type: Schema.Literal('mention').annotations({
    description: 'Type identifier for mention rich text.',
  }),
  mention: MentionContent,
  annotations: TextAnnotations,
  plain_text: Schema.String.annotations({
    description: 'Plain text representation of the mention.',
  }),
  href: Schema.NullOr(Schema.String).annotations({
    description: 'URL if this mention links somewhere.',
  }),
}).annotations({
  identifier: 'Notion.MentionRichText',
  title: 'Mention Rich Text',
  description: 'Rich text content containing an inline mention.',
  [docsPath]: 'rich-text#mention',
})

export type MentionRichText = typeof MentionRichText.Type

// -----------------------------------------------------------------------------
// Equation
// -----------------------------------------------------------------------------

/**
 * Equation-type rich text content.
 *
 * @see https://developers.notion.com/reference/rich-text#equation
 */
export const EquationRichText = Schema.Struct({
  type: Schema.Literal('equation').annotations({
    description: 'Type identifier for equation rich text.',
  }),
  equation: Schema.Struct({
    expression: Schema.String.annotations({
      description: 'The LaTeX expression for the equation.',
      examples: ['E = mc^2'],
    }),
  }),
  annotations: TextAnnotations,
  plain_text: Schema.String.annotations({
    description: 'Plain text representation of the equation.',
  }),
  href: Schema.NullOr(Schema.String).annotations({
    description: 'Always null for equations.',
  }),
}).annotations({
  identifier: 'Notion.EquationRichText',
  title: 'Equation Rich Text',
  description: 'Rich text content containing a LaTeX equation.',
  [docsPath]: 'rich-text#equation',
})

export type EquationRichText = typeof EquationRichText.Type

// -----------------------------------------------------------------------------
// Rich Text Union
// -----------------------------------------------------------------------------

/**
 * Rich text content, which can be text, mention, or equation.
 *
 * @see https://developers.notion.com/reference/rich-text
 */
export const RichText = Schema.Union(TextRichText, MentionRichText, EquationRichText).annotations({
  identifier: 'Notion.RichText',
  title: 'Rich Text',
  description: 'Rich text content supporting text, mentions, and equations.',
  [docsPath]: 'rich-text',
})

export type RichText = typeof RichText.Type

/**
 * Array of rich text elements.
 */
export const RichTextArray = Schema.Array(RichText).annotations({
  identifier: 'Notion.RichTextArray',
  title: 'Rich Text Array',
  description: 'An array of rich text elements.',
  [docsPath]: 'rich-text',
})

export type RichTextArray = typeof RichTextArray.Type

// -----------------------------------------------------------------------------
// Rich Text Transforms
// -----------------------------------------------------------------------------

/**
 * Transform rich text array to plain string.
 */
export const RichTextArrayAsString = Schema.transform(RichTextArray, Schema.String, {
  decode: (richText) => richText.map((rt) => rt.plain_text).join(''),
  encode: (str) => [
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
}).annotations({
  identifier: 'Notion.RichTextArrayAsString',
  title: 'Rich Text as String',
  description: 'Transform rich text array to/from plain string.',
  [docsPath]: 'rich-text',
})
