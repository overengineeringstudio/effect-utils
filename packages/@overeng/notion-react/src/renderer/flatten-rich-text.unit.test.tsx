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
})
