import type { Meta, StoryObj } from '@storybook/react'

import { Page, Paragraph } from './blocks.tsx'
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
} from './inline.tsx'

const meta = { title: 'Inline' } satisfies Meta
export default meta

type Story = StoryObj

export const Annotations: Story = {
  render: () => (
    <Page>
      <Paragraph>
        Plain. <Bold>Bold.</Bold> <Italic>Italic.</Italic>{' '}
        <Strikethrough>Strikethrough.</Strikethrough> <Underline>Underline.</Underline>{' '}
        <InlineCode>inline code</InlineCode>. Mix and match:{' '}
        <Bold>
          <Italic>bold-italic</Italic>
        </Bold>
        .
      </Paragraph>
    </Page>
  ),
}

const colors = [
  'default',
  'gray',
  'brown',
  'orange',
  'yellow',
  'green',
  'blue',
  'purple',
  'pink',
  'red',
] as const

export const Colors: Story = {
  render: () => (
    <Page>
      <Paragraph>Foreground colors:</Paragraph>
      {colors.map((c) => (
        <Paragraph key={c}>
          <Color value={c}>
            The quick brown fox jumps over the lazy dog. <InlineCode>{c}</InlineCode>
          </Color>
        </Paragraph>
      ))}
      <Paragraph>Background colors:</Paragraph>
      {colors
        .filter((c) => c !== 'default')
        .map((c) => (
          <Paragraph key={`${c}_bg`}>
            <Color value={`${c}_background`}>
              The quick brown fox jumps over the lazy dog. <InlineCode>{`${c}_background`}</InlineCode>
            </Color>
          </Paragraph>
        ))}
    </Page>
  ),
}

export const Links: Story = {
  render: () => (
    <Page>
      <Paragraph>
        Plain link:{' '}
        <Link href="https://notion.so">notion.so</Link>. Inline inside a sentence — visit{' '}
        <Link href="https://github.com">GitHub</Link> to see more.
      </Paragraph>
    </Page>
  ),
}

export const Mentions: Story = {
  render: () => (
    <Page>
      <Paragraph>
        Page mention:{' '}
        <Mention mention={{ page: { id: 'abc123' } }} plainText="@Daily 2026-04-19" />. User mention:{' '}
        <Mention mention={{ user: { id: 'u1' } }} plainText="@alex" />. Date mention:{' '}
        <Mention mention={{ date: { start: '2026-04-19' } }} plainText="@2026-04-19" />. Database
        mention: <Mention mention={{ database: { id: 'db-1' } }} />.
      </Paragraph>
    </Page>
  ),
}

export const Equations: Story = {
  render: () => (
    <Page>
      <Paragraph>
        Inline equation: <InlineEquation expression="E = mc^2" /> — the classic. Another:{' '}
        <InlineEquation expression="\int_0^1 x^2 dx = 1/3" />.
      </Paragraph>
    </Page>
  ),
}
