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
  Video,
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
    expect(result.body).toBe(
      '**bold** *italic* `code` ~~gone~~ <u>under</u> [link](https://example.com) <mention-user url="u1">alice</mention-user> $E=mc^2$',
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
    expect(result.body).toBe(
      '<mention-user url="u1">@priya</mention-user> <mention-page url="https://notion.so/p1">@Launch Plan</mention-page> <mention-date start="2026-04-19"/>',
    )
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
    expect(result.body).toBe(
      '**<mention-user url="u1">alice</mention-user>** *$E=mc^2$* <mention-user url="u2">bob</mention-user>',
    )
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

  it('preserves mention identities without inventing missing display labels', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <Mention mention={{ page: { id: '5c2a3b4d-0000-4000-8000-000000000000' } }} /> and{' '}
        <Mention mention={{ database: { id: 'db1' } }} /> and{' '}
        <Mention mention={{ user: { id: 'u1' } }} />
      </Paragraph>,
    )
    expect(result.body).toBe(
      '<mention-page url="https://notion.so/5c2a3b4d000040008000000000000000"></mention-page> and <mention-database url="https://notion.so/db1"></mention-database> and <mention-user url="u1"></mention-user>',
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

  it('escapes link destinations and flattens caption links once per construct', () => {
    const linked = renderToNotionMarkdown(
      <Paragraph>
        <Link href="https://example.com/a)b">doc</Link>
      </Paragraph>,
    )
    expect(linked.body).toBe('[doc](https://example.com/a\\)b)')
    const media = renderToNotionMarkdown(
      <Video
        url="https://example.com/v.mp4"
        caption={<Link href="https://example.com/src">source</Link>}
      />,
    )
    expect(media.body).toBe('[source](https://example.com/v.mp4)')
    expect(media.diagnostics).toEqual([
      { kind: 'flattened', message: 'video caption link flattened to plain text' },
    ])
  })

  it('keeps newline-terminated code exact and diagnoses formatting inside fences', () => {
    const trailing = renderToNotionMarkdown(<Code language="txt">{'x\n'}</Code>)
    expect(trailing.body).toBe('```txt\nx\n```')
    expect(trailing.diagnostics).toEqual([])
    const annotated = renderToNotionMarkdown(
      <Code language="txt">
        <Bold>bold</Bold>
      </Code>,
    )
    expect(annotated.body).toBe('```txt\nbold\n```')
    expect(annotated.diagnostics).toEqual([
      { kind: 'flattened', message: 'inline formatting dropped inside code block' },
    ])
  })

  it('gives link-preview mentions a visible fallback', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <Mention mention={{ type: 'link_preview', link_preview: { url: 'https://example.com' } }} />
      </Paragraph>,
    )
    expect(result.body).toBe('[https://example.com](https://example.com)')
    expect(result.diagnostics).toEqual([])
  })

  it('diagnoses empty paragraphs instead of erasing them', () => {
    const result = renderToNotionMarkdown(
      <>
        <Paragraph>before</Paragraph>
        <Paragraph />
        <Paragraph>after</Paragraph>
      </>,
    )
    expect(result.body).toBe('before\n\nafter')
    expect(result.diagnostics).toEqual([{ kind: 'flattened', message: 'empty paragraph dropped' }])
  })

  it('preserves absent callout icons and escapes entity-like ampersands', () => {
    const iconless = renderToNotionMarkdown(<Callout>plain note</Callout>)
    expect(iconless.body).toBe('<callout>\n\tplain note\n</callout>')
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
    expect(result.body).toBe(
      '<mention-page url="https://notion.so/p1">\\[Q3\\]</mention-page> <mention-user url="u1">\\*ops\\*</mention-user>',
    )
  })

  it('does not double-escape media caption labels', () => {
    const result = renderToNotionMarkdown(<Image url="https://example.com/cat.png" caption="a]b" />)
    expect(result.body).toBe('![a\\]b](https://example.com/cat.png)')
  })

  it('emits one diagnostic per lossy construct inside tables', () => {
    const result = renderToNotionMarkdown(
      <Table hasColumnHeader>
        <TableRow
          cells={[
            <Color key="a" value="red">
              A
            </Color>,
            'B',
          ]}
        />
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

  it('preserves both table header axes', () => {
    const result = renderToNotionMarkdown(
      <Table hasColumnHeader hasRowHeader>
        <TableRow cells={['A', 'B']} />
        <TableRow cells={[1, 2]} />
      </Table>,
    )
    expect(result.body).toContain('<table header-row="true" header-column="true">')
    expect(result.diagnostics).toEqual([])
  })

  it('preserves empty toggleable headings', () => {
    const result = renderToNotionMarkdown(<Heading2 toggleable>Empty section</Heading2>)
    expect(result.body).toBe('## Empty section {toggle="true"}')
    expect(result.diagnostics).toEqual([])
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
    expect(result.body).toBe(
      '# Blocky instructions\n\n<details>\n<summary>Deploy</summary>\n\tRun the audited deploy command.\n</details>',
    )
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
    expect(result.body).toBe(
      '> wisdom\n\n<callout icon="⚠️" color="red_bg">\n\tcareful\n</callout>',
    )
    expect(result.diagnostics).toEqual([])
  })

  it('diagnoses external callout icons instead of fabricating a default', () => {
    const result = renderToNotionMarkdown(
      <Callout icon={{ external: 'https://example.com/icon.png' }}>careful</Callout>,
    )
    expect(result.body).toBe('<callout>\n\tcareful\n</callout>')
    expect(result.diagnostics).toEqual([
      { kind: 'flattened', message: 'callout external icon dropped' },
    ])
  })

  it('preserves color and children on toggleable headings', () => {
    const result = renderToNotionMarkdown(
      <Heading1 color="red" toggleable>
        Section
        <Paragraph>inside</Paragraph>
      </Heading1>,
    )
    expect(result.body).toBe('# Section {toggle="true" color="red"}\n\tinside')
    expect(result.diagnostics).toEqual([])
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

  it('retains nested blocks and escapes callout attributes', () => {
    const result = renderToNotionMarkdown(
      <Callout icon="💡" color="blue_background">
        Read this
        <Toggle title="More">
          <Paragraph>nested</Paragraph>
        </Toggle>
      </Callout>,
    )
    expect(result.body).toBe(
      '<callout icon="💡" color="blue_bg">\n\tRead this\n\n\t<details>\n\t<summary>More</summary>\n\t\tnested\n\t</details>\n</callout>',
    )
    expect(result.diagnostics).toEqual([])
  })

  it('preserves headerless tables and literal pipes in cells', () => {
    const result = renderToNotionMarkdown(
      <Table hasColumnHeader={false}>
        <TableRow cells={['left | right', <Bold key="bold">value</Bold>]} />
      </Table>,
    )
    expect(result.body).toBe(
      '<table>\n\t<tr>\n\t\t<td>left | right</td>\n\t\t<td>**value**</td>\n\t</tr>\n</table>',
    )
    expect(result.diagnostics).toEqual([])
  })

  it('preserves date ranges and timezone-bearing date mentions', () => {
    const result = renderToNotionMarkdown(
      <Paragraph>
        <Mention mention={{ date: { start: '2026-11-27', end: '2026-11-28' } }} />{' '}
        <Mention mention={{ date: { start: '2026-11-27T09:30:00', time_zone: 'Europe/Berlin' } }} />
      </Paragraph>,
    )
    expect(result.body).toBe(
      '<mention-date start="2026-11-27" end="2026-11-28"/> <mention-date start="2026-11-27T09:30:00" timeZone="Europe/Berlin"/>',
    )
    expect(result.diagnostics).toEqual([])
  })

  it('renders native table tags without inventing a header', () => {
    const result = renderToNotionMarkdown(
      <Table hasColumnHeader>
        <TableRow cells={['A', 'B']} />
        <TableRow cells={[1, 2]} />
      </Table>,
    )
    expect(result.body).toBe(
      '<table header-row="true">\n\t<tr>\n\t\t<td>A</td>\n\t\t<td>B</td>\n\t</tr>\n\t<tr>\n\t\t<td>1</td>\n\t\t<td>2</td>\n\t</tr>\n</table>',
    )
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
