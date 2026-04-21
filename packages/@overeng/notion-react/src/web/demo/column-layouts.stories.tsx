import type { Meta } from '@storybook/react'

import { sharedDemoStory } from './shared-demo-story.tsx'

const meta = {
  title: 'Demo/09 — Column Layouts',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

export const Default = sharedDemoStory('demo-09-column-layouts')
