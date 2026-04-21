import type { Meta, StoryObj } from '@storybook/react'

import * as Web from './mod.ts'
import {
  launchOverviewDemo,
  teamUpdateDemo,
  tradeoffsSectionDemo,
} from '../demo/page-demos.tsx'

const meta = { title: 'Pages', parameters: { layout: 'fullscreen' } } satisfies Meta
export default meta

type Story = StoryObj

export const LaunchOverview: Story = {
  render: () => launchOverviewDemo.render(Web),
}

export const TeamUpdate: Story = {
  render: () => teamUpdateDemo.render(Web),
}

export const TradeoffsSection: Story = {
  render: () => tradeoffsSectionDemo.render(Web),
}
