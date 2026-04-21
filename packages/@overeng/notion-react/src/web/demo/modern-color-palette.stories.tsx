import type { Meta } from '@storybook/react'

import { sharedDemoStory } from './shared-demo-story.tsx'

const meta = {
  title: 'Demo/19 — Modern · Color Palette',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

export const Default = sharedDemoStory('demo-19-modern-color-palette')
