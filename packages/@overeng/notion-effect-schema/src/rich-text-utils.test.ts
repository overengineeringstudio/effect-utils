import { describe, expect, it } from 'vitest'
import type { RichTextArray } from './rich-text.ts'
import { toHtml, toMarkdown, toPlainText } from './rich-text-utils.ts'

/** Helper to create a text rich text element */
const makeText = (
  content: string,
  options: {
    bold?: boolean
    italic?: boolean
    strikethrough?: boolean
    underline?: boolean
    code?: boolean
    color?: 'default' | string
    href?: string | null
  } = {},
): RichTextArray[number] => ({
  type: 'text',
  text: {
    content,
    link: options.href ? { url: options.href } : null,
  },
  annotations: {
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    strikethrough: options.strikethrough ?? false,
    underline: options.underline ?? false,
    code: options.code ?? false,
    color: (options.color ?? 'default') as 'default',
  },
  plain_text: content,
  href: options.href ?? null,
})

/** Helper to create a mention rich text element */
const makeMention = (
  type: 'user' | 'page' | 'database' | 'date' | 'link_preview',
  data: Record<string, unknown>,
  plainText: string,
  href: string | null = null,
): RichTextArray[number] => {
  const mentionContent = (() => {
    switch (type) {
      case 'user':
        return { type: 'user' as const, user: { object: 'user' as const, id: data.id as string } }
      case 'page':
        return { type: 'page' as const, page: { id: data.id as string } }
      case 'database':
        return { type: 'database' as const, database: { id: data.id as string } }
      case 'date':
        return {
          type: 'date' as const,
          date: {
            start: data.start as string,
            end: (data.end as string) ?? null,
            time_zone: null,
          },
        }
      case 'link_preview':
        return { type: 'link_preview' as const, link_preview: { url: data.url as string } }
    }
  })()

  return {
    type: 'mention',
    mention: mentionContent,
    annotations: {
      bold: false,
      italic: false,
      strikethrough: false,
      underline: false,
      code: false,
      color: 'default' as const,
    },
    plain_text: plainText,
    href,
  }
}

/** Helper to create an equation rich text element */
const makeEquation = (expression: string): RichTextArray[number] => ({
  type: 'equation',
  equation: { expression },
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: 'default' as const,
  },
  plain_text: expression,
  href: null,
})

describe('toPlainText', () => {
  it('converts simple text', () => {
    const richText: RichTextArray = [makeText('Hello, world!')]
    expect(toPlainText(richText)).toBe('Hello, world!')
  })

  it('concatenates multiple text elements', () => {
    const richText: RichTextArray = [
      makeText('Hello, '),
      makeText('world', { bold: true }),
      makeText('!'),
    ]
    expect(toPlainText(richText)).toBe('Hello, world!')
  })

  it('handles empty array', () => {
    expect(toPlainText([])).toBe('')
  })

  it('ignores annotations', () => {
    const richText: RichTextArray = [
      makeText('bold', { bold: true }),
      makeText(' and '),
      makeText('italic', { italic: true }),
    ]
    expect(toPlainText(richText)).toBe('bold and italic')
  })

  it('extracts plain text from mentions', () => {
    const richText: RichTextArray = [
      makeText('Hello '),
      makeMention('user', { id: '123' }, 'John Doe'),
      makeText('!'),
    ]
    expect(toPlainText(richText)).toBe('Hello John Doe!')
  })

  it('extracts plain text from equations', () => {
    const richText: RichTextArray = [makeText('Energy: '), makeEquation('E = mc^2')]
    expect(toPlainText(richText)).toBe('Energy: E = mc^2')
  })
})

describe('toMarkdown', () => {
  it('converts plain text', () => {
    const richText: RichTextArray = [makeText('Hello, world!')]
    expect(toMarkdown(richText)).toBe('Hello, world!')
  })

  it('converts bold text', () => {
    const richText: RichTextArray = [makeText('Hello', { bold: true })]
    expect(toMarkdown(richText)).toBe('**Hello**')
  })

  it('converts italic text', () => {
    const richText: RichTextArray = [makeText('Hello', { italic: true })]
    expect(toMarkdown(richText)).toBe('*Hello*')
  })

  it('converts strikethrough text', () => {
    const richText: RichTextArray = [makeText('Hello', { strikethrough: true })]
    expect(toMarkdown(richText)).toBe('~~Hello~~')
  })

  it('converts inline code', () => {
    const richText: RichTextArray = [makeText('code', { code: true })]
    expect(toMarkdown(richText)).toBe('`code`')
  })

  it('converts underlined text using HTML', () => {
    const richText: RichTextArray = [makeText('Hello', { underline: true })]
    expect(toMarkdown(richText)).toBe('<u>Hello</u>')
  })

  it('combines multiple annotations', () => {
    const richText: RichTextArray = [makeText('Hello', { bold: true, italic: true })]
    expect(toMarkdown(richText)).toBe('***Hello***')
  })

  it('converts links', () => {
    const richText: RichTextArray = [makeText('click here', { href: 'https://example.com' })]
    expect(toMarkdown(richText)).toBe('[click here](https://example.com)')
  })

  it('converts links with formatting', () => {
    const richText: RichTextArray = [
      makeText('click here', { bold: true, href: 'https://example.com' }),
    ]
    expect(toMarkdown(richText)).toBe('[**click here**](https://example.com)')
  })

  it('converts user mentions', () => {
    const richText: RichTextArray = [makeMention('user', { id: '123' }, 'John Doe')]
    expect(toMarkdown(richText)).toBe('@John Doe')
  })

  it('converts page mentions with links', () => {
    const richText: RichTextArray = [
      makeMention('page', { id: '123' }, 'My Page', 'https://notion.so/page'),
    ]
    expect(toMarkdown(richText)).toBe('[My Page](https://notion.so/page)')
  })

  it('converts date mentions', () => {
    const richText: RichTextArray = [makeMention('date', { start: '2024-01-15' }, '2024-01-15')]
    expect(toMarkdown(richText)).toBe('2024-01-15')
  })

  it('converts date range mentions', () => {
    const richText: RichTextArray = [
      makeMention('date', { start: '2024-01-15', end: '2024-01-20' }, '2024-01-15 → 2024-01-20'),
    ]
    expect(toMarkdown(richText)).toBe('2024-01-15 → 2024-01-20')
  })

  it('converts equations', () => {
    const richText: RichTextArray = [makeEquation('E = mc^2')]
    expect(toMarkdown(richText)).toBe('$E = mc^2$')
  })

  it('converts mixed content', () => {
    const richText: RichTextArray = [
      makeText('The formula '),
      makeEquation('E = mc^2'),
      makeText(' was discovered by '),
      makeText('Einstein', { bold: true }),
      makeText('.'),
    ]
    expect(toMarkdown(richText)).toBe('The formula $E = mc^2$ was discovered by **Einstein**.')
  })
})

