import type { Meta, StoryObj } from '@storybook/react'

import { Breadcrumb, Callout, Heading1, Page, Paragraph } from '../blocks.tsx'
import { InlineCode } from '../inline.tsx'

const meta = {
  title: 'Demo/17 — Modern · Breadcrumb',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

type Story = StoryObj

/**
 * Breadcrumb blocks render a page's ancestry chain. v0.1 surfaces the raw
 * payload; typed ancestry resolution is tracked by #77.
 */
export const Default: Story = {
  render: () => (
    <Page>
      <Heading1>Breadcrumb</Heading1>
      <Paragraph>
        A breadcrumb block shows the page's ancestry — workspace root down to the current page.
      </Paragraph>

      <Breadcrumb
        content={{
          ancestors: [
            { id: 'workspace', title: 'Acme' },
            { id: 'engineering', title: 'Engineering' },
            { id: 'frontend', title: 'Frontend' },
            { id: 'current', title: 'Renderer design' },
          ],
        }}
      />

      <Callout icon="🚧" color="yellow_background">
        v0.2 — typed ancestry with page icons and hover affordances tracked by{' '}
        <InlineCode>#77</InlineCode>.
      </Callout>
    </Page>
  ),
}
