/**
 * Utilities for converting Notion rich text arrays to different output formats.
 *
 * @see https://developers.notion.com/reference/rich-text
 * @module
 */

import { richTextPlainText as richTextPlainTextCore } from '@overeng/notion-core'

import type {
  EquationRichText,
  MentionRichText,
  RichText,
  RichTextArray,
  TextAnnotations,
  TextRichText,
} from './rich-text.ts'

// -----------------------------------------------------------------------------
// Plain Text Conversion
// -----------------------------------------------------------------------------

/**
 * Convert a rich text array to plain text.
 *
 * Simply concatenates the `plain_text` property of each rich text element.
 *
 * @example
 * ```ts
 * import { RichText } from '@overeng/notion-effect-schema'
 *
 * const text = RichText.toPlainText(richTextArray)
 * // "Hello world"
 * ```
 */
export const toPlainText = (richText: RichTextArray): string =>
  richText.map((rt) => rt.plain_text).join('')

/**
 * Plain-text extraction over an *untyped* Notion rich-text array.
 *
 * Unlike {@link toPlainText}, this tolerates raw `unknown[]` payloads (as
 * received directly from the Notion API before decoding) and treats any element
 * without a `plain_text` field as the empty string. Used by the canonical codec.
 */
export const richTextPlainText = (value: readonly unknown[]): string => richTextPlainTextCore(value)

// -----------------------------------------------------------------------------
// Annotation Ordering
// -----------------------------------------------------------------------------

/**
 * A single annotation wrapping step. `active` decides whether the step applies;
 * `wrap` nests the accumulated result one level outward. Steps are applied in
 * order, so the first active step ends up innermost.
 */
type AnnotationStep = { readonly active: boolean; readonly wrap: (inner: string) => string }

/**
 * Shared annotation-ordering combinator for the markdown and html targets.
 *
 * Both targets share the same structure — conditionally nest formatting from
 * innermost to outermost — but differ in their wrappers and ordering. Each
 * target expresses itself as an ordered list of {@link AnnotationStep}s.
 */
const applyAnnotations = (opts: { text: string; steps: readonly AnnotationStep[] }): string => {
  const { text, steps } = opts
  if (text === '') return text
  return steps.reduce((result, step) => (step.active === true ? step.wrap(result) : result), text)
}

// -----------------------------------------------------------------------------
// Markdown Conversion
// -----------------------------------------------------------------------------

/** Apply markdown formatting based on annotations */
const applyMarkdownAnnotations = (opts: { text: string; annotations: TextAnnotations }): string => {
  const { text, annotations } = opts
  return applyAnnotations({
    text,
    steps: [
      { active: annotations.code, wrap: (s) => `\`${s}\`` },
      { active: annotations.strikethrough, wrap: (s) => `~~${s}~~` },
      { active: annotations.italic, wrap: (s) => `*${s}*` },
      { active: annotations.bold, wrap: (s) => `**${s}**` },
      // Markdown has no native underline; fall back to HTML.
      { active: annotations.underline, wrap: (s) => `<u>${s}</u>` },
    ],
  })
}

/** Convert a single text rich text element to markdown */
const textRichTextToMarkdown = (rt: TextRichText): string => {
  let text = applyMarkdownAnnotations({
    text: rt.plain_text,
    annotations: rt.annotations,
  })

  // Apply link if present
  if (rt.href !== null) {
    text = `[${text}](${rt.href})`
  }

  return text
}

/** Convert a single mention rich text element to markdown */
const mentionRichTextToMarkdown = (rt: MentionRichText): string => {
  const mention = rt.mention

  switch (mention.type) {
    case 'user':
      return `@${rt.plain_text}`

    case 'page':
      return rt.href !== null ? `[${rt.plain_text}](${rt.href})` : rt.plain_text

    case 'database':
      return rt.href !== null ? `[${rt.plain_text}](${rt.href})` : rt.plain_text

    case 'date': {
      const { start, end } = mention.date
      return end !== null ? `${start} → ${end}` : start
    }

    case 'link_preview':
      return `[${rt.plain_text}](${mention.link_preview.url})`

    case 'template_mention': {
      const tm = mention.template_mention
      if (tm.type === 'template_mention_date') {
        return `@${tm.template_mention_date}`
      }
      return '@me'
    }

    default:
      return rt.plain_text
  }
}

/** Convert a single equation rich text element to markdown */
const equationRichTextToMarkdown = (rt: EquationRichText): string => {
  return `$${rt.equation.expression}$`
}

/** Convert a single rich text element to markdown */
const richTextElementToMarkdown = (rt: RichText): string => {
  switch (rt.type) {
    case 'text':
      return textRichTextToMarkdown(rt)
    case 'mention':
      return mentionRichTextToMarkdown(rt)
    case 'equation':
      return equationRichTextToMarkdown(rt)
  }
}

/**
 * Convert a rich text array to Markdown.
 *
 * Handles all annotation types, links, mentions, and equations.
 *
 * @example
 * ```ts
 * import { RichText } from '@overeng/notion-effect-schema'
 *
 * const markdown = RichText.toMarkdown(richTextArray)
 * // "**Hello** *world*"
 * ```
 */
export const toMarkdown = (richText: RichTextArray): string =>
  richText.map(richTextElementToMarkdown).join('')

// -----------------------------------------------------------------------------
// HTML Conversion
// -----------------------------------------------------------------------------

