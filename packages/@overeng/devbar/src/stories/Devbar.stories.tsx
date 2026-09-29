import type { Meta, StoryObj } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import * as React from 'react'
import { expect, userEvent, within } from 'storybook/test'

import { Devbar, FpsMeter, type DevbarPanel } from '../Devbar.tsx'
import { darkDevbarTheme, lightDevbarTheme } from '../themes.ts'
import { devbarTokens } from '../tokens.stylex.ts'

const panels: readonly DevbarPanel[] = [
  { id: 'performance', label: 'Performance', badge: 'Live', render: () => <FpsMeter /> },
  { id: 'requests', label: 'Requests', badge: '3', render: () => <p>3 recent requests</p> },
  { id: 'logs', label: 'Logs', render: () => <p>No errors recorded</p> },
]

const styles = stylex.create({
  collection: { display: 'grid', gap: '1rem', padding: '1rem' },
  sample: {
    position: 'relative',
    height: '18rem',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
  },
  label: { margin: '1rem', color: devbarTokens.mutedText },
})

const Sample = ({
  label,
  panel,
  dark,
}: {
  label: string
  panel?: string
  dark: boolean
}): React.ReactNode => (
  <div {...stylex.props(styles.sample, dark === true ? darkDevbarTheme : lightDevbarTheme)}>
    <p {...stylex.props(styles.label)}>{label}</p>
    <Devbar placement="container" panels={panels} deepLinkPanel={panel} persist={false} />
  </div>
)

const meta = {
  component: Devbar,
  title: 'Developer Bar/Devbar',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: { panels, persist: false },
} satisfies Meta<typeof Devbar>

export default meta

type Story = StoryObj<typeof meta>

export const Collapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: /Toggle developer tools/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  },
}

export const OpenByToggle: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: /Toggle developer tools/ }))
    await expect(canvas.getByRole('region', { name: 'Performance' })).toBeVisible()
  },
}

export const Performance: Story = { args: { deepLinkPanel: 'performance' } }
export const Requests: Story = { args: { deepLinkPanel: 'requests' } }
export const Logs: Story = { args: { deepLinkPanel: 'logs' } }

export const AllStates: Story = {
  render: () => (
    <div {...stylex.props(styles.collection)}>
      <Sample label="Collapsed · light" dark={false} />
      <Sample label="Performance · light" panel="performance" dark={false} />
      <Sample label="Requests · light" panel="requests" dark={false} />
      <Sample label="Logs · dark" panel="logs" dark={true} />
      <Sample label="Performance · dark" panel="performance" dark={true} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('region', { name: 'Requests' })).toHaveTextContent(
      '3 recent requests',
    )
    await expect(canvas.getByRole('region', { name: 'Logs' })).toHaveTextContent(
      'No errors recorded',
    )
    await expect(canvas.getAllByRole('region', { name: 'Performance' })).toHaveLength(2)
  },
}
