import type { Meta, StoryObj } from '@storybook/react'

import { Code, Heading1, Heading2, Page, Paragraph } from '../blocks.tsx'

const meta = {
  title: 'Demo/04 — Code Blocks',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Code blocks</Heading1>
      <Paragraph>
        Code blocks preserve whitespace and expose the Notion <code>language</code> via a
        <code> data-language</code> attribute for theming.
      </Paragraph>

      <Heading2>TypeScript</Heading2>
      <Code language="typescript">{`type Shape =
  | { _tag: 'circle'; radius: number }
  | { _tag: 'square'; side: number }

const area = (s: Shape): number => {
  switch (s._tag) {
    case 'circle': return Math.PI * s.radius ** 2
    case 'square': return s.side * s.side
  }
}`}</Code>

      <Heading2>Python</Heading2>
      <Code language="python">{`def fib(n: int) -> int:
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

print([fib(i) for i in range(10)])`}</Code>

      <Heading2>Bash</Heading2>
      <Code language="bash">{`# build the storybook
pnpm --filter @overeng/notion-react storybook:build

# run locally
pnpm --filter @overeng/notion-react storybook`}</Code>

      <Heading2>JSON</Heading2>
      <Code language="json">{`{
  "name": "@overeng/notion-react",
  "version": "0.1.0",
  "type": "module"
}`}</Code>
    </Page>
  ),
}
