import type { Meta, StoryObj } from '@storybook/react'
import * as stylex from '@stylexjs/stylex'
import * as React from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'

import { Devbar, type DevbarPanel, type DevbarProps, type DevbarSegment } from '../Devbar.tsx'
import { darkDevbarTheme, lightDevbarTheme } from '../themes.ts'
import { devbarTokens } from '../tokens.stylex.ts'

const styles = stylex.create({
  collection: { display: 'grid', gap: '1rem', padding: '1rem' },
  sample: {
    position: 'relative',
    height: '18rem',
    overflow: 'hidden',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
  },
  narrow: { width: '600px', boxSizing: 'border-box' },
  label: { margin: '1rem', color: devbarTokens.mutedText },
  panelContent: { margin: 0, padding: '1rem' },
  strip: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    width: '36rem',
    height: '24px',
    paddingInline: '0.5rem',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: devbarTokens.border,
    color: devbarTokens.mutedText,
    fontFamily: devbarTokens.fontData,
  },
  segment: { color: devbarTokens.mutedText, whiteSpace: 'nowrap' },
})

const panels: readonly DevbarPanel[] = [
  {
    id: 'requests',
    label: 'Requests',
    badge: '3',
    render: () => <p {...stylex.props(styles.panelContent)}>3 recent requests</p>,
  },
  {
    id: 'logs',
    label: 'Logs',
    render: () => <p {...stylex.props(styles.panelContent)}>No errors recorded</p>,
  },
]

/** Placeholder for a host-owned renderer; real meter strips are composed by the host. */
const placeholderStrip = <span {...stylex.props(styles.strip)}>strip slot</span>

const segments: readonly DevbarSegment[] = [
  {
    id: 'sync',
    render: () => (
      <output aria-label="Sync status" {...stylex.props(styles.segment)}>
        Sync: connected
      </output>
    ),
  },
]

const crowdedSegments: readonly DevbarSegment[] = [
  ...segments,
  {
    id: 'connection',
    render: () => <output {...stylex.props(styles.segment)}>WebSocket: connected</output>,
  },
  {
    id: 'queue',
    render: () => <output {...stylex.props(styles.segment)}>Pending changes: 12</output>,
  },
  {
    id: 'actions',
    render: () => <button type="button">Reconnect host connection</button>,
  },
]

/** Story host owning the controlled selection, as a real host would. */
const ControlledDevbar = ({
  openPanel: initialPanel,
  onOpenPanelChange,
  ...props
}: DevbarProps): React.ReactNode => {
  const [openPanel, setOpenPanel] = React.useState(initialPanel)
  return (
    <Devbar
      {...props}
      openPanel={openPanel}
      onOpenPanelChange={(id) => {
        onOpenPanelChange(id)
        setOpenPanel(id)
      }}
    />
  )
}

const Sample = ({
  label,
  openPanel,
  dark,
  withSlots,
}: {
  label: string
  openPanel: string | undefined
  dark: boolean
  withSlots: boolean
}): React.ReactNode => (
  <div {...stylex.props(styles.sample, dark === true ? darkDevbarTheme : lightDevbarTheme)}>
    <p {...stylex.props(styles.label)}>{label}</p>
    <ControlledDevbar
      placement="container"
      panels={panels}
      strip={withSlots === true ? placeholderStrip : undefined}
      segments={withSlots === true ? segments : undefined}
      openPanel={openPanel}
      onOpenPanelChange={() => {}}
    />
  </div>
)

const meta = {
  component: Devbar,
  title: 'Developer Bar/Devbar',
  parameters: { layout: 'fullscreen', a11y: { test: 'error' } },
  args: { panels, openPanel: undefined, onOpenPanelChange: fn() },
  render: (args) => <ControlledDevbar {...args} />,
} satisfies Meta<typeof Devbar>

export default meta

type Story = StoryObj<typeof meta>

export const Collapsed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: 'Toggle developer tools' })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
  },
}

export const WithStripAndSegments: Story = {
  args: { strip: placeholderStrip, segments },
}

export const Narrow600: Story = {
  args: { strip: placeholderStrip, segments: crowdedSegments },
  render: (args) => (
    <div {...stylex.props(styles.sample, styles.narrow)}>
      <p {...stylex.props(styles.label)}>600px host container · scrollable status segments</p>
      <ControlledDevbar {...args} placement="container" />
    </div>
  ),
  play: async ({ args, canvasElement }) => {
    const row = within(canvasElement).getByRole('group', { name: 'Developer bar' })
    const [controls, strip, hostSegments] = Array.from(row.children)
    const bounds = row.getBoundingClientRect()
    const stripBounds = strip?.getBoundingClientRect()
    const segmentBounds = hostSegments?.getBoundingClientRect()
    await expect(bounds.width).toBe(598)
    await expect(bounds.height).toBe(32)
    await expect(stripBounds?.width).toBeGreaterThanOrEqual(args.stripMinWidth ?? 160)
    await expect(strip?.firstElementChild?.getBoundingClientRect().width).toBe(stripBounds?.width)
    await expect(segmentBounds?.left).toBeGreaterThanOrEqual(bounds.left)
    await expect(segmentBounds?.right).toBeLessThanOrEqual(bounds.right)
    await expect(hostSegments?.scrollWidth).toBeGreaterThan(hostSegments?.clientWidth ?? 0)
    await expect(controls?.getBoundingClientRect().right).toBeLessThanOrEqual(
      stripBounds?.left ?? 0,
    )
    await expect(stripBounds?.right).toBeLessThanOrEqual(segmentBounds?.left ?? 0)
  },
}

export const OpenByToggle: Story = {
  args: { strip: placeholderStrip, segments },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const row = canvas.getByRole('group', { name: 'Developer bar' })
    const before = row.getBoundingClientRect()
    await userEvent.click(canvas.getByRole('button', { name: 'Toggle developer tools' }))
    await expect(args.onOpenPanelChange).toHaveBeenCalledWith('requests')
    await expect(canvas.getByRole('region', { name: 'Requests' })).toBeVisible()
    const after = canvas.getByRole('group', { name: 'Developer bar' }).getBoundingClientRect()
    await expect(after.height).toBe(32)
    await expect(after.top).toBe(before.top)
    await expect(after.bottom).toBe(before.bottom)
  },
}

export const KeyboardShortcut: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.keyboard('{Control>}[Backquote]{/Control}')
    await expect(canvas.getByRole('region', { name: 'Requests' })).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect(canvas.queryByRole('region')).toBeNull()
    await expect(args.onOpenPanelChange).toHaveBeenNthCalledWith(1, 'requests')
    await expect(args.onOpenPanelChange).toHaveBeenNthCalledWith(2, undefined)
  },
}

export const Requests: Story = { args: { openPanel: 'requests' } }
export const Logs: Story = { args: { openPanel: 'logs', strip: placeholderStrip, segments } }
export const EmptyComposition: Story = { args: { panels: [] } }

export const AllStates: Story = {
  render: () => (
    <div {...stylex.props(styles.collection)}>
      <Sample label="Collapsed · light" openPanel={undefined} dark={false} withSlots={false} />
      <Sample label="Slots · light" openPanel={undefined} dark={false} withSlots={true} />
      <Sample label="Requests · light" openPanel="requests" dark={false} withSlots={true} />
      <Sample label="Logs · dark" openPanel="logs" dark={true} withSlots={true} />
      <Sample label="Collapsed · dark" openPanel={undefined} dark={true} withSlots={false} />
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
    await expect(canvas.getAllByRole('group', { name: 'Developer bar' })).toHaveLength(5)
  },
}