/** Escape HTML special characters */
const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')

/** Get CSS color value from Notion color */
const getColorStyle = (color: TextAnnotations['color']): string | undefined => {
  if (color === 'default') return undefined

  // Background colors
  if (color.endsWith('_background') === true) {
    const baseColor = color.replace('_background', '')
    return `background-color: var(--notion-${baseColor}-background, ${baseColor})`
  }

  // Text colors
  return `color: var(--notion-${color}, ${color})`
}

/** Apply HTML formatting based on annotations */
const applyHtmlAnnotations = (opts: { text: string; annotations: TextAnnotations }): string => {
  const { text, annotations } = opts
  const colorStyle = getColorStyle(annotations.color)
  return applyAnnotations({
    text,
    steps: [
      { active: annotations.code, wrap: (s) => `<code>${s}</code>` },
      { active: annotations.strikethrough, wrap: (s) => `<del>${s}</del>` },
      { active: annotations.underline, wrap: (s) => `<u>${s}</u>` },
      { active: annotations.italic, wrap: (s) => `<em>${s}</em>` },
      { active: annotations.bold, wrap: (s) => `<strong>${s}</strong>` },
      { active: colorStyle !== undefined, wrap: (s) => `<span style="${colorStyle}">${s}</span>` },
    ],
  })
}

/** Convert a single text rich text element to HTML */
const textRichTextToHtml = (rt: TextRichText): string => {
  const escapedText = escapeHtml(rt.plain_text)
  let html = applyHtmlAnnotations({
    text: escapedText,
    annotations: rt.annotations,
  })

  // Apply link if present
  if (rt.href !== null) {
    html = `<a href="${escapeHtml(rt.href)}">${html}</a>`
  }

  return html
}

/** Convert a single mention rich text element to HTML */
const mentionRichTextToHtml = (rt: MentionRichText): string => {
  const mention = rt.mention
  const escapedText = escapeHtml(rt.plain_text)

  switch (mention.type) {
    case 'user':
      return `<span class="notion-mention notion-mention-user" data-user-id="${mention.user.id}">@${escapedText}</span>`

    case 'page':
      if (rt.href !== null) {
        return `<a href="${escapeHtml(rt.href)}" class="notion-mention notion-mention-page" data-page-id="${mention.page.id}">${escapedText}</a>`
      }
      return `<span class="notion-mention notion-mention-page" data-page-id="${mention.page.id}">${escapedText}</span>`

    case 'database':
      if (rt.href !== null) {
        return `<a href="${escapeHtml(rt.href)}" class="notion-mention notion-mention-database" data-database-id="${mention.database.id}">${escapedText}</a>`
      }
      return `<span class="notion-mention notion-mention-database" data-database-id="${mention.database.id}">${escapedText}</span>`

    case 'date': {
      const { start, end } = mention.date
      const dateText = end !== null ? `${start} → ${end}` : start
      return `<time class="notion-mention notion-mention-date" datetime="${start}">${escapeHtml(dateText)}</time>`
    }

    case 'link_preview':
      return `<a href="${escapeHtml(mention.link_preview.url)}" class="notion-mention notion-mention-link-preview">${escapedText}</a>`

    case 'template_mention': {
      const tm = mention.template_mention
      if (tm.type === 'template_mention_date') {
        return `<span class="notion-mention notion-mention-template-date">@${tm.template_mention_date}</span>`
      }
      return '<span class="notion-mention notion-mention-template-user">@me</span>'
    }

    default:
      return escapedText
  }
}

/** Convert a single equation rich text element to HTML */
const equationRichTextToHtml = (rt: EquationRichText): string => {
  const escapedExpression = escapeHtml(rt.equation.expression)
  return `<span class="notion-equation" data-equation="${escapedExpression}">${escapedExpression}</span>`
}

/** Convert a single rich text element to HTML */
const richTextElementToHtml = (rt: RichText): string => {
  switch (rt.type) {
    case 'text':
      return textRichTextToHtml(rt)
    case 'mention':
      return mentionRichTextToHtml(rt)
    case 'equation':
      return equationRichTextToHtml(rt)
  }
}

/**
 * Convert a rich text array to HTML.
 *
 * Handles all annotation types, links, mentions, equations, and colors.
 * Uses semantic HTML elements where appropriate.
 *
 * @example
 * ```ts
 * import { RichText } from '@overeng/notion-effect-schema'
 *
 * const html = RichText.toHtml(richTextArray)
 * // "<strong>Hello</strong> <em>world</em>"
 * ```
 */
export const toHtml = (richText: RichTextArray): string =>
  richText.map(richTextElementToHtml).join('')

// -----------------------------------------------------------------------------
// Rich Text Namespace
// -----------------------------------------------------------------------------

/**
 * Rich Text utility functions for converting Notion rich text to various formats.
 *
 * @example
 * ```ts
 * import { RichText } from '@overeng/notion-effect-schema'
 *
 * // Convert to plain text
 * RichText.toPlainText(richTextArray) // "Hello world"
 *
 * // Convert to Markdown
 * RichText.toMarkdown(richTextArray) // "**Hello** *world*"
 *
 * // Convert to HTML
 * RichText.toHtml(richTextArray) // "<strong>Hello</strong> <em>world</em>"
 * ```
 */
export const RichTextUtils = {
  toPlainText,
  richTextPlainText,
  toMarkdown,
  toHtml,
} as const
