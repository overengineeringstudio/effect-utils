import { describe, expect, it } from 'vitest'

import {
  Bold,
  InlineCode,
  InlineEquation,
  Italic,
  Link,
  Mention,
  Text,
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
