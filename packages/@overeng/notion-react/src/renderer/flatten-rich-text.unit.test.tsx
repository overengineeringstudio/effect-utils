import { describe, expect, it } from 'vitest'

import {
  Bold,
  Color,
  InlineCode,
  InlineEquation,
  Italic,
  Link,
  Mention,
  Strikethrough,
  Text,
  Underline,
} from '../components/inline.tsx'
import { flattenRichText } from './flatten-rich-text.ts'

describe('flattenRichText', () => {
  it('flattens a plain string', () => {
    const out = flattenRichText('hello')
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "annotations": {
            "bold": false,
            "code": false,
            "color": "default",
            "italic": false,
            "strikethrough": false,
            "underline": false,
          },
          "text": {
            "content": "hello",
            "link": null,
          },
          "type": "text",
        },
      ]
    `)
  })

  it('merges bold + italic annotations', () => {
    const out = flattenRichText(
      <Bold>
        <Italic>hi</Italic>
      </Bold>,
    )
    expect(out).toHaveLength(1)
    expect(out[0]!.annotations).toMatchObject({ bold: true, italic: true })
  })

  it('wraps link url onto text items', () => {
    const out = flattenRichText(<Link href="https://example.com">click</Link>)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      type: 'text',
      text: { content: 'click', link: { url: 'https://example.com' } },
    })
  })

  it('emits a mention leaf', () => {
    const out = flattenRichText(
      <Mention mention={{ type: 'user', user: { id: 'u1' } }} plainText="@alice" />,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ type: 'mention', plain_text: '@alice' })
  })

  it('emits an equation leaf', () => {
    const out = flattenRichText(<InlineEquation expression="E=mc^2" />)
    expect(out).toMatchObject([{ type: 'equation', equation: { expression: 'E=mc^2' } }])
  })

  // Matrix covering combinations of inline annotations that flow through
  // `flattenRichText`. Notes on the real API surface:
  //   - Notion encodes colour and background as a single `color` string
  //     (e.g. `red`, `red_background`). There's no separate "background"
  //     axis; `<Color value="red_background">` is how you paint a
  //     background, so the "color + bg" case pins that convention.
  //   - Nested `<Color>` wrappers last-wins (the inner `patch` overwrites
  //     the outer) — expected for annotation merging.
  describe('annotation combinations', () => {
    it.each([
      {
        name: 'bold + italic',
        node: (
          <Bold>
            <Italic>x</Italic>
          </Bold>
        ),
        expected: { bold: true, italic: true },
      },
      {
        name: 'bold + strikethrough',
        node: (
          <Bold>
            <Strikethrough>x</Strikethrough>
          </Bold>
        ),
        expected: { bold: true, strikethrough: true },
      },
      {
        name: 'italic + underline + code',
        node: (
          <Italic>
            <Underline>
              <InlineCode>x</InlineCode>
            </Underline>
          </Italic>
        ),
        expected: { italic: true, underline: true, code: true },
      },
    ])('$name', ({ node, expected }) => {
      const out = flattenRichText(node)
      expect(out).toHaveLength(1)
      expect(out[0]!.annotations).toMatchObject(expected)
    })

    it('color + background + link (red_background + href)', () => {
      // Notion represents backgrounds as `<color>_background`, so a colored
      // background is a single annotation axis, not two. The link envelope
      // nests independently around the colour frame.
      const out = flattenRichText(
        <Color value="red_background">
          <Link href="https://example.com">click</Link>
        </Color>,
      )
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({
        type: 'text',
        text: { content: 'click', link: { url: 'https://example.com' } },
      })
      expect(out[0]!.annotations).toMatchObject({ color: 'red_background' })
    })

    it('mention alongside annotated text', () => {
      const out = flattenRichText(
        <Text>
          <Bold>before </Bold>
          <Mention mention={{ type: 'user', user: { id: 'u1' } }} plainText="@alice" />
          <Italic> after</Italic>
        </Text>,
      )
      expect(out.map((i) => i.type)).toEqual(['text', 'mention', 'text'])
      expect(out[0]!.annotations.bold).toBe(true)
      expect(out[1]).toMatchObject({ type: 'mention', plain_text: '@alice' })
      expect(out[2]!.annotations.italic).toBe(true)
    })

    it('inline equation alongside annotated text', () => {
      const out = flattenRichText(
        <Text>
          <Bold>mass-energy: </Bold>
          <InlineEquation expression="E=mc^2" />
          <Italic> (famous)</Italic>
        </Text>,
      )
      expect(out.map((i) => i.type)).toEqual(['text', 'equation', 'text'])
      expect(out[0]!.annotations.bold).toBe(true)
      expect(out[1]).toMatchObject({ type: 'equation', equation: { expression: 'E=mc^2' } })
      expect(out[2]!.annotations.italic).toBe(true)
    })
  })

  // Notion's 2000-char-per-segment API limit: the flattener must chunk long
  // content while preserving the surrounding annotation/link frame.
  describe('2000-char chunking', () => {
    it('2500-char bold splits into two bold segments (2000 + 500)', () => {
      const out = flattenRichText(<Bold>{'a'.repeat(2500)}</Bold>)
      expect(out).toHaveLength(2)
      expect(out.every((i) => i.type === 'text' && i.annotations.bold)).toBe(true)
      expect((out[0] as { text: { content: string } }).text.content).toHaveLength(2000)
      expect((out[1] as { text: { content: string } }).text.content).toHaveLength(500)
    })

    it('exactly 2000 chars is NOT split', () => {
      const out = flattenRichText('a'.repeat(2000))
      expect(out).toHaveLength(1)
      expect((out[0] as { text: { content: string } }).text.content).toHaveLength(2000)
    })

    it('4500 unstyled chars splits into three segments (2000 + 2000 + 500)', () => {
      const out = flattenRichText('a'.repeat(4500))
      expect(out).toHaveLength(3)
      expect((out[0] as { text: { content: string } }).text.content).toHaveLength(2000)
      expect((out[1] as { text: { content: string } }).text.content).toHaveLength(2000)
      expect((out[2] as { text: { content: string } }).text.content).toHaveLength(500)
    })

    it('preserves link across chunk boundary (giant URL text)', () => {
      const giant = 'x'.repeat(3000)
      const out = flattenRichText(<Link href="https://example.com">{giant}</Link>)
      expect(out).toHaveLength(2)
      for (const item of out) {
        expect(item).toMatchObject({
          type: 'text',
          text: { link: { url: 'https://example.com' } },
        })
      }
      const joined = out.map((i) => (i.type === 'text' ? i.text.content : '')).join('')
      expect(joined).toBe(giant)
    })

    it('does not split a surrogate pair (emoji at boundary round-trips)', () => {
      // Construct a string where a 4-code-unit emoji sits on the 2000-code-
      // unit boundary: 1998 'a' + emoji (2 code units at 1999–2000) + tail.
      const emoji = '\uD83D\uDE00' // 😀
      const s = 'a'.repeat(1998) + emoji + 'b'.repeat(500)
      const out = flattenRichText(s)
      // Join must equal input exactly and no chunk may end mid-surrogate.
      const contents = out.map((i) => (i.type === 'text' ? i.text.content : ''))
      expect(contents.join('')).toBe(s)
      for (const c of contents) {
        const last = c.charCodeAt(c.length - 1)
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
      }
    })
  })

  it('mixes plain text and annotated children', () => {
    const out = flattenRichText(
      <Text>
        plain <Bold>strong</Bold> <InlineCode>code</InlineCode>
      </Text>,
    )
    // 'plain ', 'strong', ' ', 'code'
    expect(out.map((i) => (i.type === 'text' ? i.text.content : ''))).toEqual([
      'plain ',
      'strong',
      ' ',
      'code',
    ])
    expect(out[1]!.annotations.bold).toBe(true)
    expect(out[3]!.annotations.code).toBe(true)
  })

  it('recurses through React Fragments so nested text is preserved', () => {
    // Regression: an untagged fragment used to short-circuit the walker,
    // dropping every descendant (e.g. `<Paragraph><>hello</></Paragraph>`).
    const out = flattenRichText(
      <>
        hi <Bold>there</Bold>
      </>,
    )
    expect(out.map((i) => (i.type === 'text' ? i.text.content : ''))).toEqual(['hi ', 'there'])
    expect(out[1]!.annotations.bold).toBe(true)
  })
})