describe('toHtml', () => {
  it('converts plain text', () => {
    const richText: RichTextArray = [makeText('Hello, world!')]
    expect(toHtml(richText)).toBe('Hello, world!')
  })

  it('escapes HTML special characters', () => {
    const richText: RichTextArray = [makeText('<script>alert("xss")</script>')]
    expect(toHtml(richText)).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;')
  })

  it('converts bold text', () => {
    const richText: RichTextArray = [makeText('Hello', { bold: true })]
    expect(toHtml(richText)).toBe('<strong>Hello</strong>')
  })

  it('converts italic text', () => {
    const richText: RichTextArray = [makeText('Hello', { italic: true })]
    expect(toHtml(richText)).toBe('<em>Hello</em>')
  })

  it('converts strikethrough text', () => {
    const richText: RichTextArray = [makeText('Hello', { strikethrough: true })]
    expect(toHtml(richText)).toBe('<del>Hello</del>')
  })

  it('converts underlined text', () => {
    const richText: RichTextArray = [makeText('Hello', { underline: true })]
    expect(toHtml(richText)).toBe('<u>Hello</u>')
  })

  it('converts inline code', () => {
    const richText: RichTextArray = [makeText('code', { code: true })]
    expect(toHtml(richText)).toBe('<code>code</code>')
  })

  it('combines multiple annotations in correct order', () => {
    const richText: RichTextArray = [
      makeText('Hello', { bold: true, italic: true, underline: true }),
    ]
    expect(toHtml(richText)).toBe('<strong><em><u>Hello</u></em></strong>')
  })

  it('converts text colors', () => {
    const richText: RichTextArray = [makeText('red text', { color: 'red' })]
    expect(toHtml(richText)).toBe('<span style="color: var(--notion-red, red)">red text</span>')
  })

  it('converts background colors', () => {
    const richText: RichTextArray = [makeText('highlighted', { color: 'yellow_background' })]
    expect(toHtml(richText)).toBe(
      '<span style="background-color: var(--notion-yellow-background, yellow)">highlighted</span>',
    )
  })

  it('converts links', () => {
    const richText: RichTextArray = [makeText('click here', { href: 'https://example.com' })]
    expect(toHtml(richText)).toBe('<a href="https://example.com">click here</a>')
  })

  it('escapes link URLs', () => {
    const richText: RichTextArray = [makeText('link', { href: 'https://example.com?q=a&b=c"test' })]
    expect(toHtml(richText)).toBe('<a href="https://example.com?q=a&amp;b=c&quot;test">link</a>')
  })

  it('converts user mentions', () => {
    const richText: RichTextArray = [makeMention('user', { id: 'user-123' }, 'John Doe')]
    expect(toHtml(richText)).toBe(
      '<span class="notion-mention notion-mention-user" data-user-id="user-123">@John Doe</span>',
    )
  })

  it('converts page mentions with links', () => {
    const richText: RichTextArray = [
      makeMention('page', { id: 'page-123' }, 'My Page', 'https://notion.so/page'),
    ]
    expect(toHtml(richText)).toBe(
      '<a href="https://notion.so/page" class="notion-mention notion-mention-page" data-page-id="page-123">My Page</a>',
    )
  })

  it('converts date mentions', () => {
    const richText: RichTextArray = [makeMention('date', { start: '2024-01-15' }, '2024-01-15')]
    expect(toHtml(richText)).toBe(
      '<time class="notion-mention notion-mention-date" datetime="2024-01-15">2024-01-15</time>',
    )
  })

  it('converts equations', () => {
    const richText: RichTextArray = [makeEquation('E = mc^2')]
    expect(toHtml(richText)).toBe(
      '<span class="notion-equation" data-equation="E = mc^2">E = mc^2</span>',
    )
  })

  it('escapes equation content', () => {
    const richText: RichTextArray = [makeEquation('<x>')]
    expect(toHtml(richText)).toBe(
      '<span class="notion-equation" data-equation="&lt;x&gt;">&lt;x&gt;</span>',
    )
  })

  it('converts mixed content', () => {
    const richText: RichTextArray = [
      makeText('The formula '),
      makeEquation('E = mc^2'),
      makeText(' is ', { italic: true }),
      makeText('famous', { bold: true }),
      makeText('.'),
    ]
    expect(toHtml(richText)).toBe(
      'The formula <span class="notion-equation" data-equation="E = mc^2">E = mc^2</span><em> is </em><strong>famous</strong>.',
    )
  })
})
