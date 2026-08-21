import { describe, expect, it } from 'vitest'

import {
  Bookmark,
  BulletedListItem,
  Callout,
  ChildPage,
  Code,
  Column,
  ColumnList,
  Divider,
  Embed,
  Equation,
  Heading1,
  Heading2,
  Image,
  LinkToPage,
  NumberedListItem,
  Paragraph,
  Quote,
  Raw,
  Table,
  TableRow,
  TableOfContents,
  ToDo,
  Toggle,
} from '../components/blocks.ts'
import {
  Bold,
  Color,
  InlineCode,
  InlineEquation,
  Italic,
  Link,
  Mention,
  Strikethrough,
  Underline,
} from '../components/inline.ts'
import { renderToNotionMarkdown } from './render-to-notion-markdown.ts'

describe('renderToNotionMarkdown', () => {
  it('renders headings and paragraphs', () => {
    const result = renderToNotionMarkdown(
      <>
        <Heading1>Title</Heading1>
        <Paragraph>Body text.</Paragraph>
        <Heading2>Sub</Heading2>
      </>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "# Title

      Body text.

      ## Sub"
    `)
    expect(result.diagnostics).toEqual([])
  })

  it('renders inline annotations, links, mentions and equations', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <Bold>bold</Bold> <Italic>italic</Italic> <InlineCode>code</InlineCode>{' '}
        <Strikethrough>gone</Strikethrough> <Underline>under</Underline>{' '}
        <Link href="https://example.com">link</Link>{' '}
        <Mention mention={{ type: 'user', user: { id: 'u1' } }} plainText="alice" />{' '}
        <InlineEquation expression="E=mc^2" />
      </Paragraph>,
    )
    expect(result.body).toMatchInlineSnapshot(
      `"**bold** *italic* \`code\` ~~gone~~ <u>under</u> [link](https://example.com) @alice $E=mc^2$"`,
    )
  })

  it('emits a diagnostic when a color annotation is dropped', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        normal <Color value="red">red</Color>
      </Paragraph>,
    )
    expect(result.body).toBe('normal red')
    expect(result.diagnostics).toEqual([
      { kind: 'color-dropped', message: 'text color red dropped' },
    ])
  })

  it('renders nested lists with per-run numbering', () => {
    const result = renderToNotionMarkdown(
      <>
        <NumberedListItem>first</NumberedListItem>
        <NumberedListItem>
          second
          <BulletedListItem>nested bullet</BulletedListItem>
        </NumberedListItem>
        <NumberedListItem>third</NumberedListItem>
      </>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "1. first

      2. second
         - nested bullet

      3. third"
    `)
  })

  it('renders to-dos', () => {
    const result = renderToNotionMarkdown(
      <>
        <ToDo checked>done</ToDo>
        <ToDo>open</ToDo>
      </>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "- [x] done

      - [ ] open"
    `)
  })

  it('renders toggles as details/summary (issue example)', () => {
    const result = renderToNotionMarkdown(
      <>
        <Heading1>Blocky instructions</Heading1>
        <Toggle blockKey="deploy" title="Deploy">
          <Paragraph>Run the audited deploy command.</Paragraph>
        </Toggle>
      </>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "# Blocky instructions

      <details>
      <summary>Deploy</summary>

      Run the audited deploy command.

      </details>"
    `)
    expect(result.diagnostics).toEqual([])
  })

  it('renders quotes and callouts', () => {
    const result = renderToNotionMarkdown(
      <>
        <Quote>wisdom</Quote>
        <Callout icon="⚠️" color="red_background">
          careful
        </Callout>
      </>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "> wisdom

      > ⚠️ careful"
    `)
    expect(result.diagnostics).toEqual([
      { kind: 'color-dropped', message: 'callout color red_background dropped' },
    ])
  })

  it('renders code fences without inline markdown annotations', () => {
    const result = renderToNotionMarkdown(
      <Code language="ts">
        <Bold>const</Bold> x = 1
      </Code>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "\`\`\`ts
      const x = 1
      \`\`\`"
    `)
  })

  it('renders tables with a GFM header separator', () => {
    const result = renderToNotionMarkdown(
      <Table hasColumnHeader>
        <TableRow cells={['A', 'B']} />
        <TableRow cells={[1, 2]} />
      </Table>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "| A | B |
      | --- | --- |
      | 1 | 2 |"
    `)
  })

  it('renders dividers, equations, toc and page links', () => {
    const result = renderToNotionMarkdown(
      <>
        <Divider />
        <Equation expression="a^2 + b^2 = c^2" />
        <TableOfContents />
        <LinkToPage pageId="5c2a3b4d-0000-4000-8000-000000000000" />
      </>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "---

      $$
      a^2 + b^2 = c^2
      $$

      [TOC]

      [Link to page](https://notion.so/5c2a3b4d000040008000000000000000)"
    `)
  })

  it('renders external media and bookmarks', () => {
    const result = renderToNotionMarkdown(
      <>
        <Image url="https://example.com/cat.png" caption={<Bold>a cat</Bold>} />
        <Bookmark url="https://example.com" />
        <Embed url="https://youtube.com/watch?v=1" />
      </>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "![**a cat**](https://example.com/cat.png)

      [https://example.com](https://example.com)

      [Embed](https://youtube.com/watch?v=1)"
    `)
  })

  it('diagnoses upload-only media instead of dropping it', () => {
    const result = renderToNotionMarkdown(<Image fileUploadId="upload_123" />)
    expect(result.body).toBe('<!-- image: unresolvable upload upload_123 -->')
    expect(result.diagnostics).toEqual([
      {
        kind: 'media-without-url',
        message: 'image references file_upload upload_123 which has no resolvable URL offline',
      },
    ])
  })

  it('flattens column layout with a diagnostic', () => {
    const result = renderToNotionMarkdown(
      <ColumnList>
        <Column>
          <Paragraph>left</Paragraph>
        </Column>
        <Column>
          <Paragraph>right</Paragraph>
        </Column>
      </ColumnList>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "left

      right"
    `)
    expect(result.diagnostics).toEqual([
      { kind: 'flattened', message: 'column layout flattened to sequential blocks' },
    ])
  })

  it('flattens child pages into a bold label with content', () => {
    const result = renderToNotionMarkdown(
      <ChildPage title="Deploy Guide">
        <Paragraph>step one</Paragraph>
      </ChildPage>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "**Deploy Guide** (child page)

      step one"
    `)
    expect(result.diagnostics).toEqual([
      {
        kind: 'flattened',
        message:
          'child page boundary flattened: "Deploy Guide" rendered as bold label + inline content',
      },
    ])
  })

  it('emits placeholders plus diagnostics for unsupported raw blocks', () => {
    const result = renderToNotionMarkdown(
      <Raw type="child_database" content={{ title: 'Sprints' }} />,
    )
    expect(result.body).toBe('<!-- unsupported block: child_database -->')
    expect(result.diagnostics).toEqual([
      {
        kind: 'unsupported-block',
        message: 'child_database block emitted as placeholder (no Markdown spelling)',
      },
    ])
  })

  it('is deterministic across repeated renders', () => {
    const element = (
      <>
        <Heading1>t</Heading1>
        <Toggle title="x">
          <Paragraph>y</Paragraph>
        </Toggle>
      </>
    )
    expect(renderToNotionMarkdown(element)).toEqual(renderToNotionMarkdown(element))
  })
})
