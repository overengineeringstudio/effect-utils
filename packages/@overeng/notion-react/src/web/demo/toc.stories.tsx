import type { Meta } from '@storybook/react'

import { sharedDemoStory } from './shared-demo-story.tsx'

const meta = {
  title: 'Demo/05 — Table of Contents',
  parameters: { layout: 'fullscreen' },
} satisfies Meta
export default meta

export const Default = sharedDemoStory('demo-05-table-of-contents')
