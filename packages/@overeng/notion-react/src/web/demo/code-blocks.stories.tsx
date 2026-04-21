import type { Meta } from '@storybook/react'

import { sharedDemoStory } from './shared-demo-story.tsx'

const meta = {
  title: 'Demo/04 — Code Blocks',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

export const Default = sharedDemoStory('demo-04-code-blocks')
