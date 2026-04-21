import type { Meta } from '@storybook/react'

import { sharedDemoStory } from './shared-demo-story.tsx'

const meta = {
  title: 'Demo/03 — Color Rainbow',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

export const Default = sharedDemoStory('demo-03-color-rainbow')
