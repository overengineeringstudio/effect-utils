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
  Page,
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

  it('normalizes authored mention forms (type-less envelopes, pre-prefixed plainText)', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <Mention mention={{ user: { id: 'u1' } }} plainText="@priya" />{' '}
        <Mention mention={{ page: { id: 'p1' } }} plainText="@Launch Plan" />{' '}
        <Mention mention={{ date: { start: '2026-04-19' } }} plainText="@2026-04-19" />
      </Paragraph>,
    )
    expect(result.body).toBe('@priya [@Launch Plan](https://notion.so/p1) 2026-04-19')
    expect(result.diagnostics).toEqual([])
  })

  it('preserves annotations wrapping mentions and equations', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <Bold>
          <Mention mention={{ type: 'user', user: { id: 'u1' } }} plainText="alice" />
        </Bold>{' '}
        <Italic>
          <InlineEquation expression="E=mc^2" />
        </Italic>{' '}
        <Color value="red">
          <Mention mention={{ type: 'user', user: { id: 'u2' } }} plainText="bob" />
        </Color>
      </Paragraph>,
    )
    expect(result.body).toBe('**@alice** *$E=mc^2$* @bob')
    expect(result.diagnostics).toEqual([
      { kind: 'color-dropped', message: 'text color red dropped' },
    ])
  })

  it('escapes authored Markdown metacharacters in literal text', () => {
    const result = renderToNotionMarkdown(
      <>
        <Paragraph># not a heading</Paragraph>
        <Paragraph>*not italic* and _not italic_</Paragraph>
        <Paragraph>snake_case and 1. not-a-list</Paragraph>
      </>,
    )
    const [heading, emphasis, plain] = result.body.split('\n\n')
    expect(heading).toBe('\\# not a heading')
    expect(emphasis).toBe('\\*not italic\\* and \\_not italic\\_')
    expect(plain).toBe('snake\\_case and 1. not-a-list')
  })

  it('serializes inline code from raw content with a safe delimiter', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <InlineCode>file_upload</InlineCode> and <InlineCode>a`b</InlineCode> and{' '}
        <Bold>
          <InlineCode>*raw*</InlineCode>
        </Bold>
      </Paragraph>,
    )
    expect(result.body).toBe('`file_upload` and ``a`b`` and **`*raw*`**')
    expect(result.diagnostics).toEqual([])
  })

  it('falls back to typed labels and offline links for mentions without plainText', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <Mention mention={{ page: { id: '5c2a3b4d-0000-4000-8000-000000000000' } }} /> and{' '}
        <Mention mention={{ database: { id: 'db1' } }} /> and{' '}
        <Mention mention={{ user: { id: 'u1' } }} />
      </Paragraph>,
    )
    expect(result.body).toBe(
      '[@page](https://notion.so/5c2a3b4d000040008000000000000000) and [@database](https://notion.so/db1) and @user',
    )
    expect(result.diagnostics).toEqual([])
  })

  it('does not diagnose metadata-free root Page wrappers', () => {
    const result = renderToNotionMarkdown(
      <Page>
        <Paragraph>content</Paragraph>
      </Page>,
    )
    expect(result.body).toBe('content')
    expect(result.diagnostics).toEqual([])
  })

  it('renders paragraph child blocks as diagnosed siblings', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        parent
        <Paragraph>child</Paragraph>
      </Paragraph>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "parent

      child"
    `)
    expect(result.diagnostics).toEqual([
      { kind: 'flattened', message: 'paragraph child blocks rendered as sibling blocks' },
    ])
  })

  it('separates quoted child blocks with a blank quote line', () => {
    const result = renderToNotionMarkdown(
      <Quote>
        parent
        <Paragraph>child</Paragraph>
      </Quote>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "> parent
      >
      > child"
    `)
  })

  it('treats explicit default colors as lossless', () => {
    const result = renderToNotionMarkdown(
      <>
        <Callout color="default" icon="ℹ️">
          plain
        </Callout>
        <Heading1 color="default">head</Heading1>
      </>,
    )
    expect(result.diagnostics).toEqual([])
  })

  it('preserves absent callout icons and escapes entity-like ampersands', () => {
    const iconless = renderToNotionMarkdown(<Callout>plain note</Callout>)
    expect(iconless.body).toBe('> plain note')
    expect(iconless.diagnostics).toEqual([])
    const entities = renderToNotionMarkdown(
      <Paragraph>{'use &copy; and &#35; but a & bare'}</Paragraph>,
    )
    expect(entities.body).toBe('use \\&copy; and \\&#35; but a & bare')
    expect(entities.diagnostics).toEqual([])
  })

  it('escapes mention labels interpolated into link syntax', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <Mention mention={{ page: { id: 'p1' } }} plainText="[Q3]" />{' '}
        <Mention mention={{ type: 'user', user: { id: 'u1' } }} plainText="*ops*" />
      </Paragraph>,
    )
    expect(result.body).toBe('[\\[Q3\\]](https://notion.so/p1) @\\*ops\\*')
  })

  it('does not double-escape media caption labels', () => {
    const result = renderToNotionMarkdown(<Image url="https://example.com/cat.png" caption="a]b" />)
    expect(result.body).toBe('![a\\]b](https://example.com/cat.png)')
  })

  it('emits one diagnostic per lossy construct inside tables', () => {
    const result = renderToNotionMarkdown(
      <Table hasColumnHeader>
        <TableRow cells={[<Color key="a" value="red">A</Color>, 'B']} />
        <TableRow cells={[1, 2]} />
        <TableRow cells={[3, 4]} />
      </Table>,
    )
    expect(result.diagnostics).toEqual([
      { kind: 'color-dropped', message: 'text color red dropped' },
    ])
  })

  it('renders span-array child-page titles instead of Untitled', () => {
    const result = renderToNotionMarkdown(
      <ChildPage
        title={[
          { type: 'text', text: { content: 'Deploy' } },
          { type: 'text', text: { content: ' Guide' } },
        ]}
      />,
    )
    expect(result.body).toBe('**Deploy Guide** (child page)')
    expect(result.diagnostics).toEqual([
      {
        kind: 'flattened',
        message:
          'child page boundary flattened: "Deploy Guide" rendered as bold label + inline content',
      },
    ])
  })

  it('reports row-header semantics loss on tables', () => {
    const result = renderToNotionMarkdown(
      <Table hasColumnHeader hasRowHeader>
        <TableRow cells={['A', 'B']} />
        <TableRow cells={[1, 2]} />
      </Table>,
    )
    expect(result.diagnostics).toEqual([
      { kind: 'flattened', message: 'table row-header semantics dropped (no GFM spelling)' },
    ])
  })

  it('diagnoses empty toggleable headings as flattened', () => {
    const result = renderToNotionMarkdown(<Heading2 toggleable>Empty section</Heading2>)
    expect(result.body).toBe('## Empty section')
    expect(result.diagnostics).toEqual([
      {
        kind: 'flattened',
        message: 'toggleable heading rendered as flat heading + following content',
      },
    ])
  })

  it('reports root Page metadata omission', () => {
    const result = renderToNotionMarkdown(
      <Page title="Review doc">
        <Paragraph>content</Paragraph>
      </Page>,
    )
    expect(result.body).toBe('content')
    expect(result.diagnostics).toEqual([
      {
        kind: 'flattened',
        message:
          'root page metadata (title/icon/cover) omitted from body; carry it in the .nmd envelope or page properties',
      },
    ])
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

  it('diagnoses external callout icons instead of fabricating a default', () => {
    const result = renderToNotionMarkdown(
      <Callout icon={{ external: 'https://example.com/icon.png' }}>careful</Callout>,
    )
    expect(result.body).toBe('> careful')
    expect(result.diagnostics).toEqual([
      { kind: 'flattened', message: 'callout external icon dropped' },
    ])
  })

  it('reports color loss on toggleable headings with children', () => {
    const result = renderToNotionMarkdown(
      <Heading1 color="red" toggleable>
        Section
        <Paragraph>inside</Paragraph>
      </Heading1>,
    )
    expect(result.body).toMatchInlineSnapshot(`
      "# Section

      inside"
    `)
    expect(result.diagnostics).toEqual([
      { kind: 'color-dropped', message: 'heading color red dropped' },
      {
        kind: 'flattened',
        message: 'toggleable heading rendered as flat heading + following content',
      },
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

  it('lengthens the fence when the code contains backtick runs', () => {
    const result = renderToNotionMarkdown(<Code language="md">{'# Title\n```\nfenced\n```'}</Code>)
    expect(result.body).toMatchInlineSnapshot(`
      "\`\`\`\`md
      # Title
      \`\`\`
      fenced
      \`\`\`
      \`\`\`\`"
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
